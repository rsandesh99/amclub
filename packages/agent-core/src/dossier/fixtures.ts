import type { OrderEvidence } from '@amclub/shared'

/**
 * Evidence payload fixtures (S1.4). Shared by the agent-core unit tests and
 * apps/web/scripts/verify-payout-dossier.ts (OFFLINE mode) so both prove the
 * same table. Every id is a NIL-prefixed kill-test uuid; nothing here is real.
 */

const U = (tail: string) => `00000000-0000-0000-0000-${tail.padStart(12, '0')}`

export function servicesEvidenceFixture(): OrderEvidence {
  return {
    order: {
      id: U('1'),
      kind: 'service',
      status: 'completed',
      order_number: 'AMC-KT-0001',
      category_slug: 'tax-accounting',
      title: 'GST filing (kill-test)',
      created_at: '2026-09-01T09:00:00Z',
      completed_at: '2026-09-05T12:00:00Z',
      total_paise: 118000,
      provider_earning_paise: 95000,
      provider_id: U('2'),
      msme_id: U('3'),
    },
    accepted: { source: 'package', price_paise: 100000, total_paise: 118000, commission_paise: 5000, provider_earning_paise: 95000 },
    payments: [{ id: U('4'), status: 'captured', amount_paise: 118000, captured_at: '2026-09-01T09:01:00Z' }],
    payout: { id: U('5'), status: 'held', amount_paise: 95000, scheduled_for: '2026-09-07' },
    provider: { id: U('2'), status: 'active', bank_verified: true, route_account_present: true },
    disputes: [],
    milestones: [
      { kind: 'accepted', note: null, created_at: '2026-09-01T10:00:00Z', photo: null },
      { kind: 'site_or_materials', note: 'Reached client office', created_at: '2026-09-02T09:00:00Z', photo: { doc_id: U('a1'), signed_url: null, mime: 'image/jpeg', uploaded_at: '2026-09-02T09:00:00Z' } },
      { kind: 'in_progress', note: null, created_at: '2026-09-03T09:00:00Z', photo: { doc_id: U('a2'), signed_url: null, mime: 'image/jpeg', uploaded_at: '2026-09-03T09:00:00Z' } },
      { kind: 'work_complete', note: 'Filed, ARN attached', created_at: '2026-09-04T09:00:00Z', photo: { doc_id: U('a3'), signed_url: null, mime: 'image/jpeg', uploaded_at: '2026-09-04T09:00:00Z' } },
    ],
    goods_evidence: null,
    events: [
      { event: 'placed', created_at: '2026-09-01T09:00:00Z', actor_role: 'system' },
      { event: 'accept', created_at: '2026-09-01T10:00:00Z', actor_role: 'provider' },
      { event: 'deliver', created_at: '2026-09-04T10:00:00Z', actor_role: 'provider' },
      { event: 'accept_delivery', created_at: '2026-09-05T12:00:00Z', actor_role: 'msme' },
      { event: 'payout_held', created_at: '2026-09-05T12:00:01Z', actor_role: 'system' },
    ],
  }
}

export function goodsEvidenceFixture(): OrderEvidence {
  return {
    order: {
      id: U('11'),
      kind: 'goods',
      status: 'completed',
      order_number: 'AMC-KT-0011',
      category_slug: 'packaging',
      title: 'Corrugated boxes ×500 (kill-test)',
      created_at: '2026-09-01T09:00:00Z',
      completed_at: '2026-09-06T12:00:00Z',
      total_paise: 59000,
      provider_earning_paise: 47500,
      provider_id: U('12'),
      msme_id: U('13'),
    },
    accepted: { source: 'quote', price_paise: 50000, total_paise: 59000, commission_paise: 2500, provider_earning_paise: 47500 },
    payments: [{ id: U('14'), status: 'captured', amount_paise: 59000, captured_at: '2026-09-01T09:01:00Z' }],
    payout: { id: U('15'), status: 'held', amount_paise: 47500, scheduled_for: '2026-09-08' },
    provider: { id: U('12'), status: 'active', bank_verified: true, route_account_present: true },
    disputes: [],
    milestones: [],
    goods_evidence: {
      dispatched_at: '2026-09-02T09:00:00Z',
      delivered_photo_at: '2026-09-04T09:00:00Z',
      buyer_received_at: '2026-09-06T12:00:00Z',
      auto_accepted_at: null,
      return_opened_at: null,
      return_resolved_at: null,
      return_window_hours: 48,
      gate: { ok: true, reasons: [] },
      photos: [
        { doc_id: U('b1'), kind: 'dispatch_photo', signed_url: null, mime: 'image/jpeg', uploaded_at: '2026-09-02T09:00:00Z' },
        { doc_id: U('b2'), kind: 'delivery_photo', signed_url: null, mime: 'image/jpeg', uploaded_at: '2026-09-04T09:00:00Z' },
      ],
    },
    events: [
      { event: 'placed', created_at: '2026-09-01T09:00:00Z', actor_role: 'system' },
      { event: 'dispatched', created_at: '2026-09-02T09:00:00Z', actor_role: 'provider' },
      { event: 'delivered_photo', created_at: '2026-09-04T09:00:00Z', actor_role: 'provider' },
      { event: 'buyer_received', created_at: '2026-09-06T12:00:00Z', actor_role: 'msme' },
      { event: 'payout_held', created_at: '2026-09-06T12:00:01Z', actor_role: 'system' },
    ],
  }
}
