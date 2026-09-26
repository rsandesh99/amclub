import { describe, expect, it } from 'vitest'
import {
  aggregateWaSpend,
  canTransitionDpdpRequest,
  compareWaTemplates,
  corpusSourceAllowed,
  dpdpActionSchema,
  dpdpDueAt,
  dpdpOverdue,
  formatMillipaiseINR,
  isSchemaNotReady,
  istDateKey,
  mapGraphTemplate,
  millipaiseToPaise,
  reduceWaPayload,
  safeGraphNext,
  sortDpdpQueue,
  waAccountHealth,
  waCodeTemplates,
  waPreview,
  waRetentionAction,
  waRetentionCutoffs,
  waStoredMediaPath,
  WA_HOLD_ORDER_STATUSES,
  WA_RETENTION_DEFAULTS,
} from '../wa-ops'
import { maskWaPhone, redactChatSecrets } from '../whatsapp'

describe('WhatsApp cost in millipaise (rule 6)', () => {
  it('rounds to paise half away from zero and formats two decimals with Indian grouping', () => {
    expect(millipaiseToPaise(11_500)).toBe(12) // ₹0.115 → 12 paise
    expect(millipaiseToPaise(11_499)).toBe(11)
    expect(millipaiseToPaise(-1_500)).toBe(-2)
    expect(formatMillipaiseINR(11_500)).toBe('₹0.12')
    expect(formatMillipaiseINR(0)).toBe('₹0.00')
    expect(formatMillipaiseINR(null)).toBe('₹0.00')
    expect(formatMillipaiseINR(12_345_678_900)).toBe('₹1,23,456.79')
    expect(formatMillipaiseINR('785000')).toBe('₹7.85')
  })
  it('aggregates per IST day and category, integers only', () => {
    const rows = [
      // 23:00 IST on 25 Sep = 17:30 UTC; 00:30 IST on 26 Sep = 19:00 UTC on the 25th
      { created_at: '2026-09-25T17:30:00Z', pricing_category: 'utility', cost_millipaise: 11_500, billable: true },
      { created_at: '2026-09-25T19:00:00Z', pricing_category: 'utility', cost_millipaise: 11_500, billable: true },
      { created_at: '2026-09-25T19:05:00Z', category: 'marketing', pricing_category: null, cost_millipaise: 785_000, billable: true },
      { created_at: '2026-09-25T19:10:00Z', category: null, pricing_category: 'SERVICE', cost_millipaise: null, billable: false },
    ]
    const r = aggregateWaSpend(rows)
    expect(istDateKey('2026-09-25T17:30:00Z')).toBe('2026-09-25')
    expect(istDateKey('2026-09-25T19:00:00Z')).toBe('2026-09-26')
    expect(r.total).toEqual({ messages: 4, billable: 3, costMillipaise: 808_000, cost: '₹8.08' })
    expect(r.days[0]).toMatchObject({ day: '2026-09-26', category: 'marketing', messages: 1, cost: '₹7.85' })
    expect(r.days.find((d) => d.day === '2026-09-25')).toMatchObject({ category: 'utility', messages: 1, costMillipaise: 11_500 })
    expect(r.byCategory.map((c) => c.category)).toEqual(['marketing', 'service', 'utility'])
    expect(r.byCategory.find((c) => c.category === 'utility')).toMatchObject({ messages: 2, billable: 2, cost: '₹0.23' })
  })
})

