/**
 * Sign-out hygiene for shared devices (USER_EXPECTATIONS_AUDIT P0-6): delete
 * every Cache Storage entry this origin holds and ask the service worker to do
 * the same (it re-precaches only the user-independent offline shell).
 *
 * Never throws and never blocks sign-out for long — browsers without Cache
 * Storage / service workers (old WebViews, some private modes) simply skip it.
 */
const PURGE_MESSAGE = { type: 'amclub:purge-caches' } as const
const PURGE_TIMEOUT_MS = 1500

async function purge(): Promise<void> {
  if (typeof window === 'undefined') return
  try {
    if ('caches' in window) {
      const keys = await window.caches.keys()
      await Promise.all(keys.map((k) => window.caches.delete(k)))
    }
  } catch {
    /* Cache Storage unavailable — nothing cached to leak */
  }
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration()
      const targets = [navigator.serviceWorker.controller, reg?.active, reg?.waiting, reg?.installing]
      for (const sw of new Set(targets)) sw?.postMessage(PURGE_MESSAGE)
    }
  } catch {
    /* no service worker — nothing else to purge */
  }
}

export async function purgeOfflineCaches(): Promise<void> {
  await Promise.race([purge(), new Promise<void>((resolve) => setTimeout(resolve, PURGE_TIMEOUT_MS))])
}
