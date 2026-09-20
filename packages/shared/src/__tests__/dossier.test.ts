import { describe, expect, it } from 'vitest'
import {
  DOSSIER_CHECK_NAMES,
  PHOTO_CONFIDENCE_MIN,
  anomalyKind,
  duplicatePhotoAnomaly,
  orderEvidenceSchema,
  photoFindingFailures,
  photoPlausibilitySchema,
  recommendDossier,
  type DossierCheck,
  type PhotoFinding,
} from '../index'

/**
 * S1.4 — the recommendation is a RULE over checks + findings + anomalies. The
 * model's findings are inputs; nothing in a finding can flip an approve on its
 * own, and a missing check is a hold. These tables are what the runbook
 * (docs/agents/PAYOUT_DOSSIER.md) promises the founder.
 */

const allOk = (): DossierCheck[] => DOSSIER_CHECK_NAMES.map((name) => ({ name, ok: true, detail: null }))
const goodFinding = (over: Partial<PhotoFinding> = {}): PhotoFinding => ({
  doc_id: 'doc-1',
  looks_like_work: true,
  matches_stage: true,
  is_screenshot_or_document: false,
  concerns: [],
  confidence: 0.9,
  ...over,
})

describe('recommendDossier — table', () => {
  const cases: Array<{
    name: string
    checks: DossierCheck[]
    findings: PhotoFinding[]
    anomalies: string[]
    expect: 'approve' | 'hold'
    rationaleIncludes?: string[]
  }> = [
    { name: 'all checks ok, plausible photos, no anomalies → approve', checks: allOk(), findings: [goodFinding(), goodFinding({ doc_id: 'doc-2' })], anomalies: [], expect: 'approve' },
    { name: 'no photos at all (findings empty) still approves when checks say so', checks: allOk(), findings: [], anomalies: [], expect: 'approve' },
    {
      name: 'one failing check → hold, named',
      checks: allOk().map((c) => (c.name === 'work_complete_photo' ? { ...c, ok: false, detail: 'no photo' } : c)),
      findings: [goodFinding()],
      anomalies: [],
      expect: 'hold',
      rationaleIncludes: ['check:work_complete_photo'],
    },
    {
      name: 'a missing check → hold (never approve on an incomplete dossier)',
      checks: allOk().filter((c) => c.name !== 'amount_matches_accepted'),
      findings: [goodFinding()],
      anomalies: [],
      expect: 'hold',
      rationaleIncludes: ['check_missing:amount_matches_accepted'],
    },
    { name: 'an anomaly alone → hold', checks: allOk(), findings: [goodFinding()], anomalies: ['amount_mismatch'], expect: 'hold', rationaleIncludes: ['anomaly:amount_mismatch'] },
    { name: 'duplicate photo anomaly → hold', checks: allOk(), findings: [goodFinding()], anomalies: [duplicatePhotoAnomaly('doc-1', 'doc-9')], expect: 'hold', rationaleIncludes: ['anomaly:duplicate_photo:doc-1~doc-9'] },
    { name: 'finding: not work → hold', checks: allOk(), findings: [goodFinding({ looks_like_work: false })], anomalies: [], expect: 'hold', rationaleIncludes: ['photo:doc-1:not_work'] },
    { name: 'finding: stage mismatch → hold', checks: allOk(), findings: [goodFinding({ matches_stage: false })], anomalies: [], expect: 'hold', rationaleIncludes: ['photo:doc-1:stage_mismatch'] },
    { name: 'finding: screenshot/document → hold', checks: allOk(), findings: [goodFinding({ is_screenshot_or_document: true })], anomalies: [], expect: 'hold', rationaleIncludes: ['photo:doc-1:screenshot_or_document'] },
    { name: 'finding: low confidence (0.59) → hold', checks: allOk(), findings: [goodFinding({ confidence: 0.59 })], anomalies: [], expect: 'hold', rationaleIncludes: ['photo:doc-1:low_confidence'] },
    { name: 'finding: confidence exactly at the floor passes', checks: allOk(), findings: [goodFinding({ confidence: PHOTO_CONFIDENCE_MIN })], anomalies: [], expect: 'approve' },
    {
      name: 'one bad photo among good ones → hold (every photo must pass)',
      checks: allOk(),
      findings: [goodFinding(), goodFinding({ doc_id: 'doc-2', looks_like_work: false, confidence: 0.2 })],
      anomalies: [],
      expect: 'hold',
      rationaleIncludes: ['photo:doc-2:not_work', 'photo:doc-2:low_confidence'],
    },
    {
      name: 'a perfect finding cannot rescue a failing check (model cannot flip the rule)',
      checks: allOk().map((c) => (c.name === 'no_open_dispute' ? { ...c, ok: false, detail: 'dispute open' } : c)),
      findings: [goodFinding({ confidence: 1 })],
      anomalies: ['dispute_open'],
      expect: 'hold',
      rationaleIncludes: ['check:no_open_dispute', 'anomaly:dispute_open'],
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const r = recommendDossier({ checks: c.checks, findings: c.findings, anomalies: c.anomalies })
      expect(r.recommendation).toBe(c.expect)
      if (c.expect === 'approve') expect(r.rationale).toEqual([])
      else expect(r.rationale.length).toBeGreaterThan(0)
      for (const item of c.rationaleIncludes ?? []) expect(r.rationale).toContain(item)
    })
  }

  it('rationale lists checks first (in registry order), then anomalies, then photos', () => {
    const checks = allOk().map((c) => (c.name === 'buyer_confirmed' || c.name === 'timeline_consistent' ? { ...c, ok: false } : c))
    const r = recommendDossier({ checks, findings: [goodFinding({ matches_stage: false })], anomalies: ['completion_before_evidence'] })
    expect(r.rationale).toEqual(['check:buyer_confirmed', 'check:timeline_consistent', 'anomaly:completion_before_evidence', 'photo:doc-1:stage_mismatch'])
  })
})

