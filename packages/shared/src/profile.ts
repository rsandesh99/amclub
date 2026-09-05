/**
 * S2.3 — the /api/v1/profile/me response contract, shared by web and mobile.
 * Minimal by founder decision: exactly the fields the route returns today,
 * plus `martEnabled` (the server-authoritative AMC Mart flag delivery for
 * clients — EXPO_PUBLIC_ vars are baked at build time and cannot dark-toggle
 * a shipped APK).
 */
export interface ProfileMeResponse {
  authenticated: boolean
  id: string
  fullName: string | null
  /** Primary role for routing: admin > provider > msme. */
  role: 'admin' | 'provider' | 'msme'
  roles: string[]
  hasMsmeProfile: boolean
  hasProviderProfile: boolean
  /** provider_profiles.status, or null when no provider profile exists. */
  providerStatus: string | null
  /**
   * Payout readiness per the SINGLE definition in
   * apps/web/lib/payments/readiness.ts (RULES.md rule 9) — typed as string
   * here deliberately so the enum is never forked into a second source.
   */
  payoutReadiness: string | null
  /** AMC Mart feature flag (server-evaluated MART_ENABLED; default false). */
  martEnabled: boolean
}
