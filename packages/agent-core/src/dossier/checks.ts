import {
  MILESTONE_KINDS,
  MILESTONE_ORDER,
  duplicatePhotoAnomaly,
  photoFindingPasses,
  type DossierCheck,
  type DossierCheckName,
  type OrderEvidence,
  type PhotoFinding,
} from '@amclub/shared'

/**
 * Deterministic dossier checks (S1.4 §5a.2). Pure: evidence payload in,
 * checks + anomalies out. No model, no I/O. The Payout-Evidence agent runs
 * this on the /api/v1 evidence read; the verify script runs it on fixtures.
 * Every check is always emitted (ok or not) so recommendDossier never sees a
 * missing check on a healthy run.
 */

export interface DuplicatePhoto {
  doc_id: string
  prior_doc_id: string
  distance: number
}

export interface DossierCheckInputs {
  evidence: OrderEvidence
  /** Vision findings, already reconciled to one per photo sent. */
  findings: readonly PhotoFinding[]
  /** dHash near-duplicates against a DIFFERENT order of the same provider. */
  duplicates: readonly DuplicatePhoto[]
}

export interface DossierCheckResult {
  checks: DossierCheck[]
  anomalies: string[]
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : null
}

const CAPTURED = new Set(['captured', 'paid', 'authorized_captured'])
const OPEN_DISPUTE = new Set(['open', 'under_review'])

