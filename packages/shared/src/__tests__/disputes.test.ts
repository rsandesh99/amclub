import { describe, expect, it } from 'vitest'
import {
  DISPUTE_TRIAGE_RECOMMENDATIONS,
  TRIAGE_CHECK_NAMES,
  clampTriage,
  disputeStatementSchema,
  disputeTriageSchema,
  partialBandLabel,
  stubTriage,
  triageAllowedRefs,
  triageCheck,
  triageDeterministicChecks,
  type DisputeTriage,
  type OrderEvidence,
} from '../index'

const U = (tail: string) => `00000000-0000-0000-0000-${tail.padStart(12, '0')}`

/** The S1.4 services fixture, reduced (kept in sync with agent-core/src/dossier/fixtures.ts). */
function services(): OrderEvidence {
  return {
    order: { id: U('1'), kind: 'service', status: 'disputed', order_number: 'AMC-KT-0001', category_slug: 'tax-accounting', title: 'GST filing', created_at: '2026-09-01T09:00:00Z', completed_at: null, total_paise: 118000, provider_earning_paise: 95000, provider_id: U('2'), msme_id: U('3') },
    accepted: { source: 'package', price_paise: 100000, total_paise: 118000, commission_paise: 5000, provider_earning_paise: 95000 },
    payments: [{ id: U('4'), status: 'captured', amount_paise: 118000, captured_at: '2026-09-01T09:01:00Z' }],
    payout: { id: U('5'), status: 'held', amount_paise: 95000, scheduled_for: '2026-09-07' },
    provider: { id: U('2'), status: 'active', bank_verified: true, route_account_present: true },
    disputes: [{ id: U('9'), status: 'open', reason: 'quality', opened_at: '2026-09-05T13:00:00Z' }],
    milestones: [
      { kind: 'accepted', note: null, created_at: '2026-09-01T10:00:00Z', photo: null },
      { kind: 'work_complete', note: 'Filed, ARN attached', created_at: '2026-09-04T09:00:00Z', photo: { doc_id: U('a3'), signed_url: null, mime: 'image/jpeg', uploaded_at: '2026-09-04T09:00:00Z' } },
    ],
    goods_evidence: null,
    events: [
      { event: 'placed', created_at: '2026-09-01T09:00:00Z', actor_role: 'system' },
      { event: 'deliver', created_at: '2026-09-04T10:00:00Z', actor_role: 'provider' },
      { event: 'raise_dispute', created_at: '2026-09-05T13:00:00Z', actor_role: 'msme' },
    ],
  }
}
function goods(): OrderEvidence {
  return {
    ...services(),
    order: { ...services().order, id: U('11'), kind: 'goods' },
    milestones: [],
    disputes: [{ id: U('19'), status: 'open', reason: 'damaged', opened_at: '2026-09-07T13:00:00Z' }],
    goods_evidence: {
      dispatched_at: '2026-09-02T09:00:00Z', delivered_photo_at: '2026-09-04T09:00:00Z', buyer_received_at: null, auto_accepted_at: null, return_opened_at: '2026-09-07T13:00:00Z', return_resolved_at: null, return_window_hours: 48,
      gate: { ok: true, reasons: [] },
      photos: [{ doc_id: U('b1'), kind: 'dispatch_photo', signed_url: null, mime: 'image/jpeg', uploaded_at: '2026-09-02T09:00:00Z' }, { doc_id: U('b2'), kind: 'delivery_photo', signed_url: null, mime: 'image/jpeg', uploaded_at: '2026-09-04T09:00:00Z' }],
    },
    events: [{ event: 'dispatched', created_at: '2026-09-02T09:00:00Z', actor_role: 'provider' }, { event: 'delivered_photo', created_at: '2026-09-04T09:00:00Z', actor_role: 'provider' }],
  }
}
const both = [{ role: 'buyer' as const }, { role: 'provider' as const }]
const TRIAGE: DisputeTriage = {
  timeline: [{ at: '2026-09-04T10:00:00Z', what: 'Provider marked delivered', ref: 'event:e1' }, { at: '2026-09-05T13:00:00Z', what: 'Buyer opened the dispute', ref: 'event:zzz' }],
  claims: [{ party: 'buyer', claim: 'The return was never filed.', evidence: [{ ref: 'milestone:work_complete', supports: 'contradicts' }, { ref: 'doc:unknown', supports: 'supports' }], assessment: 'contradicted' }],
  gaps: ['The ARN acknowledgement itself.'],
  recommendation: 'release',
  partial_band: null,
  rationale: ['The work-complete photo shows the filed return.'],
  confidence: 'high',
}

