/* Service worker: caches ONLY public static assets (icons + manifest) so the
   portal is installable. Never caches authed pages, API responses, or video. */

/* Cache name bumped to v2 when the manifest moved to a network-first strategy;
   the activate handler below deletes every cache that isn't the current one, so
   the bump is what evicts manifests stored under the old cache-first rule. */
const CACHE = 'pvp-static-v2';

/* Icons are immutable for a given deploy — cache-first is right for them. */
const PRECACHE_ASSETS = ['/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

/* The manifest is generated and carries the admin-set site name, which can
   change at any time with NO redeploy. Cache-first would pin an installed app
   to whatever the name was when it was installed — the rename would never
   arrive. Network-first keeps renames flowing while still working offline from
   the last copy we saw. */
const NETWORK_FIRST_ASSETS = ['/manifest.webmanifest'];

const ASSETS = [...NETWORK_FIRST_ASSETS, ...PRECACHE_ASSETS];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (NETWORK_FIRST_ASSETS.includes(url.pathname)) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          /* Refresh the stored copy so the offline fallback follows renames
             too, rather than serving the install-time name forever. */
          const copy = res.clone();
          caches
            .open(CACHE)
            .then((cache) => cache.put(event.request, copy))
            .catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(event.request).then((hit) => hit || Response.error())
        )
    );
    return;
  }

  if (PRECACHE_ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request)));
  }
  /* Everything else goes straight to the network. */
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'New notification', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const win of wins) {
        if ('focus' in win) {
          win.navigate(url);
          return win.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
