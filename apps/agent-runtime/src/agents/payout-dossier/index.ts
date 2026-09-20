import sharp from 'sharp'
import {
  computeDossierChecks,
  dhashFromImage,
  envelope,
  getPrompt,
  hammingHex,
  isValidDhash,
  photoPlausibilitySchema,
  signRuntimeCredential,
  type AgentDefinition,
  type ChatImage,
  type DuplicatePhoto,
  type Envelope,
} from '@amclub/agent-core'
import {
  MILESTONE_ORDER,
  orderEvidenceSchema,
  recommendDossier,
  type DossierRecommendation,
  type OrderEvidence,
  type PhotoFinding,
} from '@amclub/shared'
import { admin } from '../../deps'
import { RUNTIME_ENV } from '../../env'

/**
 * Payout-Evidence agent (BUILD_PROMPTS S1.4). Persona ops; READ-ONLY.
 *
 *  1. read_order_evidence — the ONE tool: GET /api/v1/admin/orders/[id]/evidence
 *     under the founder's delegated ops token (RLS + requireAdmin + scope).
 *  2. Deterministic checks (agent-core computeDossierChecks).
 *  3. Photos: cap at dossier_max_photos, download, dHash, upsert
 *     evidence_photo_hashes (agent-owned telemetry), flag near-duplicates of a
 *     DIFFERENT order by the same provider.
 *  4. Vision: ONE model call (photo_plausibility@v1, frontier tier) with the
 *     order facts as TRUSTED parts and milestone notes as Envelopes. Findings
 *     are inputs, never a decision.
 *  5. recommendDossier (shared rule) → payout_dossiers row (service role,
 *     agent-owned) → POST …/dossiers/[id]/notify with the runtime credential.
 *
 * The agent never releases money and never sees the release route; the
 * founder's tap on /admin/payouts is the only thing that moves a payout.
 */

export interface PayoutDossierInput {
  orderId: string
  payoutId: string
}
export interface PayoutDossierOutput {
  dossierId: string
  recommendation: DossierRecommendation
  costPaise: number
}

interface Settings {
  maxPhotos: number
  hammingMax: number
}

interface PreparedPhoto {
  doc_id: string
  stage: string
  uploaded_at: string
  mime: string
  bytes: Buffer | null
  dataUrl: string | null
  signedUrl: string | null
  note: string | null
}

const MODEL_MAX_EDGE = 1024

async function readSettings(): Promise<Settings> {
  const { data } = await admin().from('agent_settings').select('key, value').in('key', ['dossier_max_photos', 'dossier_dup_hamming_max'])
  const rows = (data ?? []) as Array<{ key: string; value: unknown }>
  const num = (k: string, d: number, lo: number, hi: number) => {
    const v = rows.find((r) => r.key === k)?.value
    return typeof v === 'number' && Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : d
  }
  return { maxPhotos: num('dossier_max_photos', 6, 1, 12), hammingMax: num('dossier_dup_hamming_max', 6, 0, 20) }
}

/** Latest per milestone kind first (work_complete → … → accepted); goods delivery first. */
function selectPhotos(ev: OrderEvidence, max: number): PreparedPhoto[] {
  const out: PreparedPhoto[] = []
  if (ev.order.kind === 'goods') {
    const photos = [...(ev.goods_evidence?.photos ?? [])].sort((a, b) => (a.kind === 'delivery_photo' ? -1 : 1) - (b.kind === 'delivery_photo' ? -1 : 1))
    for (const p of photos) out.push({ doc_id: p.doc_id, stage: p.kind, uploaded_at: p.uploaded_at, mime: p.mime, bytes: null, dataUrl: null, signedUrl: p.signed_url, note: null })
  } else {
    const ms = [...ev.milestones].filter((m) => m.photo).sort((a, b) => MILESTONE_ORDER[b.kind] - MILESTONE_ORDER[a.kind])
    for (const m of ms) {
      const p = m.photo!
      out.push({ doc_id: p.doc_id, stage: m.kind, uploaded_at: p.uploaded_at, mime: p.mime, bytes: null, dataUrl: null, signedUrl: p.signed_url, note: m.note })
    }
  }
  return out.slice(0, max)
}

