// /sw.js (root scope)
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Global throttle supaya kalau push beruntun, tidak spam
let lastShownAt = 0;

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    // 1) Cek client yang sedang terlihat
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hasVisible = all.some((c) => c.visibilityState === 'visible');

    // Ambil payload (jika ada). Worker mengirim "ping tanpa payload", jadi ini opsional.
    let data = null;
    try { data = e.data ? e.data.json() : null; } catch (_) { data = null; }

    // Normalisasi field payload
    const title = (data && data.title) || 'Monitor Pesanan';
    const body  = (data && data.body)  || 'Ada update pesanan.';
    const url   = (data && data.url)   || '/monitor.html';
    const hint  = (data && data.hint)  || ''; // contoh: 'settle'

    if (hasVisible) {
      // 2) Jika ada tab terlihat → kirim message ke halaman (tanpa OS notification)
      for (const c of all) {
        c.postMessage({ type: 'push-ping', at: Date.now(), hint }); // versi baru (dipakai monitor.html)
        c.postMessage({ type: 'ORDER_PING', at: Date.now(), hint }); // kompat lama
      }
      return;
    }

    // 3) Jika tidak ada tab terlihat → tampilkan OS notification (anti-spam 3 detik)
    const now = Date.now();
    if (now - lastShownAt < 3000) return;
    lastShownAt = now;

    await self.registration.showNotification(
      hint === 'settle' ? 'Pembayaran berhasil' : title,
      {
        body,
        tag: 'order-ping',           // replace notifikasi lama (tidak numpuk)
        renotify: false,             // tidak bunyi ulang saat replace
        badge: '/badge.png',         // opsional
        icon: '/icon-192.png',       // opsional
        data: { url, ts: now, hint } // simpan target untuk click handler
      }
    );
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification && e.notification.data && e.notification.data.url) || '/monitor.html';

  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });

    // Fokuskan tab yang sudah ada, lalu arahkan ke target
    for (const c of all) {
      try {
        await c.focus();
        // navigate bisa gagal di sebagian browser jika origin berbeda; abaikan errornya
        await c.navigate(target);
        return;
      } catch {}
    }

    // Jika belum ada tab, buka baru
    if (clients.openWindow) {
      await clients.openWindow(target);
    }
  })());
});
