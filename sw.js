self.addEventListener('push', (e) => {
  let data = null;
  try { data = e.data ? e.data.json() : null; } catch(_) {}
  const title = (data && data.title) || 'Monitor Pesanan';
  const body  = (data && data.body)  || 'Ada update pesanan. Buka monitor.';
  e.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/badge.png'
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/'));
});