describe('statement schema', () => {
  it('needs 20..2000 chars and at most 5 document ids', () => {
    expect(disputeStatementSchema.safeParse({ body: 'too short' }).success).toBe(false)
    expect(disputeStatementSchema.safeParse({ body: 'x'.repeat(2001) }).success).toBe(false)
    expect(disputeStatementSchema.safeParse({ body: 'The work was delivered late and incomplete, see photos.' }).success).toBe(true)
    expect(disputeStatementSchema.safeParse({ body: 'The work was delivered late and incomplete, see photos.', document_ids: Array(6).fill(U('1')) }).success).toBe(false)
    expect(disputeStatementSchema.parse({ body: 'The work was delivered late and incomplete, see photos.' }).document_ids).toEqual([])
  })
})

describe('triage schema (strict)', () => {
  it('accepts a well-formed card and rejects amount / resolution / tool keys at every level', () => {
    expect(disputeTriageSchema.safeParse(TRIAGE).success).toBe(true)
    for (const extra of [{ amount_paise: 50000 }, { resolution: 'refund_full' }, { tool: 'resolve_dispute' }, { resolve: true }, { refund_paise: 1 }]) {
      expect(disputeTriageSchema.safeParse({ ...TRIAGE, ...extra }).success, JSON.stringify(extra)).toBe(false)
      expect(disputeTriageSchema.safeParse({ ...TRIAGE, claims: [{ ...TRIAGE.claims[0], ...extra }] }).success, `claim ${JSON.stringify(extra)}`).toBe(false)
    }
    expect(disputeTriageSchema.safeParse({ ...TRIAGE, rationale: [] }).success).toBe(false)
    expect(disputeTriageSchema.safeParse({ ...TRIAGE, recommendation: 'refund_all' }).success).toBe(false)
    expect(disputeTriageSchema.safeParse({ ...TRIAGE, partial_band: '0_10' }).success).toBe(false)
  })
  it('the recommendation enum has exactly the four classes, none of them an amount', () => {
    expect([...DISPUTE_TRIAGE_RECOMMENDATIONS]).toEqual(['refund_full', 'refund_partial', 'release', 'needs_more_info'])
  })
})

describe('triageDeterministicChecks', () => {
  it('returns every named check exactly once', () => {
    const names = triageDeterministicChecks(services(), both).map((c) => c.name)
    expect([...names].sort()).toEqual([...TRIAGE_CHECK_NAMES].sort())
  })
  it('services, both statements, delivered before the dispute, held payout → all ok', () => {
    const checks = triageDeterministicChecks(services(), both)
    expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([])
  })
  it('flags a missing statement per party', () => {
    const c = triageDeterministicChecks(services(), [{ role: 'buyer' }])
    expect(triageCheck(c, 'statement_missing_provider')?.ok).toBe(false)
    expect(triageCheck(c, 'statement_missing_buyer')?.ok).toBe(true)
  })
  it('flags no work-complete photo (services) and no delivery photo (goods)', () => {
    const s = services()
    s.milestones = s.milestones.map((m) => (m.kind === 'work_complete' ? { ...m, photo: null } : m))
    expect(triageCheck(triageDeterministicChecks(s, both), 'no_work_complete_photo')?.ok).toBe(false)
    const g = goods()
    g.goods_evidence!.photos = g.goods_evidence!.photos.filter((p) => p.kind !== 'delivery_photo')
    expect(triageCheck(triageDeterministicChecks(g, both), 'no_work_complete_photo')?.ok).toBe(false)
  })
  it('delivered_before_dispute uses the deliver event (services) or delivered_photo_at (goods)', () => {
    const s = services()
    s.events = s.events.filter((e) => e.event !== 'deliver')
    s.milestones = []
    expect(triageCheck(triageDeterministicChecks(s, both), 'delivered_before_dispute')?.ok).toBe(false)
    expect(triageCheck(triageDeterministicChecks(goods(), both), 'delivered_before_dispute')?.ok).toBe(true)
  })
  it('dispute_after_auto_accept, payout_already_paid, refund_already_exists, duplicate_photo_flag', () => {
    const s = services()
    s.events.push({ event: 'auto_accepted', created_at: '2026-09-05T12:00:00Z', actor_role: 'system' })
    s.payout = { ...s.payout!, status: 'paid' }
    const c = triageDeterministicChecks(s, both, { refundExists: true, duplicatePhotos: 2 })
    expect(triageCheck(c, 'dispute_after_auto_accept')?.ok).toBe(false)
    expect(triageCheck(c, 'payout_already_paid')?.ok).toBe(false)
    expect(triageCheck(c, 'refund_already_exists')?.ok).toBe(false)
    expect(triageCheck(c, 'duplicate_photo_flag')?.detail).toContain('2 evidence photo')
  })
  it('goods_return_window_expired when the return opened after delivered_photo_at + window', () => {
    expect(triageCheck(triageDeterministicChecks(goods(), both), 'goods_return_window_expired')?.ok).toBe(false)
    const g = goods()
    g.disputes = [{ ...g.disputes[0]!, opened_at: '2026-09-05T09:00:00Z' }]
    expect(triageCheck(triageDeterministicChecks(g, both), 'goods_return_window_expired')?.ok).toBe(true)
  })
  it('extras.disputeOpenedAt overrides the evidence dispute time', () => {
    const c = triageDeterministicChecks(services(), both, { disputeOpenedAt: '2026-09-03T00:00:00Z' })
    expect(triageCheck(c, 'delivered_before_dispute')?.ok).toBe(false)
  })
})

