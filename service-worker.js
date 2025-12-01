// service-worker.js
// Obtiene versión desde el propio script URL (?v=...)
const SW_VERSION = (()=>{
  try { return new URL(self.location.href).searchParams.get('v') || 'v1'; }
  catch { return 'v1'; }
})();

const CACHE_NAME = `byc-cache-${SW_VERSION}`;
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './offline.html',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Opcional pero recomendado: habilitar navigation preload (mejora tiempos)
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Limpia caches viejas
    const names = await caches.keys();
    await Promise.all(names.map(n => (n.startsWith('byc-cache-') && n !== CACHE_NAME) ? caches.delete(n) : null));
    // Intentar habilitar preload
    if ('navigationPreload' in self.registration) {
      try { await self.registration.navigationPreload.enable(); } catch {}
    }
    self.clients.claim();
  })());
});

// Precache en install
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_URLS);
    self.skipWaiting();
  })());
});

// Mensaje desde la página para activar al toque
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Helper
const isGoogleAppsScript = url =>
  url.hostname === 'script.google.com' && url.pathname.includes('/macros/');

// Fetch handler
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Navegaciones (tocar la barra o abrir desde ícono): servir index.html
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload) return preload;

        const net = await fetch(req);
        // cacheamos última versión de index para usarla offline
        const cache = await caches.open(CACHE_NAME);
        cache.put('./index.html', net.clone());
        return net;
      } catch {
        // sin red → devolvemos shell del cache
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match('./index.html') || await cache.match('./offline.html');
        return cached || new Response('Sin conexión y sin cache', { status: 503 });
      }
    })());
    return;
  }

  // Misma-origen (íconos, manifest, etc.): Cache-first con revalidación
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      const fetchAndUpdate = fetch(req).then(res => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(()=> null);
      return cached || fetchAndUpdate || new Response('Offline', { status: 503 });
    })());
    return;
  }

  // Llamadas a Google Apps Script:
  // - GET: Network-first (si falla, intento cache previo si lo hubiera)
  // - POST: lo dejo pasar (tu front ya guarda "pendientes" cuando no hay red)
  if (isGoogleAppsScript(url)) {
    if (req.method === 'GET') {
      event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
          const net = await fetch(req, { cache: 'no-store' });
          if (net && net.ok) cache.put(req, net.clone());
          return net;
        } catch {
          const cached = await cache.match(req);
          return cached || new Response(JSON.stringify({ ok:false, error:'Sin internet (cache vacío)' }), {
            headers: { 'Content-Type': 'application/json' }, status: 200
          });
        }
      })());
      return;
    }
    // POST → no interceptar (el front se encarga de pendientes)
    return;
  }

  // Otros orígenes (si los hubiera): Network-first con fallback cache
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const net = await fetch(req);
      if (net && net.ok) cache.put(req, net.clone());
      return net;
    } catch {
      const cached = await cache.match(req);
      return cached || new Response('Offline', { status: 503 });
    }
  })());
});
