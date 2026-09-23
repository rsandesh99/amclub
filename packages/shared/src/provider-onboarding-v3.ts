import { z } from 'zod'
import { INDIAN_STATES } from './states'

/**
 * PRD Experience v3 E10 — provider onboarding v3 (flag `onboarding`).
 * Four named steps, GSTIN-first autofill (N27), per-step analytics and the
 * stall nudge (N27c). The PAN path (N27b) is NOT here: it waits on D3 and
 * ADR-016 (docs/adr/016-gst-exempt-providers.md, Proposed).
 */

export const ONBOARDING_V3_STEPS = ['contact', 'business', 'credentials_bank', 'review'] as const
export type OnboardingV3Step = (typeof ONBOARDING_V3_STEPS)[number]

// ── GSTIN → state (the first two digits are the GST state code) ─────────────────
/**
 * GST state codes → our state values (`INDIAN_STATES`). 25 (Daman & Diu) and
 * 26 (Dadra & Nagar Haveli) merged into DN in 2020; 28 is the pre-2014
 * Andhra Pradesh code still printed on older registrations.
 */
export const GST_STATE_CODES: Readonly<Record<string, string>> = {
  '01': 'JK', '02': 'HP', '03': 'PB', '04': 'CH', '05': 'UK', '06': 'HR', '07': 'DL', '08': 'RJ', '09': 'UP', '10': 'BR',
  '11': 'SK', '12': 'AR', '13': 'NL', '14': 'MN', '15': 'MZ', '16': 'TR', '17': 'ML', '18': 'AS', '19': 'WB', '20': 'JH',
  '21': 'OD', '22': 'CG', '23': 'MP', '24': 'GJ', '25': 'DN', '26': 'DN', '27': 'MH', '28': 'AP', '29': 'KA', '30': 'GA',
  '31': 'LD', '32': 'KL', '33': 'TN', '34': 'PY', '35': 'AN', '36': 'TS', '37': 'AP', '38': 'LA',
}

/** The state a GSTIN was issued in (our state value), or null for anything that isn't a state code. */
export function stateFromGstin(gstin: string | null | undefined): string | null {
  const code = (gstin ?? '').trim().slice(0, 2)
  return GST_STATE_CODES[code] ?? null
}

/**
 * The vendor's state field as one of our values: a 2-letter value passes
 * through; a name ("Telangana", "State - Telangana, Hyderabad") matches the
 * longest state label it contains. Null when nothing matches.
 */
export function normalizeVendorState(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  const up = s.toUpperCase()
  if (INDIAN_STATES.some((x) => x.value === up)) return up
  const low = s.toLowerCase().replace(/&/g, 'and')
  let best: { value: string; len: number } | null = null
  for (const x of INDIAN_STATES) {
    const label = x.label.toLowerCase().replace(/&/g, 'and')
    if (low.includes(label) && (!best || label.length > best.len)) best = { value: x.value, len: label.length }
  }
  return best?.value ?? null
}

// ── FR-10.3 (N27) GSTIN autofill ─────────────────────────────────────────────────
/** What `POST /profile/provider/kyc/verify-gstin` returns in v3 (the vendor facts, normalised). */
export const gstinAutofillSchema = z.object({
  verified: z.boolean(),
  legalName: z.string().nullable(),
  tradeName: z.string().nullable(),
  /** Our state value, from the vendor when it names one, else from the GSTIN's first two digits. */
  state: z.string().nullable(),
  /** True when the vendor's state and the GSTIN's code disagree — an admin flag, never a block. */
  stateMismatch: z.boolean(),
  /** YYYY-MM-DD (suggests "in business since"). */
  registrationDate: z.string().nullable(),
  active: z.boolean(),
  /** The vendor's status text when not active ("Cancelled", "Suspended"), shown as the reason. */
  statusText: z.string().nullable(),
  address: z.string().nullable(),
  stub: z.boolean(),
})
export type GstinAutofill = z.infer<typeof gstinAutofillSchema>

/** The fields the wizard fills from a verified GSTIN (the `onboarding_gstin_autofilled.fields` count). */
export function autofilledFields(a: Pick<GstinAutofill, 'legalName' | 'tradeName' | 'state' | 'registrationDate' | 'address'>): string[] {
  return (['legalName', 'tradeName', 'state', 'registrationDate', 'address'] as const).filter((k) => !!a[k])
}

/** Build the autofill from a vendor result (legal name, trade name, the vendor state text, date, active). */
export function toGstinAutofill(gstin: string, r: { verified: boolean; legalName?: string | undefined; tradeName?: string | undefined; state?: string | undefined; registrationDate?: string | undefined; isActive?: boolean | undefined; statusText?: string | undefined; address?: string | undefined; stub?: boolean | undefined }): GstinAutofill {
  const fromCode = stateFromGstin(gstin)
  const fromVendor = normalizeVendorState(r.state)
  const date = r.registrationDate ? normalizeDate(r.registrationDate) : null
  return {
    verified: r.verified,
    legalName: r.legalName?.trim() || null,
    tradeName: r.tradeName?.trim() || null,
    state: fromVendor ?? fromCode,
    stateMismatch: !!fromVendor && !!fromCode && fromVendor !== fromCode,
    registrationDate: date,
    active: r.isActive !== false,
    statusText: r.isActive === false ? r.statusText?.trim() || 'Cancelled' : null,
    address: r.address?.trim() || null,
    stub: r.stub === true,
  }
}

/** Vendor dates come as YYYY-MM-DD or DD/MM/YYYY; anything else is dropped. */
export function normalizeDate(s: string): string | null {
  const t = s.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
  const m = t.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}

// ── FR-10.4 (N27c) the stall rule ────────────────────────────────────────────────
/** A draft untouched this long gets a nudge. */
export const ONBOARDING_STALL_HOURS = 24
/** At most this many nudges per draft. */
export const ONBOARDING_MAX_NUDGES = 2

/**
 * The nudge number due now (1 or 2), or null. A draft stalls when its last
 * step was saved ≥ 24 h ago; the second nudge needs another 24 h of silence
 * after the first. Nothing once submitted or after the cap.
 */
export function onboardingNudgeDue(p: { updatedAt: string; submittedAt: string | null }, nudges: readonly { sentAt: string }[], now: Date = new Date()): 1 | 2 | null {
  if (p.submittedAt) return null
  if (nudges.length >= ONBOARDING_MAX_NUDGES) return null
  const stall = ONBOARDING_STALL_HOURS * 3600 * 1000
  const lastTouch = Math.max(Date.parse(p.updatedAt), ...nudges.map((n) => Date.parse(n.sentAt)))
  if (now.getTime() - lastTouch < stall) return null
  return (nudges.length + 1) as 1 | 2
}

/** Steps left from `step` to submit (the "2 steps from done" in the nudge). */
export function stepsLeft(step: OnboardingV3Step): number {
  return ONBOARDING_V3_STEPS.length - ONBOARDING_V3_STEPS.indexOf(step)
}

export const onboardingProgressSchema = z.object({
  step: z.enum(ONBOARDING_V3_STEPS),
  categorySlug: z.string().max(64).optional(),
})