describe('clampTriage', () => {
  const allowed = triageAllowedRefs({ eventIds: ['e1'], milestoneKinds: ['work_complete'], docIds: [], statementIds: ['s1', 's2'], messageIds: [] })
  it('builds the allow-list in the ref grammar', () => {
    expect(allowed).toEqual(['event:e1', 'milestone:work_complete', 'statement:s1', 'statement:s2'])
  })
  it('keeps a release with both statements and high confidence; drops refs outside the allow-list', () => {
    const out = clampTriage(TRIAGE, triageDeterministicChecks(services(), both), allowed)
    expect(out.recommendation).toBe('release')
    expect(out.partial_band).toBeNull()
    expect(out.claims[0]!.evidence.map((e) => e.ref)).toEqual(['milestone:work_complete'])
    expect(out.timeline.map((e) => e.ref)).toEqual(['event:e1'])
  })
  it('forces needs_more_info when a statement is missing, with a rationale line first', () => {
    const out = clampTriage(TRIAGE, triageDeterministicChecks(services(), [{ role: 'buyer' }]), allowed)
    expect(out.recommendation).toBe('needs_more_info')
    expect(out.rationale[0]).toMatch(/not stated their side/)
    expect(out.partial_band).toBeNull()
  })
  it('forces needs_more_info on low confidence', () => {
    expect(clampTriage({ ...TRIAGE, confidence: 'low' }, triageDeterministicChecks(services(), both), allowed).recommendation).toBe('needs_more_info')
  })
  it('partial_band only with refund_partial (defaulting to 30_50); nulled otherwise', () => {
    const checks = triageDeterministicChecks(services(), both)
    expect(clampTriage({ ...TRIAGE, recommendation: 'refund_partial', partial_band: null }, checks, allowed).partial_band).toBe('30_50')
    expect(clampTriage({ ...TRIAGE, recommendation: 'refund_partial', partial_band: '70_90' }, checks, allowed).partial_band).toBe('70_90')
    expect(clampTriage({ ...TRIAGE, recommendation: 'refund_full', partial_band: '30_50' }, checks, allowed).partial_band).toBeNull()
  })
  it('surfaces a paid payout / existing refund as a rationale note and keeps at most 5 lines', () => {
    const s = services()
    s.payout = { ...s.payout!, status: 'paid' }
    const out = clampTriage({ ...TRIAGE, rationale: ['a', 'b', 'c', 'd', 'e'] }, triageDeterministicChecks(s, both, { refundExists: true }), allowed)
    expect(out.rationale.length).toBe(5)
    expect(out.rationale.join(' ')).toMatch(/already paid/)
  })
  it('the clamped output still satisfies the strict schema', () => {
    const out = clampTriage({ ...TRIAGE, recommendation: 'refund_partial', partial_band: null, confidence: 'low' }, triageDeterministicChecks(services(), [{ role: 'buyer' }]), allowed)
    expect(disputeTriageSchema.safeParse(out).success).toBe(true)
  })
})

describe('stubTriage', () => {
  it('needs_more_info when a statement is missing; release when delivered + complete; refund_partial 30_50 otherwise', () => {
    const refs = { statementRefs: ['statement:s1'], deliveryRef: 'event:e1', openedAt: '2026-09-05T13:00:00Z' }
    expect(stubTriage(triageDeterministicChecks(services(), [{ role: 'buyer' }]), refs).recommendation).toBe('needs_more_info')
    const full = stubTriage(triageDeterministicChecks(services(), both), { ...refs, statementRefs: ['statement:s1', 'statement:s2'] })
    expect(full.recommendation).toBe('release')
    expect(disputeTriageSchema.safeParse(full).success).toBe(true)
    const s = services()
    s.milestones = []
    s.events = s.events.filter((e) => e.event !== 'deliver')
    const partial = stubTriage(triageDeterministicChecks(s, both), { ...refs, deliveryRef: null, statementRefs: ['statement:s1', 'statement:s2'] })
    expect(partial.recommendation).toBe('refund_partial')
    expect(partial.partial_band).toBe('30_50')
  })
  it('band labels are percent ranges, never rupees', () => {
    expect(partialBandLabel('30_50')).toBe('30–50 %')
  })
})
