/**
 * Client-safe feature flags (inlined at build time, so they may be read in
 * client components). Server-only switches live in `lib/flags.ts`.
 *
 * MEMBER_PRICING_ENABLED — E0 / U2 (PRD Experience v3). Packages carry a
 * `member_extra_discount_bps`, but memberships don't exist and checkout never
 * applies that discount, so a "₹X for members" line was a price no buyer could
 * pay. Default OFF: every member-price line and the provider's member field are
 * hidden. The column stays untouched for when memberships ship.
 */
export const MEMBER_PRICING_ENABLED = process.env['NEXT_PUBLIC_MEMBER_PRICING_ENABLED'] === 'true'

/**
 * ANALYTICS_CONSENT_REQUIRED — E17 (N36), gated on counsel's D-UX2 answer
 * (does first-party pseudonymous product analytics need consent under the
 * DPDP Act?). Default OFF = today: PostHog loads after idle. ON: PostHog does
 * not load until the person accepts the one-line notice (equal Accept /
 * Decline); declining sends no analytics events. Build-time, like the notice
 * itself, so the first paint already knows.
 */
export const ANALYTICS_CONSENT_REQUIRED = process.env['NEXT_PUBLIC_ANALYTICS_CONSENT_REQUIRED'] === 'true'

/**
 * WHATSAPP_MARKETING_ENABLED — PRD_WHATSAPP D-WA3 (built dark). The "Offers"
 * WhatsApp toggle in settings renders only when this is on, or when the person
 * already opted in to marketing (so they can always opt out). Default OFF.
 */
export const WHATSAPP_MARKETING_ENABLED = process.env['NEXT_PUBLIC_WHATSAPP_MARKETING_ENABLED'] === 'true'
