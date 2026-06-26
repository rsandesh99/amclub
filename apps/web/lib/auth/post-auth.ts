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
  const res = await fetch('/api/v1/profile/me')
  const d = await res.json().catch(() => ({}))
  if (d.role === 'admin' || d.role === 'ops') return { isNew: false, destination: '/admin/verifications' }
  if (d.hasProviderProfile) return { isNew: false, destination: '/partner' }
  if (d.hasMsmeProfile) return { isNew: false, destination: '/app' }
  return { isNew: true, destination: '/app' }
}
