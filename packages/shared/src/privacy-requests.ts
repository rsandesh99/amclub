import { z } from 'zod'

/**
 * DPDP data-principal requests (ADR-030 §6; table dpdp_requests, migration 0087). A signed-in person files them from
 * the web (/app/privacy, /partner/privacy) or the mobile app through POST /api/v1/me/privacy-requests; the WhatsApp
 * keywords (MY DATA / DELETE MY DATA) file them from the runtime; ops works them from the admin console. One open
 * request per kind per person (409 already_open). Pure; zod only.
 */

/** Kinds a person can file themselves (the table also knows 'nomination', which ops records). */
export const PRIVACY_REQUEST_KINDS = ['access', 'correction', 'erasure', 'withdrawal', 'grievance'] as const
export type PrivacyRequestKind = (typeof PRIVACY_REQUEST_KINDS)[number]

export const PRIVACY_REQUEST_STATUSES = ['open', 'in_progress', 'done', 'rejected'] as const
export type PrivacyRequestStatus = (typeof PRIVACY_REQUEST_STATUSES)[number]
/** A request in one of these holds its kind: a second one of the same kind is refused until it closes. */
export const PRIVACY_REQUEST_OPEN_STATUSES = ['open', 'in_progress'] as const

/** Where a signed-in person's own request came from (the runtime writes 'whatsapp'; ops 'email' / 'admin'). */
export const PRIVACY_REQUEST_CLIENT_SOURCES = ['web', 'mobile'] as const
export type PrivacyRequestClientSource = (typeof PRIVACY_REQUEST_CLIENT_SOURCES)[number]

/** Days we commit to answer within; the due date is shown to the person and drives the ops queue. */
export const PRIVACY_REQUEST_DUE_DAYS = 30
export const PRIVACY_DETAILS_MIN = 10
export const PRIVACY_DETAILS_MAX = 2000
/** Kinds where the person must say what: what to correct, what went wrong. */
export const PRIVACY_KINDS_NEEDING_DETAILS: readonly PrivacyRequestKind[] = ['correction', 'grievance']

export type PrivacyRequestProblem = 'details_required' | 'details_too_long'

/** The form rule, shared by the web and mobile forms and the route: null when the request can be filed. */
export function privacyRequestProblem(input: { kind: PrivacyRequestKind; details?: string | null }): PrivacyRequestProblem | null {
  const details = (input.details ?? '').trim()
  if (details.length > PRIVACY_DETAILS_MAX) return 'details_too_long'
  if (PRIVACY_KINDS_NEEDING_DETAILS.includes(input.kind) && details.length < PRIVACY_DETAILS_MIN) return 'details_required'
  return null
}

export const privacyRequestCreateSchema = z
  .object({
    kind: z.enum(PRIVACY_REQUEST_KINDS),
    details: z.string().max(PRIVACY_DETAILS_MAX * 2).nullable().optional(),
    source: z.enum(PRIVACY_REQUEST_CLIENT_SOURCES).optional(),
  })
  .superRefine((v, ctx) => {
    const problem = privacyRequestProblem({ kind: v.kind, details: v.details ?? null })
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['details'], message: problem })
  })
export type PrivacyRequestCreate = z.infer<typeof privacyRequestCreateSchema>

/** When a request filed at `now` is due. */
export function privacyRequestDueAt(now: Date): Date {
  return new Date(now.getTime() + PRIVACY_REQUEST_DUE_DAYS * 86_400_000)
}

/** One request as the person sees it (GET /api/v1/me/privacy-requests). */
export interface PrivacyRequestView {
  id: string
  kind: PrivacyRequestKind | 'nomination'
  status: PrivacyRequestStatus
  details: string | null
  resolution: string | null
  dueAt: string
  createdAt: string
  resolvedAt: string | null
}
