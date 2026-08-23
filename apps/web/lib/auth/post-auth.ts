/**
 * Single client-side new-vs-returning decision used by /login and both signup
 * wizards, so every entry point routes consistently — by PROFILE EXISTENCE, not
 * by which button was clicked. Mirrors the server OAuth callback.
 */
export interface PostAuthRoute {
  /** No profile row yet → the caller should run the signup wizard once. */
  isNew: boolean
  /** Where a returning user goes (role home). */
  destination: string
}

export async function resolvePostAuthRoute(): Promise<PostAuthRoute> {
  const res = await fetch('/api/v1/profile/me', { cache: 'no-store' })
  const d = await res.json().catch(() => ({}))
  if (d.role === 'admin' || d.role === 'ops') return { isNew: false, destination: '/admin/verifications' }
  // Active providers → /partner; a buyer whose provider application is still
  // pending/under_review keeps landing on their buyer home.
  if (d.hasProviderProfile && (d.providerStatus === 'active' || !d.hasMsmeProfile)) {
    return { isNew: false, destination: '/partner' }
  }
  if (d.hasMsmeProfile) return { isNew: false, destination: '/app' }
  if (d.hasProviderProfile) return { isNew: false, destination: '/partner' }
  return { isNew: true, destination: '/app' }
}
