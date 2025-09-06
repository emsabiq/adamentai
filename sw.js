// /sw.js (root scope)
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Global throttle supaya kalau push beruntun, tidak spam
let lastShownAt = 0;

self.addEventListener('push', (e) => {
  // Cek apakah ada client visible; kalau ada, cukup kirim message (tanpa OS notif)
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hasVisible = all.some(c => c.visibilityState === 'visible');
    if (hasVisible) {
      all.forEach(c => c.postMessage({ type: 'ORDER_PING' }));
      return; // jangan tampilkan OS notification
    }

    // Optional payload
    let data = null;
    try { data = e.data ? e.data.json() : null; } catch(_) {}
    const title = (data && data.title) || 'Monitor Pesanan';
    const body  = (data && data.body)  || 'Ada update pesanan.';
    const url   = (data && data.url)   || '/monitor.html';

    // Throttle 3 detik agar tidak spam jika beberapa push datang beruntun
    const now = Date.now();
    if (now - lastShownAt < 3000) return;
    lastShownAt = now;

    // tag memastikan notifikasi baru replace yang lama (anti numpuk)
    await self.registration.showNotification(title, {
      body,
      tag: 'order-ping',
      renotify: false, // tidak bunyi ulang saat replace
      badge: '/badge.png', // opsional, kalau ada
      icon: '/icon-192.png' // opsional, kalau ada
    });

    // Simpan target URL ke data notif (opsional)
    self._lastTarget = url;
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = self._lastTarget || '/monitor.html';
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      try { await c.focus(); await c.navigate(target); return; } catch {}
    }
    if (clients.openWindow) await clients.openWindow(target);
  })());
});