describe('retention eligibility (D-WA5)', () => {
  const now = new Date('2026-09-26T00:00:00Z')
  const cut = waRetentionCutoffs(now, WA_RETENTION_DEFAULTS)
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString()
  const base = { legalHold: false, redactedAt: null, mediaRef: null, userHeld: false }
  it('redacts text after 180 days and media alone after 90', () => {
    expect(waRetentionAction({ ...base, createdAt: day(181) }, cut)).toBe('redact')
    expect(waRetentionAction({ ...base, createdAt: day(179) }, cut)).toBe('keep')
    expect(waRetentionAction({ ...base, createdAt: day(91), mediaRef: 'c1/wamid.X.ogg' }, cut)).toBe('remove_media')
    expect(waRetentionAction({ ...base, createdAt: day(89), mediaRef: 'c1/wamid.X.ogg' }, cut)).toBe('keep')
    expect(waRetentionAction({ ...base, createdAt: day(200), mediaRef: 'c1/wamid.X.ogg' }, cut)).toBe('redact')
  })
  it('never touches a legal hold, a held user or a redacted row', () => {
    expect(waRetentionAction({ ...base, createdAt: day(400), legalHold: true }, cut)).toBe('keep')
    expect(waRetentionAction({ ...base, createdAt: day(400), userHeld: true }, cut)).toBe('keep')
    expect(waRetentionAction({ ...base, createdAt: day(400), redactedAt: day(10) }, cut)).toBe('keep')
  })
  it('the cutoffs follow the settings', () => {
    const c = waRetentionCutoffs(now, { textDays: 30, mediaDays: 7, unknownDays: 1 })
    expect(c).toEqual({ text: day(30), media: day(7), unknown: day(1) })
  })
  it('an open dispute, work in flight and a refund owed hold a user; done and closed orders do not', () => {
    expect(WA_HOLD_ORDER_STATUSES).toEqual(expect.arrayContaining(['disputed', 'in_progress', 'placed', 'cancelled_by_buyer']))
    expect(WA_HOLD_ORDER_STATUSES).not.toContain('completed')
    expect(WA_HOLD_ORDER_STATUSES).not.toContain('refunded')
    expect(WA_HOLD_ORDER_STATUSES).not.toContain('resolved_release')
  })
  it('only stored wa-media paths are removed from storage', () => {
    expect(waStoredMediaPath('c1/wamid.X.ogg')).toBe('c1/wamid.X.ogg')
    expect(waStoredMediaPath('MEDIA123')).toBeNull()
    expect(waStoredMediaPath('https://example.com/a/b')).toBeNull()
    expect(waStoredMediaPath('../etc/passwd')).toBeNull()
    expect(waStoredMediaPath(null)).toBeNull()
  })
  it('a redacted payload keeps ids, kind, status and times only', () => {
    const p = reduceWaPayload({ id: 'wamid.1', from: '919876543210', type: 'text', timestamp: '1727300000', text: { body: 'my address is 12 MG Road' }, context: { id: 'wamid.0' }, run_id: 'r1', amc_media_ref: 'M1', profile: { name: 'Ravi' } })
    expect(p).toEqual({ redacted: true, id: 'wamid.1', type: 'text', timestamp: '1727300000', context_id: 'wamid.0', run_id: 'r1' })
    expect(reduceWaPayload(null)).toEqual({ redacted: true })
  })
})

describe('masking and previews', () => {
  it('phones keep only the last four digits', () => {
    expect(maskWaPhone('919876543210')).toBe('••••••••3210')
  })
  it('previews drop secrets, collapse whitespace and cap the length', () => {
    expect(waPreview('my OTP is 482913\n\nplease help')).toBe('my OTP [removed] please help')
    const long = 'a'.repeat(200)
    expect(waPreview(long, 80)).toHaveLength(80)
    expect(waPreview(long, 80).endsWith('…')).toBe(true)
    expect(waPreview(null)).toBe('')
  })
})

describe('redactChatSecrets (more patterns)', () => {
  it('codes before the word, Indic words and passwords', () => {
    expect(redactChatSecrets('482913 is your OTP for login').text).toBe('[removed] is your OTP for login')
    expect(redactChatSecrets('ओटीपी 482913 है').text).toBe('ओटीपी [removed] है')
    expect(redactChatSecrets('నా ఓటీపీ 7788').text).toBe('నా ఓటీపీ [removed]')
    expect(redactChatSecrets('ஓடிபி: 123456').text).toBe('ஓடிபி [removed]')
    expect(redactChatSecrets('my password is Abc@1234 ok').text).toBe('my password [removed] ok')
    expect(redactChatSecrets('verification code is 123456').redacted).toEqual(['secret_code'])
    expect(redactChatSecrets('UPI-PIN 4321').text).toBe('UPI-PIN [removed]')
    expect(redactChatSecrets('cvv 123').text).toBe('cvv [removed]')
  })
  it('postal PIN codes, order numbers and plain words stay', () => {
    for (const s of [
      'Deliver to Guntur, pin code 522002',
      'Address: MG Road, Pin: 560001',
      'पिन कोड 500001',
      'otp for order AMC-2026-000123 not received',
      'password is weak',
      'Order AMC-2026-000123 for ₹5,900; call 9876543210',
    ]) {
      expect(redactChatSecrets(s), s).toEqual({ text: s, redacted: [] })
    }
  })
})