export function computeDossierChecks(input: DossierCheckInputs): DossierCheckResult {
  const { evidence: ev, findings, duplicates } = input
  const checks: DossierCheck[] = []
  const anomalies: string[] = []
  const push = (name: DossierCheckName, ok: boolean, detail: string | null = null) => checks.push({ name, ok, detail })

  const goods = ev.order.kind === 'goods'
  const ge = ev.goods_evidence

  // milestones_complete
  if (goods) {
    const have = { dispatched: !!ge?.dispatched_at, delivered_photo: !!ge?.delivered_photo_at, received: !!(ge?.buyer_received_at || ge?.auto_accepted_at) }
    const missing = Object.entries(have).filter(([, v]) => !v).map(([k]) => k)
    push('milestones_complete', missing.length === 0, missing.length ? `missing goods events: ${missing.join(', ')}` : 'dispatched, delivery photo, received')
  } else {
    const kinds = new Set(ev.milestones.map((m) => m.kind))
    const missing = MILESTONE_KINDS.filter((k) => !kinds.has(k))
    push('milestones_complete', missing.length === 0, missing.length ? `missing milestones: ${missing.join(', ')}` : `all ${MILESTONE_KINDS.length} milestones present`)
  }

  // work_complete_photo
  if (goods) {
    const deliveryPhotos = (ge?.photos ?? []).filter((p) => p.kind === 'delivery_photo')
    push('work_complete_photo', deliveryPhotos.length > 0, deliveryPhotos.length ? `${deliveryPhotos.length} delivery photo(s)` : 'no delivery photo')
  } else {
    const wc = ev.milestones.find((m) => m.kind === 'work_complete')
    push('work_complete_photo', !!wc?.photo, wc?.photo ? `work_complete photo ${wc.photo.doc_id}` : 'work_complete milestone has no photo')
  }

  // buyer_confirmed
  const confirmedAt = ev.order.completed_at ?? (goods ? (ge?.buyer_received_at ?? ge?.auto_accepted_at ?? null) : null)
  push('buyer_confirmed', !!confirmedAt, confirmedAt ? `confirmed ${confirmedAt}` : 'no buyer confirmation (completed_at null)')

  // amount_matches_accepted
  const captured = ev.payments.filter((p) => CAPTURED.has(p.status)).reduce((s, p) => s + p.amount_paise, 0)
  const capturedOk = captured === ev.order.total_paise
  const payoutOk = ev.payout ? ev.payout.amount_paise === ev.order.provider_earning_paise : false
  const acceptedOk = ev.accepted?.total_paise == null ? true : ev.accepted.total_paise === ev.order.total_paise
  const earningOk = ev.accepted?.provider_earning_paise == null ? true : ev.accepted.provider_earning_paise === ev.order.provider_earning_paise
  const amountOk = capturedOk && payoutOk && acceptedOk && earningOk
  push(
    'amount_matches_accepted',
    amountOk,
    `captured ${captured} vs total ${ev.order.total_paise}; payout ${ev.payout?.amount_paise ?? 'none'} vs earning ${ev.order.provider_earning_paise}` +
      (ev.accepted?.total_paise != null ? `; accepted total ${ev.accepted.total_paise}` : ''),
  )
  if (!amountOk) anomalies.push('amount_mismatch')

  // no_open_dispute
  const open = ev.disputes.filter((d) => OPEN_DISPUTE.has(d.status))
  push('no_open_dispute', open.length === 0, open.length ? `open dispute ${open.map((d) => d.id).join(', ')}` : 'no open dispute')
  if (open.length > 0) anomalies.push('dispute_open')

  // payout_is_held
  push('payout_is_held', ev.payout?.status === 'held', ev.payout ? `payout ${ev.payout.id} is ${ev.payout.status}` : 'no payout row')

  // provider_payout_ready
  const p = ev.provider
  const readyWhy: string[] = []
  if (!p.bank_verified) readyWhy.push('bank unverified')
  if (!p.route_account_present) readyWhy.push('no Route account')
  if (p.status !== 'active') readyWhy.push(`provider ${p.status}`)
  push('provider_payout_ready', readyWhy.length === 0, readyWhy.length ? readyWhy.join(', ') : 'bank verified, Route linked, provider active')

  // photos_plausible (every finding passes; a photo without a finding is the agent's job to synthesise)
  const failing = findings.filter((f) => !photoFindingPasses(f))
  push('photos_plausible', failing.length === 0, failing.length ? `${failing.length}/${findings.length} finding(s) fail thresholds` : `${findings.length} finding(s) pass`)

  // no_duplicate_photos
  push('no_duplicate_photos', duplicates.length === 0, duplicates.length ? duplicates.map((d) => `${d.doc_id}~${d.prior_doc_id} (${d.distance} bits)`).join('; ') : 'no re-used photos')
  for (const d of duplicates) anomalies.push(duplicatePhotoAnomaly(d.doc_id, d.prior_doc_id))

  // timeline_consistent
  const createdAt = ms(ev.order.created_at) ?? 0
  const problems: string[] = []
  let lastEvidenceAt = 0
  if (goods) {
    const seq = [
      ['dispatched', ms(ge?.dispatched_at)],
      ['delivered_photo', ms(ge?.delivered_photo_at)],
      ['received', ms(ge?.buyer_received_at ?? ge?.auto_accepted_at)],
    ] as const
    let prev = createdAt
    for (const [name, t] of seq) {
      if (t == null) continue
      if (t < prev) problems.push(`${name} before the previous step`)
      prev = Math.max(prev, t)
    }
    for (const ph of ge?.photos ?? []) lastEvidenceAt = Math.max(lastEvidenceAt, ms(ph.uploaded_at) ?? 0)
    if (ge?.delivered_photo_at) lastEvidenceAt = Math.max(lastEvidenceAt, ms(ge.delivered_photo_at) ?? 0)
  } else {
    const sorted = [...ev.milestones].sort((a, b) => MILESTONE_ORDER[a.kind] - MILESTONE_ORDER[b.kind])
    let prev = createdAt
    for (const m of sorted) {
      const t = ms(m.created_at)
      if (t == null) {
        problems.push(`${m.kind} has no timestamp`)
        continue
      }
      if (t < createdAt) problems.push(`${m.kind} before order created`)
      if (t < prev) problems.push(`${m.kind} out of order`)
      prev = Math.max(prev, t)
      if (m.photo) lastEvidenceAt = Math.max(lastEvidenceAt, ms(m.photo.uploaded_at) ?? t)
    }
  }
  const completedAt = ms(confirmedAt)
  if (completedAt != null && lastEvidenceAt > 0 && completedAt < lastEvidenceAt) {
    problems.push('completion before the last evidence photo')
    anomalies.push('completion_before_evidence')
  }
  push('timeline_consistent', problems.length === 0, problems.length ? problems.join('; ') : 'monotonic; completion after last photo')

  return { checks, anomalies }
}
