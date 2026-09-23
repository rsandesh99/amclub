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
  /** P0-8 — the buyer profile exists but ops suspended it (hasMsmeProfile is then false). Optional for older servers. */
  msmeSuspended?: boolean
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
  /** S1.1 — quote extraction for THIS user (AGENT_ENABLED + agents_enabled.quote_extract + cohort). */
  quoteExtractEnabled: boolean
  /** S1.2 — compare pointers for THIS buyer (AGENT_ENABLED + agents_enabled.compare_pointers + cohort). Flags render regardless. */
  comparePointersEnabled: boolean
  /** S1.6 — the "Finish on WhatsApp" card in the provider wizard (AGENT_ENABLED + agents_enabled.onboarding + cohort). */
  onboardingWhatsAppEnabled: boolean
  /** S2.2 — the Munshi partner tab for this provider (AGENT_ENABLED + agents_enabled.munshi + cohort). */
  munshiEnabled: boolean
  /** S2.3 — the Support chat (Help) for this user (AGENT_ENABLED + agents_enabled.support + cohort). */
  supportEnabled: boolean
  /** S3.1 — the procurement assistant (buyers only; flag + agents_enabled.procurement + cohort). Mobile shows the Assistant tab from it. */
  procurementEnabled?: boolean
  /** Experience v3 E9 — the buyer home v3 for THIS user (flag `home`): "Needs your action" + "Buy again". */
  homeV3Enabled?: boolean
  /** PRD Experience v3 E7 — `compare` is on for this user (the mobile compare cards carry the web's groups). */
  compareV3Enabled?: boolean
  /**
   * S2.4 — the caller's OWN provider listing facts, for Munshi's weekly growth nudge (read under the provider's
   * delegated token, so the runtime never reads provider_profiles with the service role). null for non-providers.
   */
  providerProfileGaps?: string[] | null
  providerState?: string | null
  providerCategorySlugs?: string[] | null
}
