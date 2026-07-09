/**
 * AMClub service worker — Phase 8 §5. Conservative by design:
 *
 *  - GET-only. Mutations (POST/PUT/PATCH/DELETE) are NEVER intercepted or
 *    cached — payments/webhook truth (§2.5) stays untouched.
 *  - Navigations: network-first; last-seen copy from cache when offline
 *    (this is what makes the orders list readable offline, read-only, §3.8);
 *    offline shell as the final fallback.
 *  - Hashed static assets (/_next/static, icons, fonts, images): cache-first.
 *  - GET /api/v1/orders* and /api/v1/notifications*: network-first with
 *    cache fallback (read-only data). Every other API path: network only.
 *
 * Bump VERSION to invalidate all caches on deploy of SW changes.
 */
const VERSION = 'amclub-sw-v1'
const OFFLINE_URL = '/offline.html'

const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

function cacheable(response) {
  return response && response.ok && (response.type === 'basic' || response.type === 'default')
}

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(VERSION)
  try {
    const fresh = await fetch(request)
    if (cacheable(fresh)) cache.put(request, fresh.clone())
    return fresh
  } catch (err) {
    const cached = await cache.match(request)
    if (cached) return cached
    if (fallbackUrl) {
      const shell = await cache.match(fallbackUrl)
      if (shell) return shell
    }
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
    event.respondWith(networkFirst(request, OFFLINE_URL))
    return
  }

  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    /\.(?:png|jpg|jpeg|svg|webp|woff2?)$/.test(url.pathname)
  ) {
    event.respondWith(cacheFirst(request))
    return
  }

  // Read-only order/notification data may serve stale when offline (§3.8).
  if (url.pathname.startsWith('/api/v1/orders') || url.pathname.startsWith('/api/v1/notifications')) {
    event.respondWith(networkFirst(request))
    return
  }

  // All other API/data requests: network only — no SW involvement.
})
