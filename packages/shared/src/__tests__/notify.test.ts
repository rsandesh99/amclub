import { describe, expect, it } from 'vitest'
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_NAMES,
  OUTBOX_MAX_ATTEMPTS,
  PREFERENCE_CHANNELS,
  categoryDefault,
  channelsFor,
  deferUntil,
  effectivePreferences,
  enabledChannels,
  essentialCategories,
  essentialCategoriesWithoutChannel,
  hhmmToMinutes,
  kindSpec,
  minutesToHhmm,
  nextDigestAt,
  notificationSettingsSchema,
  outboxKey,
  outboxRetryAt,
  planChannels,
  quietWindowOf,
  type NotificationPreference,
  type NotifySettingsRow,
} from '../notify'

const off = (category: NotificationPreference['category'], channel: NotificationPreference['channel']): NotificationPreference => ({ category, channel, enabled: false })

describe('NOTIFICATION_KINDS (ADR-030 §4)', () => {
  it('every money and deadline kind is essential', () => {
    for (const k of ['order_placed', 'order_delivered', 'order_auto_cancelled', 'dispute_resolved', 'payout_paid', 'payout_held', 'refund_processed', 'refund_failed', 'order_accept_reminder', 'order_review_reminder', 'rfq_expiring_reminder', 'pool_pay_reminder', 'pool_met', 'goods_delivered'] as const) {
      expect(NOTIFICATION_KINDS[k].essential, k).toBe(true)
    }
  })
  it('provider leads are requests and support the digest; assistant kinds need the assistant purpose', () => {
    expect(NOTIFICATION_KINDS.rfq_matched.category).toBe('requests')
    expect(kindSpec('rfq_matched').digest).toBe(true)
    for (const k of ['munshi_window_warning', 'munshi_growth', 'munshi_draft_ready', 'dispute_triage_ready', 'payout_dossier_ready'] as const) {
      expect(NOTIFICATION_KINDS[k].category, k).toBe('assistant')
      expect(NOTIFICATION_KINDS[k].waPurpose, k).toBe('assistant')
    }
  })
  it('no kind uses marketing or the updates category; SMS listed beside WhatsApp is a fallback', () => {
    for (const k of NOTIFICATION_KIND_NAMES) {
      const s = NOTIFICATION_KINDS[k]
      expect(s.waPurpose, k).not.toBe('marketing')
      expect(s.category, k).not.toBe('updates')
      if (s.defaultChannels.includes('sms') && s.defaultChannels.includes('whatsapp')) expect(s.smsFallbackOnly, k).toBe(true)
      expect(s.defaultChannels.includes('push'), k).toBe(false)
    }
  })
  it('the buyer receipt, the new-quote notice and order_delivered go on WhatsApp by default', () => {
    for (const k of ['order_placed', 'order_delivered', 'rfq_new_quote', 'quote_revised', 'quote_withdrawn'] as const) {
      expect(NOTIFICATION_KINDS[k].defaultChannels, k).toContain('whatsapp')
      expect(NOTIFICATION_KINDS[k].defaultChannels, k).toContain('email')
    }
  })
  it('an unknown kind is in-app only', () => {
    const s = kindSpec('no_such_kind')
    expect(s.defaultChannels).toEqual([])
    expect(channelsFor(s, [], true, true)).toEqual([])
    expect(enabledChannels(s, [{ category: s.category, channel: 'whatsapp', enabled: true }])).toEqual([])
  })
})

describe('channelsFor / planChannels', () => {
  const quote = kindSpec('rfq_new_quote')
  const payout = kindSpec('payout_paid')
  it('the registry decides with no preference rows', () => {
    expect(channelsFor(quote, [], true, true)).toEqual(['email', 'sms', 'whatsapp'])
    expect(planChannels(quote, [], true, true)).toEqual({ now: ['email', 'whatsapp'], fallback: ['sms'] })
  })
  it('a preference turns WhatsApp off for the category', () => {
    const prefs = [off('requests', 'whatsapp')]
    expect(channelsFor(quote, prefs, true, true)).toEqual(['email', 'sms'])
    // no WhatsApp to fall back from → SMS goes at once
    expect(planChannels(quote, prefs, true, true)).toEqual({ now: ['email', 'sms'], fallback: [] })
  })
  it('reachability: no phone → no SMS / WhatsApp; no email → no email', () => {
    expect(channelsFor(quote, [], true, false)).toEqual(['email'])
    expect(channelsFor(quote, [], false, true)).toEqual(['sms', 'whatsapp'])
  })
  it('the essential floor keeps email, else SMS, when every channel is off', () => {
    const allOff = [off('payments', 'whatsapp'), off('payments', 'email'), off('payments', 'sms')]
    expect(channelsFor(payout, allOff, true, true)).toEqual(['email'])
    expect(channelsFor(payout, allOff, false, true)).toEqual(['sms'])
    expect(channelsFor(payout, allOff, false, false)).toEqual([])
    // a non-essential kind may go silent
    expect(channelsFor(quote, [off('requests', 'whatsapp'), off('requests', 'email'), off('requests', 'sms')], true, true)).toEqual([])
  })
  it('an essential kind with WhatsApp alone falls back to SMS and email', () => {
    const waOnly = [off('payments', 'email'), off('payments', 'sms')]
    expect(planChannels(payout, waOnly, true, true)).toEqual({ now: ['whatsapp'], fallback: ['sms', 'email'] })
    expect(planChannels(payout, [], true, true)).toEqual({ now: ['email', 'whatsapp'], fallback: ['sms'] })
  })
  it('a user may switch a channel on that the kind does not default to', () => {
    const s = kindSpec('review_prompt')
    expect(channelsFor(s, [{ category: 'orders', channel: 'whatsapp', enabled: true }], true, true)).toEqual(['email', 'whatsapp'])
  })
})