describe('schema readiness', () => {
  it('recognises a missing table or column', () => {
    expect(isSchemaNotReady({ code: '42P01', message: 'relation "wa_templates" does not exist' })).toBe(true)
    expect(isSchemaNotReady({ code: 'PGRST205', message: "Could not find the table 'public.dpdp_requests' in the schema cache" })).toBe(true)
    expect(isSchemaNotReady({ code: 'PGRST204', message: "Could not find the 'redacted_at' column" })).toBe(true)
    expect(isSchemaNotReady({ code: '42703', message: 'column wa_messages.legal_hold does not exist' })).toBe(true)
    expect(isSchemaNotReady({ code: '23505', message: 'duplicate key value' })).toBe(false)
    expect(isSchemaNotReady(null)).toBe(false)
  })
})

describe('corpus exclusion (Meta Business Solution Terms)', () => {
  it('nothing from WhatsApp, by voice metadata or by the run surface', () => {
    expect(corpusSourceAllowed({ voiceChannel: 'whatsapp' })).toBe(false)
    expect(corpusSourceAllowed({ runSurface: 'whatsapp' })).toBe(false)
    expect(corpusSourceAllowed({ voiceChannel: 'web', runSurface: 'whatsapp' })).toBe(false)
    expect(corpusSourceAllowed({ voiceChannel: undefined, runSurface: null })).toBe(true)
    expect(corpusSourceAllowed({ voiceChannel: 'mobile', runSurface: 'web' })).toBe(true)
  })
})

describe('templates: code vs Meta', () => {
  const oldShape = {
    order_placed: { names: { en: 'amc_order_placed_en', hi: 'amc_order_placed_hi' }, params: () => [] },
    support_reply: { names: { en: 'amc_support_reply_en', hi: 'amc_support_reply_hi', te: 'amc_support_reply_te' }, params: () => [] },
  }
  const newShape = {
    refund_processed: { stem: 'amc_refund_processed', category: 'utility', locales: ['en', 'hi', 'te', 'ta'], body: { en: 'x' }, params: () => [] },
  }
  it('reads both registry shapes', () => {
    expect(waCodeTemplates(oldShape).map((t) => `${t.name}/${t.language}`)).toEqual(['amc_order_placed_en/en', 'amc_order_placed_hi/hi', 'amc_support_reply_en/en', 'amc_support_reply_hi/hi', 'amc_support_reply_te/te'])
    const n = waCodeTemplates(newShape)
    expect(n).toHaveLength(4)
    expect(n[0]).toEqual({ kind: 'refund_processed', name: 'amc_refund_processed_en', language: 'en', category: 'utility' })
  })
  it('flags in code but not approved, and approved but not in code', () => {
    const code = waCodeTemplates(oldShape)
    const rows = compareWaTemplates(code, [
      { name: 'amc_order_placed_en', language: 'en', category: 'utility', status: 'approved', rejection_reason: null, synced_at: '2026-09-26T00:00:00Z' },
      { name: 'amc_order_placed_hi', language: 'hi', category: 'utility', status: 'rejected', rejection_reason: 'INVALID_FORMAT', synced_at: null },
      { name: 'amc_old_promo_en', language: 'en', category: 'marketing', status: 'approved', rejection_reason: null, synced_at: null },
    ])
    const flag = (n: string) => rows.find((r) => r.name === n)?.flag
    expect(flag('amc_order_placed_en')).toBe('ok')
    expect(flag('amc_order_placed_hi')).toBe('in_code_not_approved')
    expect(rows.find((r) => r.name === 'amc_order_placed_hi')?.rejectionReason).toBe('INVALID_FORMAT')
    expect(flag('amc_support_reply_te')).toBe('in_code_not_approved')
    expect(flag('amc_old_promo_en')).toBe('approved_not_in_code')
    expect(rows[0]!.flag).toBe('in_code_not_approved')
  })
  it('maps a Graph template and refuses to follow a foreign paging link', () => {
    expect(mapGraphTemplate({ id: '123', name: 'amc_order_placed_en', language: 'en', status: 'APPROVED', category: 'UTILITY', rejected_reason: 'NONE', quality_score: { score: 'GREEN' }, components: [{ type: 'BODY' }] })).toEqual({
      name: 'amc_order_placed_en', language: 'en', category: 'utility', status: 'approved', rejection_reason: null, meta_template_id: '123', components: [{ type: 'BODY' }], quality: 'green',
    })
    expect(mapGraphTemplate({ name: 'x', language: 'en', status: 'PENDING_DELETION', category: 'WHATEVER' })).toMatchObject({ status: 'deleted', category: null })
    expect(mapGraphTemplate({ language: 'en' })).toBeNull()
    expect(safeGraphNext('https://graph.facebook.com/v24.0/1/message_templates?after=abc')).not.toBeNull()
    expect(safeGraphNext('https://evil.example/graph.facebook.com')).toBeNull()
    expect(safeGraphNext('http://graph.facebook.com/x')).toBeNull()
  })
  it('reads quality and tier from the latest account events', () => {
    const h = waAccountHealth([
      { field: 'phone_number_quality_update', payload: { value: { event: 'FLAGGED', current_limit: 'TIER_250' } }, created_at: '2026-09-20T00:00:00Z' },
      { field: 'phone_number_quality_update', payload: { event: 'UNFLAGGED', current_limit: 'TIER_1K' }, created_at: '2026-09-25T00:00:00Z' },
    ])
    expect(h).toEqual({ quality: 'UNFLAGGED', tier: 'TIER_1K', event: 'UNFLAGGED', at: '2026-09-25T00:00:00Z' })
    expect(waAccountHealth([])).toEqual({ quality: null, tier: null, event: null, at: null })
  })
})

