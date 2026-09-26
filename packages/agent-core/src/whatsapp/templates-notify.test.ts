import { describe, expect, it } from 'vitest'
import { NOTIFICATION_KINDS, isNotificationKind } from '@amclub/shared'
import { NOTIFY_TEMPLATES } from './templates-notify'

/** ADR-030 §4 — the notification templates are submittable as written: Meta's body rules, our link rule, utility only. */

const SAMPLE = {
  title: 'Title', body: 'Body text.', link: 'https://amclub.in/app/orders/1', path: 'app/orders/1', ref: 'AMC-1001', amount: '₹1,234.56',
  payout: '₹900.00', deadline: '27 Sept, 9:00 pm IST', count: '3', hours: '11', reason: 'GST certificate is unreadable', reasons: 'the buyer has not confirmed the delivery yet',
  members: '4', qty: '120', unit: 'kg', transfer: 'trf_123',
}
const PROMOTIONAL = /\b(offer|discount|sale|free|deal|cashback|coupon|best price|limited time|hurry|win)\b/i

function placeholders(body: string): number[] {
  return [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]))
}

describe('NOTIFY_TEMPLATES', () => {
  const entries = Object.entries(NOTIFY_TEMPLATES)

  it('covers only registered notification kinds that go on WhatsApp', () => {
    expect(entries.length).toBeGreaterThan(0)
    for (const [kind] of entries) {
      expect(isNotificationKind(kind), kind).toBe(true)
      if (isNotificationKind(kind)) expect(NOTIFICATION_KINDS[kind].defaultChannels, kind).toContain('whatsapp')
    }
  })

  it('every new WhatsApp kind of the notification work has a template', () => {
    for (const kind of [
      'order_auto_accepted', 'goods_dispatched', 'goods_delivered', 'dispute_resolved', 'order_duplicate_payment', 'payment_refunded_no_order',
      'pool_met', 'pool_unmet', 'pool_cancelled', 'pool_met_seller', 'pool_ordered', 'payout_held', 'refund_processed', 'refund_failed',
      'rfq_digest', 'quote_withdrawn', 'order_accept_reminder', 'order_review_reminder', 'rfq_expiring_reminder', 'pool_pay_reminder',
      'provider_verified', 'provider_rejected', 'provider_needs_info',
    ]) {
      expect(NOTIFY_TEMPLATES[kind], kind).toBeDefined()
    }
  })

  it.each(entries)('%s: utility, en/hi/te/ta bodies, numbered parameters matching params()', (kind, spec) => {
    expect(spec.category).toBe('utility')
    expect(spec.stem).toBe(`amc_${kind}`)
    expect(spec.locales).toEqual(['en', 'hi', 'te', 'ta'])
    const params = spec.params(SAMPLE)
    expect(params.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 1024)).toBe(true)
    for (const locale of spec.locales) {
      const body = spec.body[locale]
      expect(body, `${kind}.${locale}`).toBeTruthy()
      // {{1}}, {{2}} … each once, in that order in every language.
      expect(placeholders(body!), `${kind}.${locale} placeholders`).toEqual(params.map((_, i) => i + 1))
      // Meta refuses a body that starts or ends with a parameter.
      expect(/^\s*\{\{\d+\}\}/.test(body!), `${kind}.${locale} starts with a parameter`).toBe(false)
      expect(/\{\{\d+\}\}\s*$/.test(body!), `${kind}.${locale} ends with a parameter`).toBe(false)
      expect(body!.length).toBeLessThanOrEqual(1024)
    }
    expect(PROMOTIONAL.test(spec.body.en), `${kind} reads as marketing`).toBe(false)
  })

  it.each(entries)('%s: the URL button opens a path on our own domain', (_kind, spec) => {
    expect(spec.urlButton).toBeDefined()
    const suffix = spec.urlButton!.suffix(SAMPLE)
    expect(suffix).toBe('app/orders/1')
    expect(spec.urlButton!.suffix({ ...SAMPLE, path: null })).toBeNull()
    for (const label of Object.values(spec.urlButton!.label)) expect([...String(label)].length).toBeLessThanOrEqual(25)
  })
})
