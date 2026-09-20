import { describe, expect, it } from 'vitest'
import { recommendDossier, type OrderEvidence, type PhotoFinding } from '@amclub/shared'
import { computeDossierChecks } from './checks'
import { goodsEvidenceFixture, servicesEvidenceFixture } from './fixtures'

/**
 * S1.4 §7 OFFLINE table: checks() on fixture evidence payloads. all-good →
 * approve; missing work_complete photo → hold; amount mismatch → hold; open
 * dispute → hold; duplicate photo → hold; screenshot finding → hold. Plus the
 * goods shape and the timeline anomaly.
 */

const okFinding = (doc_id: string): PhotoFinding => ({ doc_id, looks_like_work: true, matches_stage: true, is_screenshot_or_document: false, concerns: [], confidence: 0.9 })
const findingsFor = (ev: OrderEvidence): PhotoFinding[] => [
  ...ev.milestones.filter((m) => m.photo).map((m) => okFinding(m.photo!.doc_id)),
  ...(ev.goods_evidence?.photos ?? []).map((p) => okFinding(p.doc_id)),
]
const run = (ev: OrderEvidence, over: { findings?: PhotoFinding[]; duplicates?: { doc_id: string; prior_doc_id: string; distance: number }[] } = {}) => {
  const r = computeDossierChecks({ evidence: ev, findings: over.findings ?? findingsFor(ev), duplicates: over.duplicates ?? [] })
  return { ...r, rec: recommendDossier({ checks: r.checks, findings: over.findings ?? findingsFor(ev), anomalies: r.anomalies }) }
}
const failing = (r: ReturnType<typeof run>) => r.checks.filter((c) => !c.ok).map((c) => c.name)

describe('computeDossierChecks — services', () => {
  it('all-good → every check ok → approve', () => {
    const r = run(servicesEvidenceFixture())
    expect(r.checks).toHaveLength(10)
    expect(failing(r)).toEqual([])
    expect(r.anomalies).toEqual([])
    expect(r.rec.recommendation).toBe('approve')
  })

  it('missing work_complete photo → hold', () => {
    const ev = servicesEvidenceFixture()
    ev.milestones = ev.milestones.map((m) => (m.kind === 'work_complete' ? { ...m, photo: null } : m))
    const r = run(ev)
    expect(failing(r)).toEqual(['work_complete_photo'])
    expect(r.rec.recommendation).toBe('hold')
    expect(r.rec.rationale).toContain('check:work_complete_photo')
  })

  it('missing a milestone entirely → milestones_complete fails', () => {
    const ev = servicesEvidenceFixture()
    ev.milestones = ev.milestones.filter((m) => m.kind !== 'in_progress')
    const r = run(ev)
    expect(failing(r)).toContain('milestones_complete')
    expect(r.checks.find((c) => c.name === 'milestones_complete')?.detail).toMatch(/in_progress/)
  })

  it('amount mismatch (captured != total) → hold + anomaly', () => {
    const ev = servicesEvidenceFixture()
    ev.payments = [{ ...ev.payments[0]!, amount_paise: ev.order.total_paise - 100 }]
    const r = run(ev)
    expect(failing(r)).toEqual(['amount_matches_accepted'])
    expect(r.anomalies).toEqual(['amount_mismatch'])
    expect(r.rec.recommendation).toBe('hold')
  })

  it('payout amount != provider earning → amount check fails', () => {
    const ev = servicesEvidenceFixture()
    ev.payout = { ...ev.payout!, amount_paise: ev.order.provider_earning_paise + 1 }
    expect(failing(run(ev))).toEqual(['amount_matches_accepted'])
  })

  it('open dispute → hold + anomaly', () => {
    const ev = servicesEvidenceFixture()
    ev.disputes = [{ id: '00000000-0000-0000-0000-0000000000d1', status: 'open', reason: 'quality', opened_at: '2026-09-06T00:00:00Z' }]
    const r = run(ev)
    expect(failing(r)).toEqual(['no_open_dispute'])
    expect(r.anomalies).toEqual(['dispute_open'])
    expect(r.rec.recommendation).toBe('hold')
  })

  it('duplicate photo (same provider, other order) → hold + anomaly', () => {
    const ev = servicesEvidenceFixture()
    const doc = ev.milestones.find((m) => m.kind === 'work_complete')!.photo!.doc_id
    const r = run(ev, { duplicates: [{ doc_id: doc, prior_doc_id: '00000000-0000-0000-0000-0000000000aa', distance: 3 }] })
    expect(failing(r)).toEqual(['no_duplicate_photos'])
    expect(r.anomalies).toEqual([`duplicate_photo:${doc}~00000000-0000-0000-0000-0000000000aa`])
    expect(r.rec.recommendation).toBe('hold')
  })

  it('screenshot finding → photos_plausible fails → hold', () => {
    const ev = servicesEvidenceFixture()
    const f = findingsFor(ev)
    f[0] = { ...f[0]!, is_screenshot_or_document: true, concerns: ['screenshot of an app'] }
    const r = run(ev, { findings: f })
    expect(failing(r)).toEqual(['photos_plausible'])
    expect(r.rec.recommendation).toBe('hold')
    expect(r.rec.rationale).toContain(`photo:${f[0]!.doc_id}:screenshot_or_document`)
  })

  it('payout not held / provider not ready / no confirmation each fail their check', () => {
    const ev = servicesEvidenceFixture()
    ev.payout = { ...ev.payout!, status: 'scheduled' }
    ev.provider = { ...ev.provider, route_account_present: false }
    ev.order = { ...ev.order, completed_at: null }
    const r = run(ev)
    expect(failing(r)).toEqual(expect.arrayContaining(['payout_is_held', 'provider_payout_ready', 'buyer_confirmed']))
  })

  it('completion before the last evidence photo → timeline fails + anomaly', () => {
    const ev = servicesEvidenceFixture()
    ev.order = { ...ev.order, completed_at: '2026-09-02T00:00:00Z' } // before the work_complete photo
    const r = run(ev)
    expect(failing(r)).toEqual(['timeline_consistent'])
    expect(r.anomalies).toEqual(['completion_before_evidence'])
  })

  it('a milestone timestamped before the order was created fails the timeline', () => {
    const ev = servicesEvidenceFixture()
    ev.milestones = ev.milestones.map((m) => (m.kind === 'accepted' ? { ...m, created_at: '2026-08-01T00:00:00Z' } : m))
    expect(failing(run(ev))).toEqual(['timeline_consistent'])
  })
})

describe('computeDossierChecks — goods', () => {
  it('all-good goods dossier → approve', () => {
    const r = run(goodsEvidenceFixture())
    expect(failing(r)).toEqual([])
    expect(r.rec.recommendation).toBe('approve')
  })

  it('goods without a delivery photo → milestones + photo checks fail', () => {
    const ev = goodsEvidenceFixture()
    ev.goods_evidence = { ...ev.goods_evidence!, delivered_photo_at: null, photos: ev.goods_evidence!.photos.filter((p) => p.kind !== 'delivery_photo') }
    const r = run(ev)
    expect(failing(r)).toEqual(expect.arrayContaining(['milestones_complete', 'work_complete_photo']))
  })
})