describe('DPDP requests', () => {
  it('one transition map; done and rejected are final', () => {
    expect(canTransitionDpdpRequest('open', 'in_progress')).toBe(true)
    expect(canTransitionDpdpRequest('in_progress', 'done')).toBe(true)
    expect(canTransitionDpdpRequest('done', 'in_progress')).toBe(false)
    expect(canTransitionDpdpRequest('rejected', 'done')).toBe(false)
  })
  it('due dates, overdue, and the queue order', () => {
    const now = new Date('2026-09-26T00:00:00Z')
    expect(dpdpDueAt(new Date('2026-09-01T00:00:00Z'), 30)).toBe('2026-10-01T00:00:00.000Z')
    expect(dpdpOverdue({ status: 'open', due_at: '2026-09-25T00:00:00Z' }, now)).toBe(true)
    expect(dpdpOverdue({ status: 'done', due_at: '2026-09-25T00:00:00Z' }, now)).toBe(false)
    const q = sortDpdpQueue([
      { id: 'a', status: 'done', due_at: '2026-09-01', created_at: '2026-08-01', resolved_at: '2026-08-05' },
      { id: 'b', status: 'open', due_at: '2026-10-10', created_at: '2026-09-10' },
      { id: 'c', status: 'in_progress', due_at: '2026-09-30', created_at: '2026-08-31' },
      { id: 'd', status: 'rejected', due_at: '2026-09-01', created_at: '2026-08-02', resolved_at: '2026-08-20' },
    ])
    expect(q.map((r) => r.id)).toEqual(['c', 'b', 'd', 'a'])
  })
  it('a final answer needs a resolution the user can read', () => {
    expect(dpdpActionSchema.safeParse({ action: 'in_progress' }).success).toBe(true)
    expect(dpdpActionSchema.safeParse({ action: 'done' }).success).toBe(false)
    expect(dpdpActionSchema.safeParse({ action: 'done', resolution: 'Exported and sent by email.' }).success).toBe(true)
    expect(dpdpActionSchema.safeParse({ action: 'done', resolution: 'ok', extra: 1 }).success).toBe(false)
  })
})
