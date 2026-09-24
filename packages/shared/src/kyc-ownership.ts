import { z } from 'zod'

/**
 * Audit M12 / ADR 028 — a KYC vendor answer proves a number EXISTS; this file
 * decides whether it belongs to the account claiming it. A Udyam chip or a
 * penny-drop flag is earned only when the vendor's record is the claimant's
 * own business:
 *
 *   1. an ID match — the vendor returned a GSTIN or PAN equal to one of the
 *      claimant's own (a GST-locked GSTIN, the PAN inside it, or an
 *      admin-reviewed PAN / GSTIN); or
 *   2. a name match — the vendor's enterprise / account-holder name matches a
 *      GST-locked legal or trade name after normalisation (case, punctuation,
 *      "M/s", legal-form suffixes such as PVT LTD / PRIVATE LIMITED / LLP /
 *      & CO, whitespace) under a conservative token rule.
 *
 * A vendor ID that CONTRADICTS the claimant's own is a mismatch even when the
 * names agree (two businesses can share a name; they cannot share a PAN).
 * Anything else is `name_mismatch`, recorded for ops review. Pure; zod only.
 */

// ── outcomes (every attempt row carries one) ──────────────────────────────────

export const KYC_ATTEMPT_OUTCOMES = ['verified', 'name_mismatch', 'not_verified', 'stub', 'udyam_already_claimed'] as const
export const kycAttemptOutcomeSchema = z.enum(KYC_ATTEMPT_OUTCOMES)
export type KycAttemptOutcome = z.infer<typeof kycAttemptOutcomeSchema>

/** Outcomes the admin verification queue lists for review. */
export const KYC_REVIEW_OUTCOMES: readonly KycAttemptOutcome[] = ['name_mismatch', 'udyam_already_claimed']

export const KYC_OWNERSHIP_REASONS = ['id_match', 'name_match', 'id_conflict', 'no_reference', 'no_vendor_name', 'mismatch'] as const
export const KYC_NAME_RULES = ['exact', 'compact', 'initials', 'tokens'] as const

/** What is stored on the attempt row (`result.match`) and returned to the route. */
export const kycOwnershipSchema = z.object({
  outcome: z.enum(['verified', 'name_mismatch']),
  basis: z.enum(['gstin', 'pan', 'name']).nullable(),
  reason: z.enum(KYC_OWNERSHIP_REASONS),
  /** Best token score against any reference name, 0–1 (1 for an exact / compact / ID match). */
  score: z.number().min(0).max(1),
  rule: z.enum(KYC_NAME_RULES).nullable(),
  /** The reference name that matched best (for the ops card); never an ID. */
  reference: z.string().nullable(),
})
export type KycOwnership = z.infer<typeof kycOwnershipSchema>

// ── identifiers ───────────────────────────────────────────────────────────────

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

const idKey = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, '').toUpperCase()

/** The PAN inside a GSTIN (characters 3–12), or null. */
export function panFromGstin(gstin: string | null | undefined): string | null {
  const g = idKey(gstin)
  return GSTIN_RE.test(g) ? g.slice(2, 12) : null
}

/** A Udyam number as the one-claim index sees it (trimmed, upper-case). */
export function udyamClaimKey(udyam: string): string {
  return idKey(udyam)
}

// ── names ─────────────────────────────────────────────────────────────────────

/** Trailing legal-form words (and the first letters of a truncated one: banks cut "PRIVATE LIMI…"). */
const LEGAL_FORM_TOKENS = new Set(['PRIVATE', 'PVT', 'LIMITED', 'LTD', 'LLP', 'LLC', 'INC', 'OPC', 'CO', 'COMPANY', 'CORPORATION', 'CORP'])
const TRUNCATABLE = ['PRIVATE', 'LIMITED', 'COMPANY', 'CORPORATION']
const FILLER_TOKENS = new Set(['AND', 'THE', 'OF'])
/** Words many unrelated businesses share: never the only evidence for a match. */
const GENERIC_TOKENS = new Set([
  'TRADERS', 'TRADING', 'ENTERPRISES', 'ENTERPRISE', 'INDUSTRIES', 'INDUSTRY', 'SERVICES', 'SERVICE', 'SOLUTIONS', 'CONSULTANTS',
  'CONSULTANCY', 'ASSOCIATES', 'AGENCIES', 'AGENCY', 'INDIA', 'INTERNATIONAL', 'GROUP', 'TECHNOLOGIES', 'SYSTEMS', 'WORKS', 'STORES',
  'MART', 'CENTRE', 'CENTER', 'SRI', 'SHRI', 'SHREE', 'NEW',
])

/** Upper-case tokens of a business name with the prefix "M/s", legal-form suffixes and fillers removed. */
export function businessNameTokens(name: string | null | undefined): string[] {
  const s = (name ?? '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/^\s*(?:M\s*\/\s*S|MESSRS|M\.\s*S)\b\.?/, ' ')
    .replace(/&/g, ' AND ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  const tokens = s ? s.split(/\s+/) : []
  const isLegalForm = (t: string) => LEGAL_FORM_TOKENS.has(t) || (t.length >= 3 && TRUNCATABLE.some((w) => w.startsWith(t)))
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]!
    if (!isLegalForm(last) && !FILLER_TOKENS.has(last)) break
    tokens.pop()
    // "XYZ P LTD" / "XYZ (P) LIMITED": the P belongs to the legal form.
    if ((last === 'LTD' || 'LIMITED'.startsWith(last)) && tokens.length > 1 && tokens[tokens.length - 1] === 'P') tokens.pop()
  }
  return tokens.filter((t) => !FILLER_TOKENS.has(t))
}

