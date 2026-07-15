// BrailleGen service worker — cache-first offline support.
//
// Strategy: the small app shell + core engine precache at install; heavy or
// on-demand assets (braille tables, the STL engine) are cached the first time
// they are fetched. Bump VERSION on every deploy — the new worker takes over
// immediately (skipWaiting), old caches are deleted on activate, and the page
// reloads itself once so visitors always see the current deploy.
//
// AGPL-3.0 — part of the BrailleGen fork.

const VERSION = 'bg-v2.0.5';
const SHELL = [
  './',
  './index.html',
  './docs.html',
  './manifest.webmanifest',
  './assets/icon.svg',
  './app/app.css',
  './app/app.mjs',
  './app/engine.mjs',
  './app/braille-svg.mjs',
  './app/braille-brf.mjs',
  './app/tables.mjs',
  './app/presets.mjs',
  './engine/core.js',
  './engine/core.wasm',
  './engine/tables-manifest.json',
  './assets/fonts/atkinson-400-latin.woff2',
  './assets/fonts/atkinson-400-latin-ext.woff2',
  './assets/fonts/atkinson-700-latin.woff2',
  './assets/fonts/atkinson-700-latin-ext.woff2',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' bypasses the HTTP cache so a new SW can never precache a
  // STALE shell file next to new engine bytes (mixed-version pinning).
  event.waitUntil(caches.open(VERSION).then(
    (c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))
  ));
  // Take over from the previous version as soon as this one is ready; the
  // page reloads itself once on controllerchange so users always see the
  // current deploy instead of lingering on a stale cached build.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== VERSION) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(event.request, { ignoreSearch: false });
    if (hit) return hit;
    try {
      // no-cache: revalidate against the server so a fresh deploy's bytes are
      // what gets pinned, never the browser HTTP cache's stale copy.
      const res = await fetch(event.request, { cache: 'no-cache' });
      // Runtime-cache successful same-origin responses (tables, stl engine).
      // status 200 only (a 206 partial would throw inside cache.put).
      if (res.ok && res.status === 200 && res.type === 'basic') {
        event.waitUntil(cache.put(event.request, res.clone()).catch(() => {}));
      }
      return res;
    } catch (err) {
      // Offline and not cached: fall back to the shell for navigations.
      if (event.request.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
