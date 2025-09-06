// Service Worker – root scope
self.addEventListener('install', (e) => {
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

// Terima payload push (JSON) dan tampilkan notif
self.addEventListener('push', (e) => {
  let data = null;
  try { data = e.data ? e.data.json() : null; } catch(_) {}
  const title = (data && data.title) || 'Monitor Pesanan';
  const body  = (data && data.body)  || 'Ada update pesanan. Buka monitor.';
  const url   = (data && data.url)   || '/monitor.html';

  e.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/badge.png'
  }));
  // bisa simpan URL target di notif.data bila perlu
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = '/monitor.html';
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { c.focus(); c.navigate(target); return; }
    }
    if (clients.openWindow) await clients.openWindow(target);
  })());
});
