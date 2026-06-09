// sw.js — UNEZ Calendario Service Worker
const CACHE_NAME = 'unez-cal-v1';
const ASSETS = ['./index.html', './manifest.json'];

// ── INSTALL: cache app shell ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// ── ACTIVATE: clear old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
  // Start daily check when SW activates
  scheduleDailyCheck();
});

// ── FETCH: serve from cache, fallback to network ──
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// ── MESSAGE: receive events from app ──
let storedEvents = [];

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SCHEDULE_NOTIFS') {
    storedEvents = event.data.events || [];
    const today = event.data.today;
    // Check immediately on login
    checkAndNotify(today);
  }
});

// ── NOTIFICATION CLICK ──
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      if (clientList.length > 0) {
        return clientList[0].focus();
      }
      return clients.openWindow('./index.html');
    })
  );
});

// ── PERIODIC BACKGROUND SYNC (if supported) ──
self.addEventListener('periodicsync', event => {
  if (event.tag === 'unez-daily-check') {
    event.waitUntil(checkAndNotify(todayStr()));
  }
});

// ── HELPERS ──
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function fmtDisplay(str) {
  const [y, m, d] = str.split('-');
  const months = ['enero','febrero','marzo','abril','mayo','junio',
    'julio','agosto','septiembre','octubre','noviembre','diciembre'];
  return `${parseInt(d)} de ${months[parseInt(m) - 1]}`;
}

const CAT_ICONS = {
  examen: '📝', pago: '💳', conferencia: '🎤',
  evento: '🏫', cumpleanos: '🎂', falta: '🚫'
};

const CAT_LABELS = {
  examen: 'Examen', pago: 'Pago', conferencia: 'Conferencia',
  evento: 'Evento', cumpleanos: 'Cumpleaños', falta: 'Falta colectiva'
};

// Notify for events happening TODAY, TOMORROW, or in 2 DAYS
async function checkAndNotify(today) {
  if (!today) today = todayStr();

  // Load events from IndexedDB if storedEvents is empty (SW restarted)
  let eventsToCheck = storedEvents.length > 0 ? storedEvents : await loadEventsFromDB();

  const targets = [
    { offset: 0, label: '¡Hoy!' },
    { offset: 1, label: 'Mañana' },
    { offset: 2, label: 'En 2 días' },
  ];

  for (const { offset, label } of targets) {
    const targetDate = addDays(today, offset);
    const dayEvents = eventsToCheck.filter(e => e.date === targetDate);

    for (const ev of dayEvents) {
      const icon = CAT_ICONS[ev.cat] || '📅';
      const catLabel = CAT_LABELS[ev.cat] || '';
      const title = offset === 0
        ? `${icon} ${label} — ${ev.title}`
        : `${icon} ${label} — ${ev.title}`;
      const body = offset === 0
        ? `Hoy es: ${fmtDisplay(ev.date)}${ev.note ? ' · ' + ev.note : ''}`
        : `El ${fmtDisplay(ev.date)}${ev.note ? ' · ' + ev.note : ''}`;

      // Avoid duplicate notifications (check if already shown today)
      const notifKey = `notif-${ev.id}-${today}-${offset}`;
      const alreadyShown = await getShownFlag(notifKey);
      if (alreadyShown) continue;

      await self.registration.showNotification(title, {
        body,
        icon: 'https://unez.edu.mx/wp-content/uploads/2023/07/logo-png.png',
        badge: 'https://unez.edu.mx/wp-content/uploads/2023/07/logo-png.png',
        tag: notifKey,
        vibrate: [200, 100, 200],
        data: { date: ev.date, cat: ev.cat },
        actions: [
          { action: 'open', title: 'Ver calendario' },
          { action: 'dismiss', title: 'Cerrar' }
        ]
      });

      await setShownFlag(notifKey);
    }
  }
}

// ── IndexedDB for persistent event storage & shown flags ──
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('unez-cal-db', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('events')) {
        db.createObjectStore('events', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('flags')) {
        db.createObjectStore('flags', { keyPath: 'key' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function loadEventsFromDB() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('events', 'readonly');
      const req = tx.objectStore('events').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch { return []; }
}

async function saveEventsToDB(events) {
  try {
    const db = await openDB();
    const tx = db.transaction('events', 'readwrite');
    const store = tx.objectStore('events');
    store.clear();
    events.forEach(e => store.put(e));
  } catch(e) { console.log('DB save error', e); }
}

async function getShownFlag(key) {
  try {
    const db = await openDB();
    return new Promise(resolve => {
      const req = db.transaction('flags', 'readonly').objectStore('flags').get(key);
      req.onsuccess = () => resolve(!!req.result);
      req.onerror = () => resolve(false);
    });
  } catch { return false; }
}

async function setShownFlag(key) {
  try {
    const db = await openDB();
    const tx = db.transaction('flags', 'readwrite');
    tx.objectStore('flags').put({ key, shown: true, date: todayStr() });
  } catch(e) { console.log('Flag error', e); }
}

// ── Daily check via setTimeout loop (fallback for periodic sync) ──
function scheduleDailyCheck() {
  // Check every 6 hours
  setInterval(async () => {
    await checkAndNotify(todayStr());
  }, 6 * 60 * 60 * 1000);

  // Also check once after 5 seconds of SW start
  setTimeout(async () => {
    await checkAndNotify(todayStr());
  }, 5000);
}
