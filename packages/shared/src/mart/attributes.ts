import { z } from 'zod'

/**
 * E16 N40 — typed attributes per Mart category (mart_category_attributes,
 * staged 0069). A product's `attributes` are validated against its category's
 * definitions by the seller routes; facetable attributes (enum / bool only)
 * become goods facets. Config, not constants: admins own the definitions.
 */
export const MART_ATTRIBUTE_TYPES = ['text', 'number', 'enum', 'bool'] as const
export type MartAttributeType = (typeof MART_ATTRIBUTE_TYPES)[number]

export interface MartAttributeDef {
  key: string
  label_i18n: { en: string; hi?: string; te?: string; ta?: string }
  type: MartAttributeType
  unit: string | null
  options: string[] | null
  facetable: boolean
  required: boolean
  sort: number
}

export const martAttributeValueSchema = z.union([z.string().trim().min(1).max(80), z.number().finite(), z.boolean()])
export const productAttributesSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), martAttributeValueSchema).default({})
export type ProductAttributes = z.infer<typeof productAttributesSchema>

export type AttributeProblem = { key: string; code: 'required' | 'unknown' | 'type' | 'option' }

/**
 * Validate + normalise against the category's definitions: unknown keys are
 * refused; required ones must be present; numbers are finite (strings like
 * "12" are coerced); enums must be one of the options; bools are booleans.
 */
export function validateProductAttributes(defs: readonly MartAttributeDef[], input: Record<string, unknown>): { ok: true; value: ProductAttributes } | { ok: false; problems: AttributeProblem[] } {
  const byKey = new Map(defs.map((d) => [d.key, d]))
  const problems: AttributeProblem[] = []
  const value: ProductAttributes = {}
  for (const [key, raw] of Object.entries(input ?? {})) {
    const def = byKey.get(key)
    if (!def) { problems.push({ key, code: 'unknown' }); continue }
    if (raw === '' || raw == null) continue
    if (def.type === 'number') {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
      if (!Number.isFinite(n)) { problems.push({ key, code: 'type' }); continue }
      value[key] = n
    } else if (def.type === 'bool') {
      if (typeof raw !== 'boolean') { problems.push({ key, code: 'type' }); continue }
      value[key] = raw
    } else if (def.type === 'enum') {
      const s = String(raw)
      if (!(def.options ?? []).includes(s)) { problems.push({ key, code: 'option' }); continue }
      value[key] = s
    } else {
      const s = String(raw).trim()
      if (!s || s.length > 80) { problems.push({ key, code: 'type' }); continue }
      value[key] = s
    }
  }
  // A present-but-invalid value already has its problem; `required` is for a missing one.
  const reported = new Set(problems.map((p) => p.key))
  for (const d of defs) if (d.required && value[d.key] === undefined && !reported.has(d.key)) problems.push({ key: d.key, code: 'required' })
  return problems.length ? { ok: false, problems } : { ok: true, value }
}

export interface AttributeFacet {
  key: string
  label_i18n: MartAttributeDef['label_i18n']
  values: { value: string; count: number }[]
}

/** Facet counts over products' attributes for the facetable (enum / bool) definitions; values sorted by count. */
export function countAttributeFacets(defs: readonly MartAttributeDef[], rows: readonly { attributes: unknown }[]): AttributeFacet[] {
  return defs
    .filter((d) => d.facetable && (d.type === 'enum' || d.type === 'bool'))
    .sort((a, b) => a.sort - b.sort)
    .map((d) => {
      const counts = new Map<string, number>()
      for (const r of rows) {
        const v = (r.attributes as Record<string, unknown> | null)?.[d.key]
        if (v === undefined || v === null || v === '') continue
        const k = String(v)
        counts.set(k, (counts.get(k) ?? 0) + 1)
      }
      return { key: d.key, label_i18n: d.label_i18n, values: [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)) }
    })
    .filter((f) => f.values.length > 0)
}

/**
 * `a.<key>=<value>` query params → typed attribute filters (a jsonb containment
 * the catalog query applies), only for facetable keys: an enum value must be one
 * of the options, a bool is `true` / `false`. Anything else is ignored.
 */
export function parseAttributeFilters(defs: readonly MartAttributeDef[], params: Record<string, string | undefined>): Record<string, string | boolean> {
  const byKey = new Map(defs.filter((d) => d.facetable).map((d) => [d.key, d]))
  const out: Record<string, string | boolean> = {}
  for (const [k, v] of Object.entries(params)) {
    if (!k.startsWith('a.') || !v) continue
    const def = byKey.get(k.slice(2))
    if (!def) continue
    if (def.type === 'bool') {
      if (v === 'true' || v === 'false') out[def.key] = v === 'true'
    } else if (def.type === 'enum' && (def.options ?? []).includes(v)) out[def.key] = v
  }
  return out
}

/** A value as shown ("12 mm", "Yes"); bools take their words from the caller. */
export function formatAttributeValue(def: Pick<MartAttributeDef, 'type' | 'unit'>, v: unknown, words: { yes: string; no: string }): string {
  if (def.type === 'bool') return v === true ? words.yes : words.no
  return def.unit ? `${String(v)} ${def.unit}` : String(v)
}