describe('helpers + schemas', () => {
  it('photoFindingFailures enumerates every reason', () => {
    expect(photoFindingFailures(goodFinding())).toEqual([])
    expect(photoFindingFailures(goodFinding({ looks_like_work: false, matches_stage: false, is_screenshot_or_document: true, confidence: 0 }))).toEqual([
      'not_work',
      'stage_mismatch',
      'screenshot_or_document',
      'low_confidence',
    ])
  })

  it('anomalyKind classifies the known shapes and nothing else', () => {
    expect(anomalyKind('amount_mismatch')).toBe('amount_mismatch')
    expect(anomalyKind(duplicatePhotoAnomaly('a', 'b'))).toBe('duplicate_photo')
    expect(anomalyKind('made_up')).toBe('unknown')
  })

  it('photoPlausibilitySchema caps concerns at 5 and confidence to [0,1]', () => {
    expect(photoPlausibilitySchema.safeParse({ findings: [goodFinding({ concerns: ['a', 'b', 'c', 'd', 'e', 'f'] })] }).success).toBe(false)
    expect(photoPlausibilitySchema.safeParse({ findings: [goodFinding({ confidence: 1.2 })] }).success).toBe(false)
    const ok = photoPlausibilitySchema.parse({ findings: [{ doc_id: 'x', looks_like_work: true, matches_stage: true, is_screenshot_or_document: false, confidence: 0.7 }] })
    expect(ok.findings[0]?.concerns).toEqual([])
  })

  it('orderEvidenceSchema coerces paise (bigint arrives as string/number) and accepts the services shape', () => {
    const U = '00000000-0000-0000-0000-00000000000'
    const r = orderEvidenceSchema.safeParse({
      order: { id: `${U}1`, kind: 'service', status: 'completed', order_number: 'AMC-1', category_slug: 'tax-accounting', title: 'GST filing', created_at: '2026-09-01T00:00:00Z', completed_at: '2026-09-05T00:00:00Z', total_paise: '118000', provider_earning_paise: 95000, provider_id: `${U}2`, msme_id: `${U}3` },
      accepted: { source: 'package', price_paise: 100000, total_paise: 118000, commission_paise: 5000, provider_earning_paise: 95000 },
      payments: [{ id: `${U}4`, status: 'captured', amount_paise: '118000', captured_at: '2026-09-01T00:01:00Z' }],
      payout: { id: `${U}5`, status: 'held', amount_paise: 95000, scheduled_for: '2026-09-07' },
      provider: { id: `${U}2`, status: 'active', bank_verified: true, route_account_present: true },
      disputes: [],
      milestones: [{ kind: 'accepted', note: null, created_at: '2026-09-01T01:00:00Z', photo: null }],
      goods_evidence: null,
      events: [{ event: 'placed', created_at: '2026-09-01T00:00:00Z', actor_role: 'system' }],
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.order.total_paise).toBe(118000)
      expect(r.data.payments[0]?.amount_paise).toBe(118000)
    }
  })
})
