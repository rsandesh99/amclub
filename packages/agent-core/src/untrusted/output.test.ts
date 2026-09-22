import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { checkCustomerFacing, collectStrings, customerFacingText } from './output'

const msg = customerFacingText(z.object({ message: z.string(), locale: z.string() }).strict(), { fields: ['message'], forbid: ['contact', 'payment', 'urls'] })
const pointers = customerFacingText(z.object({ pointers: z.array(z.object({ quote_id: z.string(), lines: z.array(z.string()) })), locale: z.string() }), { fields: ['pointers[].lines[]'], forbid: ['contact', 'payment', 'ranking', 'urls'] })
const ops = customerFacingText(z.object({ rationale: z.array(z.string()), claims: z.array(z.object({ claim: z.string() })) }), { fields: ['rationale[]', 'claims[].claim'], forbid: ['contact', 'urls'] })
const approval = customerFacingText(z.object({ about: z.string().nullable(), locale: z.string().optional() }), { fields: ['about'], forbid: ['approval', 'payment'] })

const codes = (r: z.SafeParseReturnType<unknown, unknown>) => (r.success ? [] : r.error.issues.map((i) => i.message))

describe('S2.1 output contract — collectStrings', () => {
  it('walks dotted paths and arrays; skips missing and non-string values', () => {
    const v = { pointers: [{ lines: ['a', 'b'] }, { lines: [] }, { lines: ['c'] }], message: 7, nested: { x: null } }
    expect(collectStrings(v, 'pointers[].lines[]').map((h) => h.value)).toEqual(['a', 'b', 'c'])
    expect(collectStrings(v, 'pointers[].lines[]').map((h) => h.path)).toEqual([['pointers', 0, 'lines', 0], ['pointers', 0, 'lines', 1], ['pointers', 2, 'lines', 0]])
    expect(collectStrings(v, 'message')).toEqual([])
    expect(collectStrings(v, 'nested.x')).toEqual([])
    expect(collectStrings(v, 'missing.path[]')).toEqual([])
  })
})

describe('S2.1 output contract — contact', () => {
  it.each([
    ['plain 10-digit mobile', 'Call me on 9876543210 for the rate.'],
    ['+91 with spaces', 'Reach us at +91 98765 43210 anytime.'],
    ['dashed number', 'Number: 98765-43210.'],
    ['Devanagari digits', 'मुझे ९८७६५४३२१० पर कॉल करें।'],
    ['Telugu digits', 'నాకు ౯౮౭౬౫౪౩౨౧౦ కి కాల్ చేయండి.'],
    ['email', 'Write to owner@example.com with the PO.'],
    ['UPI VPA', 'Send it to rajesh@ybl please.'],
    ['telegram handle', 'Ping me on telegram: @rajesh_traders_99'],
    ['whatsapp me on', 'WhatsApp me on +91 90000 00001'],
    ['full GSTIN', 'Our GSTIN 36AAACR1234A1Z5 is on the invoice.'],
    ['full PAN', 'PAN AAACR1234A as printed.'],
  ])('%s → contact_info', (_l, text) => {
    expect(codes(msg.safeParse({ message: text, locale: 'en' }))).toContain('contact_info')
  })

  it.each([
    ['masked GSTIN passes', 'GSTIN XXXXXXXXXXXA1Z5 as printed.'],
    ['masked PAN passes', 'PAN XXXXXX234A.'],
    ['GST 18% passes', 'Rs. 12,000 plus GST 18%, delivery in 10 days.'],
    ['rupee amount with commas passes', 'The total is ₹1,10,448 including tax.'],
    ['invoice number passes', 'Invoice KIS/2026-27/0418 dated 03/09/2026.'],
    ['6-digit pincode passes', 'Deliver to Guntur 522001 by Friday.'],
    ['a year and a quantity pass', 'In 2026 we need 1200 kg of MS angle.'],
  ])('%s', (_l, text) => {
    expect(codes(msg.safeParse({ message: text, locale: 'en' }))).not.toContain('contact_info')
  })
})

