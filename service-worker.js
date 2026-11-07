/*
 * Our Universe service worker (v40).
 * Network first for the app's own files, so a new release shows up on the
 * next launch; the cached copy is used only when offline. Supabase, fonts and
 * the CDN script are cross-origin and are never intercepted or cached here,
 * so no personal data is stored by this worker.
 */
const CACHE = 'our-universe-v40';
const SHELL = [
  './',
  './index.html',
  './style.css?v=40',
  './app.js?v=40',
  './togetherverse.js?v=40',
  './content/quest_library.json',
  './config.js?v=40',
  './manifest.webmanifest?v=40',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined))),
  );
});