/** The normalised name ("SRI SAI TRADERS"), '' when nothing distinctive is left. */
export function normaliseBusinessName(name: string | null | undefined): string {
  return businessNameTokens(name).join(' ')
}

/** Shared tokens over the longer name's token count must reach this for a token match. */
export const KYC_NAME_TOKEN_THRESHOLD = 0.8

export interface NameMatch {
  match: boolean
  score: number
  rule: (typeof KYC_NAME_RULES)[number] | null
}

/**
 * Conservative business-name match. In order: exact after normalisation;
 * equal with the spaces removed ("R K" ~ "RK"); same length with initials
 * ("R K SHARMA" ~ "RAJESH KUMAR SHARMA", one distinctive word shared); token
 * overlap ≥ 0.8 of the longer name (word order free) with at least one
 * distinctive shared word — a name of one or two words can only meet it in
 * full, and "SRI SAI TRADERS" never matches "SRI SAI ENTERPRISES".
 */
export function businessNamesMatch(a: string | null | undefined, b: string | null | undefined): NameMatch {
  const ta = businessNameTokens(a)
  const tb = businessNameTokens(b)
  if (ta.length === 0 || tb.length === 0) return { match: false, score: 0, rule: null }
  if (ta.join(' ') === tb.join(' ')) return { match: true, score: 1, rule: 'exact' }
  if (ta.join('') === tb.join('')) return { match: true, score: 1, rule: 'compact' }
  const distinctive = (t: string) => t.length >= 3 && !GENERIC_TOKENS.has(t)
  if (ta.length === tb.length && ta.length >= 2) {
    let full = 0
    const ok = ta.every((x, i) => {
      const y = tb[i]!
      if (x === y) {
        if (distinctive(x)) full++
        return true
      }
      return (x.length === 1 && y.startsWith(x)) || (y.length === 1 && x.startsWith(y))
    })
    if (ok && full >= 1) return { match: true, score: 1, rule: 'initials' }
  }
  const rest = [...tb]
  let common = 0
  let distinctiveCommon = 0
  for (const t of ta) {
    const i = rest.indexOf(t)
    if (i >= 0) {
      common++
      if (distinctive(t)) distinctiveCommon++
      rest.splice(i, 1)
    }
  }
  const score = common / Math.max(ta.length, tb.length)
  const match = score >= KYC_NAME_TOKEN_THRESHOLD && distinctiveCommon >= 1
  return { match, score, rule: match ? 'tokens' : null }
}

// ── the decision ──────────────────────────────────────────────────────────────

export interface KycReferences {
  /** GST-locked names: the registry legal / trade name of the claimant's own verified GSTIN (and an admin-approved legal name). */
  names: readonly string[]
  /** The claimant's own PANs (inside a GST-locked GSTIN, or admin-reviewed). */
  pans: readonly string[]
  /** The claimant's own GSTINs (GST-locked or admin-reviewed). */
  gstins: readonly string[]
}

export interface KycVendorFacts {
  name?: string | null | undefined
  pan?: string | null | undefined
  gstin?: string | null | undefined
}

/** Does the vendor's record belong to the claimant? See the file header for the rule. */
export function kycOwnership(vendor: KycVendorFacts, refs: KycReferences): KycOwnership {
  const refGstins = new Set(refs.gstins.map(idKey).filter((g) => GSTIN_RE.test(g)))
  const refPans = new Set([...refs.pans.map(idKey), ...[...refGstins].map((g) => panFromGstin(g) ?? '')].filter((p) => PAN_RE.test(p)))
  const vGstin = idKey(vendor.gstin)
  const vPans = [idKey(vendor.pan), panFromGstin(vGstin) ?? ''].filter((p) => PAN_RE.test(p))
  const vendorHasId = GSTIN_RE.test(vGstin) || vPans.length > 0
  if (GSTIN_RE.test(vGstin) && refGstins.has(vGstin)) return { outcome: 'verified', basis: 'gstin', reason: 'id_match', score: 1, rule: null, reference: null }
  if (vPans.some((p) => refPans.has(p))) return { outcome: 'verified', basis: 'pan', reason: 'id_match', score: 1, rule: null, reference: null }
  if (vendorHasId && (refGstins.size > 0 || refPans.size > 0)) return { outcome: 'name_mismatch', basis: null, reason: 'id_conflict', score: 0, rule: null, reference: null }

  const names = refs.names.filter((n) => normaliseBusinessName(n) !== '')
  if (names.length === 0) return { outcome: 'name_mismatch', basis: null, reason: 'no_reference', score: 0, rule: null, reference: null }
  if (normaliseBusinessName(vendor.name) === '') return { outcome: 'name_mismatch', basis: null, reason: 'no_vendor_name', score: 0, rule: null, reference: names[0] ?? null }
  let best: { m: NameMatch; ref: string } | null = null
  for (const ref of names) {
    const m = businessNamesMatch(vendor.name, ref)
    if (!best || (m.match && !best.m.match) || (m.match === best.m.match && m.score > best.m.score)) best = { m, ref }
  }
  const b = best!
  return b.m.match
    ? { outcome: 'verified', basis: 'name', reason: 'name_match', score: b.m.score, rule: b.m.rule, reference: b.ref }
    : { outcome: 'name_mismatch', basis: null, reason: 'mismatch', score: b.m.score, rule: null, reference: b.ref }
}
