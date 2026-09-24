import { describe, expect, it } from 'vitest'
import {
  CONTACT_MASK,
  findContactSpans,
  findOutputViolations,
  foldIndicDigits,
  hasContactInfo,
  isPhoneDigits,
  maskContactInfo,
  redactContactInfo,
  stripContactInfo,
} from '../index'
import { CONTACT_CASES } from './fixtures/contact-cases'

/**
 * Audit M30 — one contact rule set. The fixture table (shared with agent-core's
 * output-contract test) drives both surfaces; the legacy oracles below are the
 * three rule sets as they stood before M30, kept verbatim so "nothing any of
 * them caught slips through now" is a test, not a promise.
 */

const refused = (text: string) => findOutputViolations(text, { forbid: ['contact', 'urls'] }).length > 0

describe('M30 fixtures — the storage masker', () => {
  it.each(CONTACT_CASES.map((c) => [c.from, c.text, c] as const))('[%s] %s', (_from, text, c) => {
    const r = redactContactInfo(text)
    expect(r.redacted).toBe(c.mask)
    if (!c.mask) expect(r.text).toBe(text)
    else expect(r.text).toContain(CONTACT_MASK)
    for (const h of c.hides ?? []) expect(r.text).not.toContain(h)
    // stripContactInfo removes exactly what redactContactInfo masks.
    const stripped = stripContactInfo(text)
    if (!c.mask) expect(stripped).toBe(text.trim())
    for (const h of c.hides ?? []) expect(stripped).not.toContain(h)
    expect(hasContactInfo(text)).toBe(c.mask)
  })
})

describe('M30 fixtures — the output contract (contact + urls)', () => {
  it.each(CONTACT_CASES.map((c) => [c.from, c.text, c.refuse] as const))('[%s] %s', (_from, text, refuse) => {
    expect(refused(text)).toBe(refuse)
  })
})

describe('M30 masker details', () => {
  it('keeps every character outside the masked spans (Indic text, punctuation, spacing)', () => {
    expect(redactContactInfo('मुझे ९८७६५ ४३२१० पर कॉल करें।').text).toBe(`मुझे ${CONTACT_MASK} पर कॉल करें।`)
    expect(redactContactInfo('call me on 9876543210 tomorrow').text).toBe(`call me on ${CONTACT_MASK} tomorrow`)
    expect(redactContactInfo('a 98765​43210 b').text).toBe(`a ${CONTACT_MASK} b`)
  })

  it('one mask per contact detail; overlapping patterns merge', () => {
    expect(redactContactInfo('ravi@ex.com / 9876543210').text).toBe(`${CONTACT_MASK} / ${CONTACT_MASK}`)
    expect(redactContactInfo('pay 9876543210@ybl now').text).toBe(`pay ${CONTACT_MASK} now`)
    expect(redactContactInfo('two numbers 9876543210 9123456789').text).toBe(`two numbers ${CONTACT_MASK} ${CONTACT_MASK}`)
  })

  it('reports the kinds it masked', () => {
    expect(maskContactInfo('mail a@b.co or call 9876543210 or see rajesh.com/a').kinds.sort()).toEqual(['email', 'phone', 'url'])
    expect(maskContactInfo('nothing here').kinds).toEqual([])
  })

  it('stripContactInfo tidies the whitespace it leaves', () => {
    expect(stripContactInfo('Call 9876543210 or ravi@upi, 5 days')).toBe('Call or, 5 days')
    expect(stripContactInfo('+91 98765 43210 anytime')).toBe('anytime')
  })

  it('spans index the original text', () => {
    const text = 'x ९८७६५४३२१० y'
    const [s] = findContactSpans(text, ['phone'])
    expect(s && text.slice(s.start, s.end)).toBe('९८७६५४३२१०')
    expect(s?.match).toBe('९८७६५४३२१०')
  })

  it('isPhoneDigits: mobiles, trunk / country prefixes, landlines, toll-free; +91 landlines only with a plus', () => {
    for (const d of ['9876543210', '919876543210', '09876543210', '00919876543210', '9109876543210', '04023456789', '18001234567']) expect(isPhoneDigits(d), d).toBe(true)
    for (const d of ['5876543210', '98765432101', '1234567890', '987654321', '391209876543']) expect(isPhoneDigits(d), d).toBe(false)
    expect(isPhoneDigits('914023456789')).toBe(false)
    expect(isPhoneDigits('914023456789', true)).toBe(true)
  })

  it('foldIndicDigits folds every Indic block and leaves the rest', () => {
    expect(foldIndicDigits('९८७६५४३२१०')).toBe('9876543210')
    expect(foldIndicDigits('౯౮౭౬౫౪౩౨౧౦')).toBe('9876543210')
    expect(foldIndicDigits('௯௮௭௬௫௪௩௨௧௦')).toBe('9876543210')
    expect(foldIndicDigits('೯൮੭୬৫૪۳٢')).toBe('98765432')
    expect(foldIndicDigits('abc ₹ १२')).toBe('abc ₹ 12')
  })

  it('a long message is scanned in linear-ish time', () => {
    const long = 'rate 450 per kg, 12 mm plate, 2026 order; '.repeat(200) + 'call 9876543210'
    const t0 = Date.now()
    expect(redactContactInfo(long).redacted).toBe(true)
    expect(Date.now() - t0).toBeLessThan(500)
  })
})

// ── the three rule sets as they stood before M30 (oracles) ─────────────────────

