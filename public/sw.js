const SCOPE = new URL(self.registration.scope);
const PREFIX = `shengzhang-shell:${SCOPE.pathname}:`;
const CACHE = `${PREFIX}v3`;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  const path = url.pathname.slice(SCOPE.pathname.length);
  if (path === 'api' || path.startsWith('api/') || path.startsWith('downloads/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    } catch {
      return await cache.match(event.request) || (event.request.mode === 'navigate' && (await cache.match(SCOPE.href) || await cache.match(new URL('index.html', SCOPE).href))) || new Response('连接中断，请联网后重试。', { status: 503 });
    }
  })());
});
