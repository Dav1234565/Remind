self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try {
      payload = event.data ? event.data.json() : {};
    } catch (error) {
      console.error('Push notification payload is invalid:', error);
    }

    await self.registration.showNotification(payload.title || '⏰ Remind - עדכון שעתי', {
      body: payload.body || 'הגיע הזמן לעצור לרגע ולהמשיך בדרך שלך.',
      icon: payload.icon || './assets/remind-logo.png',
      badge: payload.badge || './assets/remind-icon-192.png',
      tag: payload.tag || 'remind-hourly-motivation',
      renotify: true,
      data: { url: payload.url || './' }
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const targetUrl = new URL(event.notification.data?.url || './', self.location.origin).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existingWindow = windows.find((client) => client.url.startsWith(self.location.origin));
    if (existingWindow) {
      await existingWindow.focus();
      return;
    }
    await self.clients.openWindow(targetUrl);
  })());
});