function legacyRedact(input: string): boolean {
  let redacted = false
  input.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => { redacted = true; return '' })
  input.replace(/(?:\+?91[\s-]?)?(?:\d[\s-]?){10}/g, (m) => {
    if (/^(?:91)?[6-9]\d{9}$/.test(m.replace(/\D/g, ''))) redacted = true
    return m
  })
  return redacted
}

function legacyStrip(text: string): boolean {
  return /(?<!\d)(?:\+?91[\s-]?)?(?:0[\s-]?)?[6-9](?:[\s-]?\d){9}(?!\d)/.test(text)
    || /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)
    || /\b[A-Za-z0-9._-]{2,}@[A-Za-z]{2,}\b/.test(text)
}

const LEGACY_INDIC = [0x0966, 0x0c66, 0x0be6, 0x09e6, 0x0ae6]
function legacyFold(s: string): string {
  let out = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    const base = LEGACY_INDIC.find((b) => cp >= b && cp <= b + 9)
    out += base === undefined ? ch : String(cp - base)
  }
  return out
}
function legacyOutput(text: string): boolean {
  const t = legacyFold(text).normalize('NFKC')
  return [
    /(?:\+?91[\s.-]?|\b0)?[6-9](?:[\s.-]?\d){9}\b/,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    /\b[A-Za-z0-9._-]{2,}@(?:ybl|okaxis|oksbi|okicici|okhdfcbank|paytm|upi|ibl|axl|apl|axisbank|icici|hdfcbank|sbi|kotak|yesbank|ptyes|ptaxis|ptsbi|fbl|jio|airtel|waicici|wahdfcbank|wasbi|waaxis)\b/i,
    /(?:\bt\.me\/\S+|\btelegram\s*[:@]\s*\S+|\bwhatsapp\s*(?:me\s*)?(?:on|at|number|no\.?)\s*[:+\d]|\b@[A-Za-z0-9_]{5,}\b(?!\.))/i,
    /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/,
    /\b[A-Z]{5}\d{4}[A-Z]\b/,
    /\bhttps?:\/\/\S+|\bwww\.[A-Za-z0-9-]+\.[A-Za-z]{2,}\S*|\b[A-Za-z0-9-]+\.(?:com|in|co\.in|org|net|io|app|me|xyz|shop|site|store|online)\b(?:\/\S*)?/i,
  ].some((re) => re.test(t))
}

/**
 * What an old rule set flagged that M30 deliberately releases — each is a
 * false positive, never a reachable contact detail:
 *   - a 10-digit window cut out of a longer number (the old left-aligned /
 *     right-aligned windows): "6000 7000 8000", "750000-800000", "9876 5432
 *     1098", "19876543210", "98765432101" — nobody can dial ten digits of an
 *     11+ digit run without being told which ten;
 *   - the old output URL rule was case-insensitive, so a missing space after
 *     a full stop ("fixed.In addition"), a degree ("M.Com") or a framework
 *     ("ASP.NET") read as a domain; a unit ("sq.in") too;
 *   - "450@kg": a rate the old generic UPI rule read as a VPA.
 */
const RELEASED = new Set([
  '6000 7000 8000 kg',
  'range 750000-800000',
  'aadhaar-like 9876 5432 1098',
  'ref 19876543210',
  'ref 98765432101',
  'Price is fixed.In addition we deliver free.',
  'CA, M.Com, B.COM, LLB',
  'ASP.NET and VB.NET developers',
  'MS plate 12 mm, 450 per sq.in',
  'rate 450@kg, 500@pcs',
])

const LEGACY_CORPUS = [
  ...CONTACT_CASES.map((c) => c.text),
  ...RELEASED,
  '9876543210', '+91-98765-43210', '(+91) 98765 43210', '0091 98765 43210', '98765 43210 and 91234 56789',
  'ping 91 98765 43210 today', 'call me: 98765 43210.', 'my no. 98765-43210', 'office 0 98765 43210',
  'ravi@upi', 'ravi.k@okhdfcbank', 'sales@rajesh-traders.co.in', 'telegram @rajesh_traders_9', 't.me/joinchat/abc',
  'www.rajesh.in', 'http://x.io/y', 'rajesh.store', 'GSTIN 29ABCDE1234F1Z5', 'PAN ABCDE1234F',
  'फोन ९८७६५४३२१० पर', 'ఫోన్ ౯౮౭౬౫౪౩౨౧౦', 'போன் ௯௮௭௬௫௪௩௨௧௦', 'ফোন ৯৮৭৬৫৪৩২১০', 'ફોન ૯૮૭૬૫૪૩૨૧૦',
  'budget 1,50,000', '12 pcs at 450', '2026-09-24', 'invoice 2026/27/0418', 'pincode 500081',
]

describe('M30 — no regression against the three old rule sets', () => {
  it.each(LEGACY_CORPUS.map((t) => [t]))('%s', (text) => {
    if (RELEASED.has(text)) return
    if (legacyRedact(text) || legacyStrip(text)) expect(redactContactInfo(text).redacted, 'old storage masker caught it').toBe(true)
    if (legacyOutput(text)) expect(refused(text), 'old output rule caught it').toBe(true)
  })

  it('the released cases are exactly the false positives listed (and each was caught by an old rule)', () => {
    for (const text of RELEASED) {
      expect(legacyRedact(text) || legacyStrip(text) || legacyOutput(text), text).toBe(true)
      expect(redactContactInfo(text).redacted, text).toBe(false)
    }
  })
})
