/**
 * AMClub service worker — Phase 8 §5. Conservative by design:
 *
 *  - GET-only. Mutations (POST/PUT/PATCH/DELETE) are NEVER intercepted or
 *    cached — payments/webhook truth (§2.5) stays untouched.
 *  - Navigations: NETWORK-ONLY. Pages are never written to the cache — they
 *    are rendered per session (orders, profiles, KYC), and a cached copy would
 *    be readable by the next person on a shared device (USER_EXPECTATIONS_AUDIT
 *    P0-6). When the network is down the precached offline shell is served.
 *  - Hashed static assets (/_next/static, icons, fonts, images): cache-first.
 *    These are identical for every user and carry no session data.
 *  - API requests (/api/*): never touched by the SW — no user data in caches.
 *  - Sign-out posts { type: 'amclub:purge-caches' }: every cache is deleted and
 *    only the user-independent offline shell + icons are re-precached.
 *
 * Bump VERSION to invalidate all caches on deploy of SW changes. v2 retires
 * the v1 caches, which held authenticated pages and order/notification JSON.
 */
const VERSION = 'amclub-sw-v2'
const OFFLINE_URL = '/offline.html'

const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png', '/icons/icon-512.png']

function precache() {
  return caches.open(VERSION).then((cache) => cache.addAll(PRECACHE))
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

// Sign-out on a shared device: drop everything, then restore only the
// user-independent offline shell so the next visitor still gets it.
self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'amclub:purge-caches') return
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => precache())
      .catch(() => {}),
  )
})

function cacheable(response) {
  return response && response.ok && (response.type === 'basic' || response.type === 'default')
}

async function networkOnlyWithOfflineShell(request) {
  try {
    return await fetch(request)
  } catch (err) {
    const cache = await caches.open(VERSION)
    const shell = await cache.match(OFFLINE_URL)
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

  if (request.mode === 'navigate') {
    event.respondWith(networkOnlyWithOfflineShell(request))
    return
  }

  if (url.pathname.startsWith('/api/')) return // API: network only, never cached

  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    /\.(?:png|jpg|jpeg|svg|webp|woff2?)$/.test(url.pathname)
  ) {
    event.respondWith(cacheFirst(request))
    return
  }

  // Everything else (RSC payloads, data requests): network only.
})