describe('quiet hours, pause and the digest (IST)', () => {
  const nonUrgent = { urgent: false }
  const urgent = { urgent: true }
  it('no settings row = the default 21:00–08:00; a row with nulls = none', () => {
    expect(quietWindowOf(null)).toEqual({ start: '21:00', end: '08:00' })
    expect(quietWindowOf({ quiet_start_min: null, quiet_end_min: null, paused_until: null, digest_leads: false })).toBeNull()
    expect(quietWindowOf({ quiet_start_min: 1320, quiet_end_min: 420, paused_until: null, digest_leads: false })).toEqual({ start: '22:00', end: '07:00' })
    expect(minutesToHhmm(hhmmToMinutes('21:30'))).toBe('21:30')
  })
  it('defers a non-urgent WhatsApp inside quiet hours to 08:00 IST, never an urgent one or an email', () => {
    const at = new Date('2026-09-26T17:00:00Z') // 22:30 IST
    expect(deferUntil(at, null, nonUrgent, 'whatsapp')?.toISOString()).toBe('2026-09-27T02:30:00.000Z')
    expect(deferUntil(at, null, urgent, 'whatsapp')).toBeNull()
    expect(deferUntil(at, null, nonUrgent, 'email')).toBeNull()
    expect(deferUntil(new Date('2026-09-26T06:30:00Z'), null, nonUrgent, 'whatsapp')).toBeNull() // 12:00 IST
  })
  it('a pause holds every channel of a non-urgent kind, then quiet hours at that moment', () => {
    const at = new Date('2026-09-26T06:30:00Z')
    const row: NotifySettingsRow = { quiet_start_min: null, quiet_end_min: null, paused_until: '2026-09-28T06:30:00Z', digest_leads: false }
    expect(deferUntil(at, row, nonUrgent, 'email')?.toISOString()).toBe('2026-09-28T06:30:00.000Z')
    expect(deferUntil(at, row, urgent, 'email')).toBeNull()
    const nightEnd: NotifySettingsRow = { quiet_start_min: 1260, quiet_end_min: 480, paused_until: '2026-09-28T17:00:00Z', digest_leads: false }
    expect(deferUntil(at, nightEnd, nonUrgent, 'sms')?.toISOString()).toBe('2026-09-29T02:30:00.000Z')
  })
  it('the lead digest goes at the next 09:00 IST', () => {
    expect(nextDigestAt(new Date('2026-09-26T06:30:00Z')).toISOString()).toBe('2026-09-27T03:30:00.000Z') // 12:00 IST → next day
    expect(nextDigestAt(new Date('2026-09-26T02:00:00Z')).toISOString()).toBe('2026-09-26T03:30:00.000Z') // 07:30 IST → same day
    expect(nextDigestAt(new Date('2026-09-26T03:30:00Z')).toISOString()).toBe('2026-09-27T03:30:00.000Z') // exactly 09:00 → tomorrow
  })
})

describe('outbox retry and keys', () => {
  it('backs off 1, 5, 15, 60 minutes and stops after five attempts', () => {
    const at = new Date('2026-09-26T00:00:00Z')
    expect([1, 2, 3, 4].map((n) => (outboxRetryAt(at, n)!.getTime() - at.getTime()) / 60000)).toEqual([1, 5, 15, 60])
    expect(outboxRetryAt(at, OUTBOX_MAX_ATTEMPTS)).toBeNull()
  })
  it('one key per notification and channel', () => {
    expect(outboxKey('n1', 'whatsapp')).toBe('n1:whatsapp')
  })
})

describe('preferences', () => {
  it('essential categories are orders, payments, reminders and account', () => {
    expect(essentialCategories()).toEqual(['orders', 'payments', 'reminders', 'account'])
  })
  it('the matrix fills defaults; marketing (updates) is off everywhere', () => {
    const m = effectivePreferences([])
    expect(m).toHaveLength(NOTIFICATION_CATEGORIES.length * PREFERENCE_CHANNELS.length)
    expect(m.filter((p) => p.category === 'updates').every((p) => !p.enabled)).toBe(true)
    expect(categoryDefault('orders', 'whatsapp')).toBe(true)
    expect(effectivePreferences([off('orders', 'whatsapp')]).find((p) => p.category === 'orders' && p.channel === 'whatsapp')?.enabled).toBe(false)
  })
  it('an essential category cannot end with no external channel', () => {
    expect(essentialCategoriesWithoutChannel([off('payments', 'whatsapp'), off('payments', 'email'), off('payments', 'sms')])).toEqual(['payments'])
    expect(essentialCategoriesWithoutChannel([off('payments', 'whatsapp'), off('payments', 'email')])).toEqual([])
    expect(essentialCategoriesWithoutChannel([off('requests', 'whatsapp'), off('requests', 'email'), off('requests', 'sms')])).toEqual([])
  })
  it('the settings schema takes IST quiet hours and a pause', () => {
    expect(notificationSettingsSchema.safeParse({ preferences: [], quietHours: { start: '21:00', end: '08:00' }, pausedUntil: null, digestLeads: false }).success).toBe(true)
    expect(notificationSettingsSchema.safeParse({ preferences: [], quietHours: { start: '25:00', end: '08:00' }, pausedUntil: null, digestLeads: false }).success).toBe(false)
  })
})
