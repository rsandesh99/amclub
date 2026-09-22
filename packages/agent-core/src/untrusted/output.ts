import { z } from 'zod'
import { findOutputViolations, type OutputForbid, type OutputViolation } from '@amclub/shared'

/**
 * S2.1 — the customer-facing output contract. `customerFacingText(schema, opts)`
 * wraps a Zod schema and post-validates the named string fields (dotted paths;
 * `[]` walks an array) against the shared output policy: contact details,
 * off-platform payment, ranking / steering language, approval claims, URLs.
 * A violation is a Zod issue (code `custom`, message = the violation code,
 * `params.violation` / `params.match`), so `schema.parse` REJECTS the model
 * output and the caller falls back exactly as every S1 route already does on a
 * schema failure — a template message, a rule-only report, chips dropped.
 * Nothing here masks: `redactContactInfo` masks at storage time; this refuses.
 *
 * Every prompt whose text reaches a buyer, provider or WhatsApp user opts in
 * (in the agent-core schema.ts files, so shared stays policy-only). Ops-only
 * cards opt in with `contact` + `urls` only.
 */

export type { OutputForbid, OutputViolation }

export interface CustomerFacingOptions {
  /** Dotted paths of string fields; `[]` walks arrays: 'message', 'pointers[].lines[]', 'facts[].v'. */
  fields: readonly string[]
  /** Locale for the phrase lists; when absent, the object's own `locale` field, else 'en'. English is always checked. */
  locale?: string
  forbid: readonly OutputForbid[]
}

interface Hit {
  path: (string | number)[]
  value: string
}

/** Collect every string at a dotted path (arrays via `[]`). Missing / non-string values are skipped. */
export function collectStrings(obj: unknown, field: string): Hit[] {
  const segs = field.split('.').filter(Boolean)
  const out: Hit[] = []
  const walk = (cur: unknown, i: number, path: (string | number)[]) => {
    if (i === segs.length) {
      if (typeof cur === 'string') out.push({ path, value: cur })
      return
    }
    const seg = segs[i]!
    const isArr = seg.endsWith('[]')
    const key = isArr ? seg.slice(0, -2) : seg
    if (cur === null || typeof cur !== 'object') return
    const next = key ? (cur as Record<string, unknown>)[key] : cur
    if (isArr) {
      if (!Array.isArray(next)) return
      next.forEach((item, idx) => walk(item, i + 1, key ? [...path, key, idx] : [...path, idx]))
    } else {
      walk(next, i + 1, key ? [...path, key] : path)
    }
  }
  walk(obj, 0, [])
  return out
}

/** Pure check without Zod: the violations per field (for tests, evals and rigs). */
export function checkCustomerFacing(value: unknown, opts: CustomerFacingOptions): { path: (string | number)[]; violation: OutputViolation }[] {
  const locale = opts.locale ?? ((value as { locale?: unknown } | null)?.locale as string | undefined)
  const out: { path: (string | number)[]; violation: OutputViolation }[] = []
  for (const field of opts.fields) {
    for (const hit of collectStrings(value, field)) {
      for (const violation of findOutputViolations(hit.value, { locale: locale ?? null, forbid: opts.forbid })) out.push({ path: hit.path, violation })
    }
  }
  return out
}

/** Wrap a schema: the output type is unchanged; violations become Zod issues that fail `parse`. */
export function customerFacingText<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, opts: CustomerFacingOptions): z.ZodEffects<z.ZodType<T, z.ZodTypeDef, unknown>, T, unknown> {
  return schema.superRefine((value, ctx) => {
    for (const { path, violation } of checkCustomerFacing(value, opts)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: violation.code, params: { violation: violation.code, match: violation.match } })
    }
  })
}