describe('S2.1 output contract — payment / urls / ranking / approval', () => {
  it.each([
    ['en pay directly', 'en', 'Pay me directly and skip the commission.'],
    ['en UPI', 'en', 'Use UPI for the advance.'],
    ['en outside the app', 'en', 'We can settle this outside the app.'],
    ['en ifsc', 'en', 'IFSC and account on request.'],
    ['hinglish', 'hi', 'Seedha payment kar do, app ke bahar.'],
    ['hi upi', 'hi', 'यूपीआई से पैसे भेज दो।'],
    ['hi outside app', 'hi', 'ऐप के बाहर भुगतान कर दो।'],
    ['ta direct', 'ta', 'நேரடியாக பணம் அனுப்புங்கள்.'],
    ['ta outside app', 'ta', 'ஆப்பிற்கு வெளியே செலுத்துங்கள்.'],
    ['te direct', 'te', 'నేరుగా చెల్లించండి, కమిషన్ ఉండదు.'],
    ['te outside app', 'te', 'యాప్ బయట చెల్లించండి.'],
    ['english words leak into a hindi message', 'hi', 'कृपया gpay पर भेजें।'],
  ])('%s → off_platform_payment', (_l, locale, text) => {
    expect(codes(msg.safeParse({ message: text, locale }))).toContain('off_platform_payment')
  })

  it.each([
    ['https url', 'See https://example.com/deal for the price list.'],
    ['www url', 'Visit www.rajeshtraders.in today.'],
    ['bare domain', 'Details at rajeshtraders.com now.'],
  ])('%s → url', (_l, text) => {
    expect(codes(msg.safeParse({ message: text, locale: 'en' }))).toContain('url')
  })

  it('ranking language is refused on pointers (en + hi + ta + te), plain comparisons pass', () => {
    const bad = (locale: string, line: string) => codes(pointers.safeParse({ pointers: [{ quote_id: 'q1', lines: [line] }], locale }))
    expect(bad('en', 'This is the best quote, go with it.')).toContain('ranking_language')
    expect(bad('hi', 'यह सबसे अच्छा कोटेशन है।')).toContain('ranking_language')
    expect(bad('ta', 'இதுவே சிறந்த விலைப்புள்ளி.')).toContain('ranking_language')
    expect(bad('te', 'ఇదే ఉత్తమ కొటేషన్.')).toContain('ranking_language')
    expect(bad('en', 'Quote B includes transport; Quote A does not state it.')).toEqual([])
  })

  it('approval claims are refused where forbidden; a plain profile passes', () => {
    expect(codes(approval.safeParse({ about: 'We are a KYC verified firm, payout released within a day.', locale: 'en' }))).toContain('approval_language')
    expect(codes(approval.safeParse({ about: 'हमारा प्रोफ़ाइल सत्यापित है।', locale: 'hi' }))).toContain('approval_language')
    expect(codes(approval.safeParse({ about: 'Twelve years of GST filing for garment units in Guntur and Vijayawada.', locale: 'en' }))).toEqual([])
    expect(codes(approval.safeParse({ about: null, locale: 'en' }))).toEqual([])
  })

  it('ops-only opt-in refuses contact and urls only; approval words pass there', () => {
    expect(codes(ops.safeParse({ rationale: ['The payout can be released; the buyer approved delivery.'], claims: [{ claim: 'Buyer says the work is approved.' }] }))).toEqual([])
    expect(codes(ops.safeParse({ rationale: ['Call the buyer on 9876543210.'], claims: [{ claim: 'x' }] }))).toContain('contact_info')
    expect(codes(ops.safeParse({ rationale: ['ok'], claims: [{ claim: 'See www.proof.in/photo' }] }))).toContain('url')
  })

  it('locale resolves from the object when not given; issues name the path and carry the match', () => {
    const r = pointers.safeParse({ pointers: [{ quote_id: 'q1', lines: ['fine', 'call 9876543210'] }], locale: 'hi' })
    expect(r.success).toBe(false)
    if (!r.success) {
      const issue = r.error.issues[0]!
      expect(issue.path).toEqual(['pointers', 0, 'lines', 1])
      expect(issue.message).toBe('contact_info')
      expect(((issue as unknown as { params?: { match?: string } }).params ?? {}).match).toContain('9876543210')
    }
    expect(checkCustomerFacing({ message: 'सबसे अच्छा', locale: 'hi' }, { fields: ['message'], forbid: ['ranking'] })[0]?.violation.code).toBe('ranking_language')
    expect(checkCustomerFacing({ message: 'सबसे अच्छा' }, { fields: ['message'], forbid: ['ranking'], locale: 'hi' })[0]?.violation.code).toBe('ranking_language')
  })

  it('the wrapped schema still parses a clean value with its type intact', () => {
    const ok = msg.safeParse({ message: 'Thank you for quoting; the buyer chose another provider this time.', locale: 'en' })
    expect(ok.success).toBe(true)
    if (ok.success) expect(ok.data.message).toContain('Thank you')
    expect(msg.safeParse({ message: 'x', locale: 'en', extra: 1 }).success).toBe(false) // strictness preserved
  })
})
