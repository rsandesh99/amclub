/**
 * AMClub service worker — Phase 8 §5, narrowed by the P0-6 fix
 * (docs/USER_EXPECTATIONS_AUDIT.md). Conservative by design:
 *
 *  - GET-only. Mutations (POST/PUT/PATCH/DELETE) are NEVER intercepted or
 *    cached — payments/webhook truth (§2.5) stays untouched.
 *  - NOTHING user-specific is cached. Navigations are network-only with the
 *    offline shell as the fallback; every /api/ path is network-only. (v1
 *    cached every navigation plus /api/v1/orders* and /api/v1/notifications*,
 *    so the next person on a shared device could read the previous user's
 *    orders offline after sign-out.)
 *  - Cached: the offline shell + icons (precache) and hashed static assets
 *    (/_next/static, icons, fonts, images) — identical for every user.
 *  - Sign-out posts { type: 'amclub:purge-caches' } (lib/pwa/purge-caches.ts):
 *    every cache is dropped, then the offline shell is re-precached.
 *
 * Bump VERSION to invalidate all caches on deploy of SW changes; activate
 * deletes every cache that is not the current VERSION (v1 included).
 */
const VERSION = 'amclub-sw-v2'
const OFFLINE_URL = '/offline.html'
const PURGE_MESSAGE = 'amclub:purge-caches'

const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png', '/icons/icon-512.png']

function precache() {
  return caches.open(VERSION).then((cache) => cache.addAll(PRECACHE))
}

function deleteAllCaches() {
  return caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== PURGE_MESSAGE) return
  // Only a same-origin window can reach this SW, but check anyway.
  if (event.origin && event.origin !== self.location.origin) return
  event.waitUntil(deleteAllCaches().then(precache).catch(() => {}))
})

function cacheable(response) {
  return response && response.ok && (response.type === 'basic' || response.type === 'default')
}

async function networkWithOfflineShell(request) {
  try {
    return await fetch(request)
  } catch (err) {
    const shell = await caches.match(OFFLINE_URL)
    if (shell) return shell
    throw err
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION)
  const cached = await cache.match(request)
  if (cached) return cached
  const fresh = await fetch(request)
  if (cacheable(fresh)) cache.put(request, fresh.clone())
  return fresh
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return // never touch mutations

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return // no third-party caching

  // Pages may carry the signed-in user's data: never cached, only the shell offline.
  if (request.mode === 'navigate') {
    event.respondWith(networkWithOfflineShell(request))
    return
  }

  // API and data requests: network only — no SW involvement, never cached.
  if (url.pathname.startsWith('/api/')) return

  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    /\.(?:png|jpg|jpeg|svg|webp|woff2?)$/.test(url.pathname)
  ) {
    event.respondWith(cacheFirst(request))
  }

  // Everything else (RSC payloads, /_next/image, …): network only.
})
