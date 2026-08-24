/* Cachea la app para que abra sin conexión.
   Subí la versión cada vez que cambies algo: fuerza la actualización en el celular. */
const V = 'guardia-v3';
const SHELL = ['./', './index.html', './app.js', './firebase-config.js', './manifest.json', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Firestore y auth siempre van a la red: el SDK maneja su propia caché offline
  if (u.hostname.includes('googleapis.com') || u.hostname.includes('firebaseio')) return;
  if (u.origin === location.origin) {
    // la app: red primero, caché si no hay conexión
    e.respondWith(fetch(e.request)
      .then(r => { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request)));
  } else {
    // fuentes y librerías: caché primero
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)
      .then(res => { const c = res.clone(); caches.open(V).then(x => x.put(e.request, c)); return res; })));
  }
});
