/**
 * Catalog Agent v1 (MART_DESIGN.md §5) — seller photos + a spoken/typed
 * description → a DRAFTED listing (name, description, category, HSN + GST
 * SUGGESTIONS, unit, tiers). Draft-and-approve doctrine: the agent proposes,
 * the seller confirms every field, the confirmed listing + the proposal are
 * written to ai_decisions by the create route. The agent never writes a row.
 *
 * ONE temperature-0 OpenRouter chat call (vision-capable small model; images
 * as URLs) returning strict JSON, Zod-validated and vocabulary-clamped here —
 * an out-of-vocabulary value never reaches the seller. STUB when
 * OPENROUTER_API_KEY is unset (keyword heuristic, uncertain=true).
 */
import 'server-only'
import {
  catalogDraftSchema,
  GST_RATE_BPS_OPTIONS,
  HSN_CODE_RE,
  PRODUCT_UNITS,
  type CatalogDraft,
} from '@amclub/shared'
import { VendorHttpError } from '@/lib/voice/types'
import type { MartCategoryRow } from './config'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_MODEL = 'google/gemini-2.5-flash-lite'

/** Common HSN chapters per launch category — hints for the model AND the stub. */
const HSN_HINTS: Record<string, string> = {
  fasteners: '7318',
  'welding-consumables': '8311',
  abrasives: '6804',
  lubricants: '2710',
  'cutting-tools': '8207',
  'hand-tools': '8205',
  spares: '8487',
  'safety-gear': '6506',
}

export interface CatalogDraftInput {
  description: string
  imageUrls: string[]
  categories: MartCategoryRow[]
}

export interface CatalogDraftResult {
  draft: CatalogDraft
  vendor: string
  stub: boolean
  requestId: string | null
  usage?: Record<string, unknown> | undefined
}

function systemPrompt(categories: MartCategoryRow[]): string {
  return `You draft a product listing for an Indian industrial-consumables (MRO) marketplace from a seller's photos and description. Return ONLY a JSON object — no prose, no code fences.

Categories (pick exactly one slug, or null):
${categories.map((c) => `- ${c.slug}: ${c.name_i18n.en}${c.bis_blocked ? ' (NOT accepted at launch)' : ''}`).join('\n')}

Typical HSN chapters: ${Object.entries(HSN_HINTS).map(([k, v]) => `${k}=${v}`).join(', ')}
GST slabs in basis points: 0, 500, 1200, 1800, 2800 (most industrial consumables are 1800).
Units: ${PRODUCT_UNITS.join(', ')}

Output shape:
{"name": string|null, "description": string|null, "category_slug": string|null, "hsn_code": string|null, "gst_rate_bps": number|null, "unit": string|null, "tiers": [{"min_qty": number, "unit_price_paise": number}]|null, "uncertain": boolean}

Rules:
- name: ≤ 80 chars, spec-first ("M8 x 40 hex bolt, zinc plated, 8.8"). description: 1–3 plain sentences with sizes, grade, brand, pack size.
- hsn_code: 4–8 digits. gst_rate_bps: one of the slabs. Both are SUGGESTIONS the seller must confirm — when unsure set null and uncertain=true.
- tiers: only if the seller states prices; quantities ascending from 1, unit price strictly decreasing; prices in PAISE (₹4.50 = 450). Never invent prices.
- uncertain=true whenever the category or product identity is not clear from the inputs.`
}

