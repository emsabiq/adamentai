// Optional: update SW lebih cepat
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = null;
  try { data = e.data ? e.data.json() : null; } catch (_) {}
  const title = (data && data.title) || 'Monitor Pesanan';
  const body  = (data && data.body)  || 'Ada update pesanan. Buka monitor.';
  e.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',   // opsional; biarkan saja walau tidak ada
    badge: '/badge.png'      // opsional
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  // Fokuskan tab yang sudah terbuka kalau ada, kalau tidak buka yang baru
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      // Arahkan ke halaman monitor. Jika monitor kamu di root/ganti nama, sesuaikan path di sini.
      return clients.openWindow('/monitor.html');
    })
  );
});
