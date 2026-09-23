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
