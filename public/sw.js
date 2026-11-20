'use strict';
// OnlyClick — service worker: es lo que hace que el navegador ofrezca
// "Instalar app" y que la app abra a pantalla completa con su ícono.
//
// Solo guarda la cáscara de la app (página, código, manifiesto,
// íconos). Las fotos y las llamadas a /api/* NUNCA se guardan: siempre
// van a la red, así que un pago, una subida o una búsqueda jamás salen
// de un caché viejo. La cáscara se pide a la red primero y solo si no
// hay conexión se usa la copia guardada, así cada despliegue llega
// solo; los íconos sí se guardan directo porque no cambian.
const CACHE = 'onlyclick-shell-v1';
const SHELL_CACHE_FIRST = ['/manifest.json', '/icon-192.png', '/icon-512.png', '/favicon.png', '/apple-touch-icon.png'];
const SHELL_NETWORK_FIRST = ['/', '/index.html', '/app.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL_CACHE_FIRST.concat(SHELL_NETWORK_FIRST)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Todo lo de la API y todo lo de otro origen (fotos de Supabase):
  // siempre a la red, nunca al caché.
  if (url.pathname.startsWith('/api/')) return;
  if (url.origin !== self.location.origin) return;

  if (SHELL_CACHE_FIRST.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((hit) => hit || fetch(event.request))
    );
    return;
  }
  if (SHELL_NETWORK_FIRST.includes(url.pathname)) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