async function download(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
}

/** Re-encode for the model: ≤1024 px JPEG as a data URL (vendor-independent; no storage fetch from the vendor). */
async function toModelDataUrl(bytes: Buffer): Promise<string | null> {
  try {
    const out = await sharp(bytes).rotate().resize(MODEL_MAX_EDGE, MODEL_MAX_EDGE, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()
    return `data:image/jpeg;base64,${out.toString('base64')}`
  } catch {
    return null
  }
}

async function hashAndFindDuplicates(ev: OrderEvidence, photos: PreparedPhoto[], hammingMax: number): Promise<DuplicatePhoto[]> {
  const db = admin()
  const mine: Array<{ doc_id: string; dhash: string }> = []
  for (const p of photos) {
    if (!p.bytes) continue
    let h: string
    try {
      h = await dhashFromImage(p.bytes)
    } catch (e) {
      console.warn('[payout_dossier] dhash failed', p.doc_id, (e as Error).message)
      continue
    }
    if (!isValidDhash(h)) continue
    mine.push({ doc_id: p.doc_id, dhash: h })
    const { error } = await db.from('evidence_photo_hashes').upsert({ doc_id: p.doc_id, order_id: ev.order.id, provider_id: ev.order.provider_id, dhash: h }, { onConflict: 'doc_id' })
    if (error) console.warn('[payout_dossier] hash upsert failed', error.message)
  }
  if (mine.length === 0) return []
  // Prior hashes from OTHER orders of the same provider.
  const { data: prior } = await db.from('evidence_photo_hashes').select('doc_id, order_id, dhash').eq('provider_id', ev.order.provider_id).neq('order_id', ev.order.id).limit(2000)
  const dups: DuplicatePhoto[] = []
  for (const m of mine) {
    let best: { doc_id: string; distance: number } | null = null
    for (const p of (prior ?? []) as Array<{ doc_id: string; order_id: string; dhash: string }>) {
      if (!isValidDhash(p.dhash)) continue
      const d = hammingHex(m.dhash, p.dhash)
      if (d <= hammingMax && (!best || d < best.distance)) best = { doc_id: p.doc_id, distance: d }
    }
    if (best) dups.push({ doc_id: m.doc_id, prior_doc_id: best.doc_id, distance: best.distance })
  }
  return dups
}

export const payoutDossierAgent: AgentDefinition<PayoutDossierInput, PayoutDossierOutput> = {
  name: 'payout_dossier',
  persona: 'ops',
  async run(run, input) {
    // 1. The one read, under the delegated ops token. A 404 token exchange
    //    (AGENT_ENABLED off) or 403 (no ops grant) surfaces as agent_disabled /
    //    no_ops_grant from deps.mintRuntimeToken — terminal, never retried.
    const outcome = await run.proposeTool('read_order_evidence', { order_id: input.orderId })
    if (outcome.status !== 'done') throw new Error('unexpected_park')
    if (!outcome.result.ok) throw new Error(`evidence_read_failed:${outcome.result.status}`)
    const ev = orderEvidenceSchema.parse(outcome.result.body)
    if (ev.payout && ev.payout.id !== input.payoutId) console.warn('[payout_dossier] payout id differs from the trigger', ev.payout.id, input.payoutId)

    const settings = await readSettings()

    // 2/3. Photos: select, download, hash, duplicates.
    const photos = selectPhotos(ev, settings.maxPhotos)
    for (const p of photos) {
      if (!p.signedUrl) continue
      p.bytes = await download(p.signedUrl)
      if (p.bytes) p.dataUrl = await toModelDataUrl(p.bytes)
    }
    const duplicates = await hashAndFindDuplicates(ev, photos, settings.hammingMax)

    // 4. Vision — one call, only when there is something to look at.
    let findings: PhotoFinding[] = []
    if (photos.length > 0) {
      const prompt = getPrompt('photo_plausibility', 'v1')
      const trusted = [
        `Order category: ${ev.order.category_slug ?? 'unknown'}`,
        `Order title: ${ev.order.title}`,
        `Order kind: ${ev.order.kind}; placed ${ev.order.created_at}; completed ${ev.order.completed_at ?? 'not yet'}`,
        ...photos.map((p) => `Image ${p.doc_id}: claimed stage = ${p.stage}; uploaded ${p.uploaded_at}`),
      ]
      const untrusted: Envelope[] = photos.filter((p) => p.note && p.note.trim()).map((p) => envelope(p.note as string, { kind: 'milestone_note', id: p.doc_id }))
      const images: ChatImage[] = photos
        .filter((p) => !!(p.dataUrl ?? p.signedUrl))
        .map((p) => ({ url: (p.dataUrl ?? p.signedUrl) as string, mime: p.mime, label: p.doc_id }))
      const out = await run.callModel({
        taskClass: prompt.taskClass,
        prompt,
        schema: photoPlausibilitySchema,
        parts: { trusted, untrusted, images },
        feature: 'payout_dossier',
        // Stub producer (keyless / CI): every photo plausible.
        stub: () => ({
          findings: photos.map((p) => ({ doc_id: p.doc_id, looks_like_work: true, matches_stage: true, is_screenshot_or_document: false, concerns: [], confidence: 0.9 })),
        }),
      })
      // Reconcile: exactly one finding per photo; a photo the model skipped is a failing finding.
      const byId = new Map(out.findings.map((f) => [f.doc_id, f]))
      findings = photos.map(
        (p) =>
          byId.get(p.doc_id) ?? {
            doc_id: p.doc_id,
            looks_like_work: false,
            matches_stage: false,
            is_screenshot_or_document: false,
            concerns: ['no finding returned for this image'],
            confidence: 0,
          },
      )
    }

    // 5. Deterministic checks + the RULE.
    const { checks, anomalies } = computeDossierChecks({ evidence: ev, findings, duplicates })
    const rec = recommendDossier({ checks, findings, anomalies })

    // Cost so far (ledger counters on the run).
    const { data: runRow } = await admin().from('agent_runs').select('cost_est_paise').eq('id', run.runId).maybeSingle()
    const costPaise = Number((runRow as { cost_est_paise?: unknown } | null)?.cost_est_paise ?? 0)

    const { data: inserted, error } = await admin()
      .from('payout_dossiers')
      .insert({
        order_id: ev.order.id,
        payout_id: ev.payout?.id ?? input.payoutId,
        run_id: run.runId,
        kind: ev.order.kind,
        checks,
        anomalies,
        photo_findings: findings,
        recommendation: rec.recommendation,
        rationale: rec.rationale,
        model_cost_paise: costPaise,
      })
      .select('id')
      .single()
    if (error || !inserted) throw new Error(`dossier_write_failed:${error?.message ?? 'no row'}`)
    const dossierId = (inserted as { id: string }).id

    // 6. Tell the founder (idempotent on the web side; dispatch by notification kind).
    try {
      const cred = signRuntimeCredential(RUNTIME_ENV.RUNTIME_SECRET, { userId: run.userId, persona: run.persona, runId: run.runId })
      const res = await fetch(`${RUNTIME_ENV.API_URL}/api/v1/agent/admin/dossiers/${dossierId}/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `AMC-Runtime ${cred}` },
        body: '{}',
      })
      if (!res.ok) console.warn('[payout_dossier] notify ->', res.status)
      await res.text().catch(() => '')
    } catch (e) {
      console.warn('[payout_dossier] notify failed', (e as Error).message)
    }

    return { dossierId, recommendation: rec.recommendation, costPaise }
  },
}
