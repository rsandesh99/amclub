/**
 * P0-6 (docs/USER_EXPECTATIONS_AUDIT.md): sign-out on a shared device must
 * leave nothing of the previous user in Cache Storage. The service worker
 * (public/sw.js) no longer caches pages or API data, but this drops whatever
 * an older worker cached before this one took over.
 *
 * It works in two steps, and neither one throws:
 *  1. the page deletes every cache itself (this works even when no worker
 *     controls the page);
 *  2. then it tells the active worker to purge as well; the worker re-caches
 *     the offline shell afterwards. The page deletes first so it cannot
 *     remove the shell the worker has just re-cached.
 */
export const SW_PURGE_MESSAGE = 'amclub:purge-caches'

export async function purgeClientCaches(): Promise<void> {
  if (typeof window === 'undefined') return
  try {
    if ('caches' in window) {
      const keys = await window.caches.keys()
      await Promise.all(keys.map((k) => window.caches.delete(k)))
    }
  } catch {
    /* Cache Storage unavailable (private mode, old browser) — nothing to purge */
  }
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration()
      const worker = navigator.serviceWorker.controller ?? reg?.active ?? null
      worker?.postMessage({ type: SW_PURGE_MESSAGE })
    }
  } catch {
    /* no worker — the page-side purge above already ran */
  }
}
