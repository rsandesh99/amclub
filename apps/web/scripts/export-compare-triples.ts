/**
 * E15 FR-15 F1 — the (RFQ, quotes, chosen) triples the eval harness learns and
 * scores compare against. One JSON line per ACCEPTED services request:
 *
 *   { "rfq": { "ref", "category_slug", "must_haves", "has_cad", "decided_at" },
 *     "quotes": [ { "normalized_total_paise", "delivery_days", "gst_mode", "advance_percent", "flags" } ],
 *     "chosen": <index of the accepted quote> }
 *
 * No provider or buyer identity leaves: the RFQ is a salted hash, quotes are
 * positions, and every number is the one compare showed (shared compareQuotes —
 * the checkout number, ADR-017). Goods (Mart) requests — category_id NULL — are skipped
 * (no staged column is named). WhatsApp-derived requests are skipped too (ADR-030 §6, shared
 * `corpusSourceAllowed`: Meta's terms cover anything derived from WhatsApp content): a request dictated
 * as a WhatsApp voice note, run by a WhatsApp procurement session, or holding a quote Munshi drafted.
 *
 *   EXPORT_SALT=… pnpm --filter @amclub/web exec tsx scripts/export-compare-triples.ts [--days 180] [--out triples.jsonl]
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { compareQuotes, corpusSourceAllowed, rfqMustHavesSchema, type CompareQuoteInput } from '@amclub/shared'

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }
const days = Number(arg('days') ?? 180)
const out = arg('out')
const salt = process.env['EXPORT_SALT']
if (!salt || salt.length < 16) { console.error('EXPORT_SALT (≥ 16 chars) is required: RFQ refs are salted hashes'); process.exit(2) }
const admin = createClient(process.env['NEXT_PUBLIC_SUPABASE_URL']!, process.env['SUPABASE_SERVICE_ROLE_KEY']!, { auth: { persistSession: false } })
const ref = (id: string) => createHash('sha256').update(`${salt}:${id}`).digest('hex').slice(0, 16)

async function main() {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const lines: string[] = []
  let from = 0
  for (;;) {
    const { data: rfqs, error } = await admin.from('rfqs').select('id, category_id, must_haves, cad_features, voice_meta, updated_at, categories(slug)').eq('status', 'accepted').not('category_id', 'is', null).gte('updated_at', since).order('updated_at').range(from, from + 199)
    if (error) throw new Error(error.message)
    if (!rfqs?.length) break
    const ids = rfqs.map((r) => r.id as string)
    const { data: quotes, error: qErr } = await admin.from('quotes').select('id, rfq_id, status, price_paise, delivery_days, gst_included, transport_included, valid_until, advance_percent, munshi_draft_id, created_at').in('rfq_id', ids).order('created_at')
    if (qErr) throw new Error(qErr.message)
    const { data: waSessions, error: sErr } = await admin.from('procurement_sessions').select('rfq_id').in('rfq_id', ids).eq('surface', 'whatsapp')
    if (sErr) throw new Error(sErr.message)
    const viaWhatsApp = new Set((waSessions ?? []).map((x) => x.rfq_id as string))
    for (const r of rfqs) {
      const qs = (quotes ?? []).filter((q) => q.rfq_id === r.id)
      const voiceChannel = (r.voice_meta as { channel?: string } | null)?.channel ?? null
      if (!corpusSourceAllowed({ voiceChannel, runSurface: viaWhatsApp.has(r.id as string) ? 'whatsapp' : null })) continue
      if (qs.some((q) => q.munshi_draft_id)) continue
      const chosen = qs.findIndex((q) => q.status === 'accepted')
      if (qs.length < 2 || chosen < 0) continue
      const input: CompareQuoteInput[] = qs.map((q) => ({ id: q.id as string, kind: 'service', pricePaise: Number(q.price_paise), deliveryDays: (q.delivery_days as number | null) ?? null, gstIncluded: (q.gst_included as boolean | null) ?? null, transportIncluded: (q.transport_included as boolean | null) ?? null, validUntil: (q.valid_until as string | null) ?? null, advancePercent: (q.advance_percent as number | null) ?? null }))
      const res = compareQuotes(input, { today: String(r.updated_at).slice(0, 10) })
      const mh = rfqMustHavesSchema.safeParse(r.must_haves ?? {})
      lines.push(JSON.stringify({
        rfq: { ref: ref(r.id as string), category_slug: (r.categories as { slug?: string } | null)?.slug ?? null, must_haves: mh.success ? mh.data : null, has_cad: !!r.cad_features, decided_at: String(r.updated_at).slice(0, 10) },
        quotes: qs.map((q, i) => ({ normalized_total_paise: res[i]!.normalizedTotalPaise, delivery_days: q.delivery_days ?? null, gst_mode: q.gst_included === true ? 'included' : q.gst_included === false ? 'extra' : 'unstated', advance_percent: q.advance_percent ?? null, flags: res[i]!.flags })),
        chosen,
      }))
    }
    if (rfqs.length < 200) break
    from += 200
  }
  const body = lines.join('\n') + (lines.length ? '\n' : '')
  if (out) { writeFileSync(out, body); console.error(`✓ ${lines.length} triples → ${out}`) } else process.stdout.write(body)
}

main().catch((e) => { console.error(e); process.exit(1) })