/** Clamp any draft (model or stub) to the schema + curated vocabulary. */
function sanitize(raw: unknown, categories: MartCategoryRow[]): CatalogDraft | null {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const parsed = catalogDraftSchema.safeParse({
    name: obj['name'] ?? null,
    description: obj['description'] ?? null,
    category_slug: obj['category_slug'] ?? null,
    hsn_code: obj['hsn_code'] == null ? null : String(obj['hsn_code']),
    gst_rate_bps: obj['gst_rate_bps'] ?? null,
    unit: obj['unit'] ?? null,
    tiers: Array.isArray(obj['tiers']) ? obj['tiers'] : null,
    uncertain: obj['uncertain'] ?? true,
  })
  if (!parsed.success) return null
  const d = parsed.data
  const allowed = new Set(categories.filter((c) => c.is_active && !c.bis_blocked).map((c) => c.slug))
  if (d.category_slug && !allowed.has(d.category_slug)) d.category_slug = null
  if (d.hsn_code && !HSN_CODE_RE.test(d.hsn_code)) d.hsn_code = null
  if (d.gst_rate_bps !== null && !(GST_RATE_BPS_OPTIONS as readonly number[]).includes(d.gst_rate_bps)) d.gst_rate_bps = null
  if (d.unit && !(PRODUCT_UNITS as readonly string[]).includes(d.unit)) d.unit = null
  if (d.tiers) {
    const t = [...d.tiers].sort((a, b) => a.min_qty - b.min_qty)
    const valid = t.length > 0 && t[0]!.min_qty === 1 && t.every((x, i) => i === 0 || (x.min_qty > t[i - 1]!.min_qty && x.unit_price_paise < t[i - 1]!.unit_price_paise))
    d.tiers = valid ? t : null
  }
  if (!d.category_slug) d.uncertain = true
  return d
}

function stubDraft(input: CatalogDraftInput): CatalogDraft {
  const text = input.description.toLowerCase()
  const KEYWORDS: [string, RegExp][] = [
    ['fasteners', /bolt|nut|screw|washer|stud|anchor|rivet|fastener/],
    ['welding-consumables', /weld|electrode|rod|flux|wire|tig|mig/],
    ['abrasives', /grind|abrasive|sand ?paper|emery|cutting disc|flap/],
    ['lubricants', /oil|grease|lubric|coolant/],
    ['cutting-tools', /drill|tap|reamer|insert|end ?mill|blade|cutter/],
    ['hand-tools', /spanner|wrench|hammer|plier|screwdriver|hand tool/],
    ['spares', /bearing|belt|seal|gasket|spare|coupling|motor/],
  ]
  const hit = KEYWORDS.find(([, re]) => re.test(text))
  const category = hit?.[0] ?? null
  return sanitize(
    {
      name: input.description.trim().slice(0, 80) || null,
      description: input.description.trim() || null,
      category_slug: category,
      hsn_code: category ? HSN_HINTS[category] ?? null : null,
      gst_rate_bps: category ? 1800 : null,
      unit: 'pcs',
      tiers: null,
      uncertain: true,
    },
    input.categories,
  )!
}

export async function draftListing(input: CatalogDraftInput): Promise<CatalogDraftResult> {
  const apiKey = process.env['OPENROUTER_API_KEY']
  const model = process.env['CATALOG_AGENT_MODEL'] ?? DEFAULT_MODEL
  if (!apiKey) {
    console.warn('[catalog-agent] OPENROUTER_API_KEY unset — would draft with', model, '(stub heuristic used)')
    return { draft: stubDraft(input), vendor: 'stub', stub: true, requestId: null }
  }
  const content: unknown[] = [{ type: 'text', text: input.description || '(no description — use the photos)' }]
  for (const url of input.imageUrls.slice(0, 6)) content.push({ type: 'image_url', image_url: { url } })
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      usage: { include: true },
      messages: [
        { role: 'system', content: systemPrompt(input.categories) },
        { role: 'user', content },
      ],
    }),
  })
  if (!res.ok) throw new VendorHttpError('openrouter', res.status, await res.text().catch(() => ''))
  const d = (await res.json()) as { id?: string; usage?: Record<string, unknown>; choices?: { message?: { content?: string } }[] }
  const text = (d.choices?.[0]?.message?.content ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('openrouter: non-JSON response')
  }
  const draft = sanitize(raw, input.categories)
  if (!draft) throw new Error('openrouter: response failed schema validation')
  return { draft, vendor: `openrouter:${model}`, stub: false, requestId: d.id ?? null, usage: d.usage }
}
