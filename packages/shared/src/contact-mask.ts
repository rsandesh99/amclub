/**
 * Audit M30 — the ONE contact rule set.
 *
 * Before this file there were three: `redactContactInfo` (rfq.ts, the storage
 * masker for every human message: a left-aligned 10-digit window, emails only),
 * `stripContactInfo` (quote-extraction.ts: bounded mobiles, emails, UPI ids) and
 * `CONTACT_PATTERNS` (output-policy.ts, the agent output refuser: phones with
 * Indic digits, UPI, handles, URLs, GSTIN / PAN). The weakest one guarded the
 * pre-payment human messages. Now every surface reads the patterns below:
 *
 *   - `maskContactInfo` masks at storage time (redactContactInfo and
 *     stripContactInfo are thin wrappers that keep their signatures);
 *   - `findContactSpans` is what the customer-facing output contract refuses on
 *     (`findOutputViolations`, output-policy.ts), with GSTIN / PAN and the
 *     "WhatsApp me on" cue added there — identity numbers are refused in model
 *     output but never masked in a human message.
 *
 * Matching runs on a folded copy of the text: Indic / Arabic-Indic digits and
 * fullwidth ASCII fold to ASCII and invisible characters (zero-width, bidi,
 * soft hyphen) drop out, with an index map back to the original so the stored
 * text keeps its own characters everywhere except the masked spans.
 *
 * Phones are found by a tokenizer, not one regex: digit runs and spelled-out
 * digits (English, Hinglish, Hindi, Telugu, Tamil; "double" / "triple") joined
 * by short separators (space, dash, dot, brackets; commas between words) form a
 * cluster, and any run of WHOLE tokens whose digits read as an Indian mobile
 * (optional +91 / 91 / 0091 / 0), an STD landline (0 + 10 digits), a +91
 * landline or a 1800 / 1860 toll-free number is a phone. A number glued to
 * more digits with no separator (an e-way bill, an Aadhaar, an account number)
 * is an identifier, not a phone: the reader cannot know which ten digits to
 * dial. Pure; zero dependencies.
 */

export const CONTACT_MASK = '[contact hidden]'

// ── digit folding ─────────────────────────────────────────────────────────────

/**
 * The zero of every decimal-digit block folded to ASCII: Arabic-Indic, Extended
 * Arabic-Indic (Urdu), Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil,
 * Telugu, Kannada, Malayalam, Sinhala Lith. All BMP, one code unit each.
 */
const DIGIT_ZEROS = [0x0660, 0x06f0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6] as const

function digitValue(cp: number): number {
  for (const zero of DIGIT_ZEROS) if (cp >= zero && cp <= zero + 9) return cp - zero
  return -1
}

/**
 * Indic (and Arabic-Indic) digits → ASCII, everything else untouched. Length-
 * preserving. The one fold every contact / number check uses (the agent-core
 * envelope and the output policy re-export it).
 */
export function foldIndicDigits(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const d = digitValue(s.charCodeAt(i))
    out += d >= 0 ? String(d) : s[i]
  }
  return out
}

// Zero-width space / non-joiner / joiner, LRM / RLM, bidi embeddings and
// overrides, word joiner + invisible operators, BOM, soft hyphen.
function isInvisible(cu: number): boolean {
  return (cu >= 0x200b && cu <= 0x200f) || (cu >= 0x202a && cu <= 0x202e) || (cu >= 0x2060 && cu <= 0x2064) || cu === 0xfeff || cu === 0x00ad
}

interface Folded {
  text: string
  /** map[i] = index in the original of folded code unit i; map[text.length] = original length. */
  map: number[]
}

function foldForMatch(s: string): Folded {
  let text = ''
  const map: number[] = []
  for (let i = 0; i < s.length; i++) {
    const cu = s.charCodeAt(i)
    if (isInvisible(cu)) continue
    const d = digitValue(cu)
    if (d >= 0) text += String(d)
    else if (cu >= 0xff01 && cu <= 0xff5e) text += String.fromCharCode(cu - 0xfee0) // fullwidth ASCII
    else text += s[i]
    map.push(i)
  }
  map.push(s.length)
  return { text, map }
}

// ── the patterns ──────────────────────────────────────────────────────────────

export const CONTACT_KINDS = ['phone', 'email', 'upi', 'url', 'handle', 'whatsapp_cue', 'gstin', 'pan'] as const
export type ContactKind = (typeof CONTACT_KINDS)[number]

/** What the storage masker hides in human text (redactContactInfo / stripContactInfo). */
export const MASKED_CONTACT_KINDS: readonly ContactKind[] = ['phone', 'email', 'upi', 'url', 'handle']

/**
 * Digit strings (separators removed) that read as a phone number. `plus` marks
 * a literal "+" before the first digit.
 */
export const PHONE_DIGIT_PATTERNS = {
  /** Indian mobile: 10 digits from 6–9, optionally after 91 / 0091 and / or a trunk 0 ("+91 0 98765 43210"). */
  mobile: /^(?:0{0,2}91)?0?[6-9]\d{9}$/,
  /** STD landline dialled with its trunk 0: 0 + a 10-digit national number. */
  landline: /^0[1-9]\d{9}$/,
  /** Any 10-digit national number after an explicit +91 / 0091. */
  international: /^(?:00)?91[1-9]\d{9}$/,
  /** Toll-free / shared-cost: 1800 / 1860 + 7 digits. */
  toll_free: /^1(?:800|860)\d{7}$/,
} as const

export function isPhoneDigits(digits: string, plus = false): boolean {
  const p = PHONE_DIGIT_PATTERNS
  if (p.mobile.test(digits) || p.landline.test(digits) || p.toll_free.test(digits)) return true
  return (plus || digits.startsWith('00')) && p.international.test(digits)
}

/** Spelled-out digits (whole words; Latin matched case-insensitively). */
export const NUMBER_WORDS: Readonly<Record<string, number>> = {
  // English
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  // Hinglish (romanised Hindi). "do" (2) and "char" (4) can never start a mobile number, so they are safe; deliberately
  // absent: "sat", "tin", "no", "che" — ordinary English words that could.
  shunya: 0, shoonya: 0, sunya: 0, ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, chhah: 6, chah: 6, saat: 7, aath: 8, nau: 9,
  // Hindi
  'शून्य': 0, 'ज़ीरो': 0, 'जीरो': 0, 'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'छह': 6, 'छः': 6, 'छे': 6, 'सात': 7, 'आठ': 8, 'नौ': 9,
  // Telugu
  'సున్నా': 0, 'జీరో': 0, 'ఒకటి': 1, 'రెండు': 2, 'మూడు': 3, 'నాలుగు': 4, 'ఐదు': 5, 'ఆరు': 6, 'ఏడు': 7, 'ఎనిమిది': 8, 'తొమ్మిది': 9,
  // Tamil
  'பூஜ்ஜியம்': 0, 'பூஜ்யம்': 0, 'சைபர்': 0, 'ஜீரோ': 0, 'ஒன்று': 1, 'இரண்டு': 2, 'மூன்று': 3, 'நான்கு': 4, 'ஐந்து': 5, 'ஆறு': 6, 'ஏழு': 7, 'எட்டு': 8, 'ஒன்பது': 9,
}

/** "double nine" = 99. A multiplier applies to the single digit that follows it. */
export const NUMBER_MULTIPLIERS: Readonly<Record<string, number>> = {
  double: 2, triple: 3, 'डबल': 2, 'ट्रिपल': 3, 'డబుల్': 2, 'ట్రిపుల్': 3, 'டபுள்': 2, 'ட்ரிபிள்': 3,
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const WORD_ALTERNATION = [...Object.keys(NUMBER_WORDS), ...Object.keys(NUMBER_MULTIPLIERS)]
  .sort((a, b) => b.length - a.length)
  .map(esc)
  .join('|')
// A digit run (optionally "+"-prefixed), or a number word bounded by non-letters in any script.
const PHONE_TOKEN_RE = new RegExp(`(\\+)?(\\d+)|(?<![\\p{L}\\p{M}\\p{N}])(${WORD_ALTERNATION})(?![\\p{L}\\p{M}\\p{N}])`, 'giu')
/** Between two digit runs: at most three of space / dash / dot / brackets. */
const DIGIT_GAP_RE = /^[\s\-.–—−()]{0,3}$/
/** When a spelled-out word is involved, a comma may separate too ("nine, eight, seven"). */
const WORD_GAP_RE = /^[\s\-.–—−(),]{0,3}$/

const TLDS = ['com', 'in', 'co.in', 'org', 'net', 'io', 'app', 'me', 'xyz', 'shop', 'site', 'store', 'online', 'biz', 'info']
// Lower- or upper-case, never Title-case: "time.In addition" (a missing space after a full stop) and "M.Com" are prose.
const TLD_ALTERNATION = [...TLDS, ...TLDS.map((t) => t.toUpperCase())].sort((a, b) => b.length - a.length).map(esc).join('|')
/** Domain-shaped words that are not links: units and framework names. */
const URL_STOPLIST = /^(?:sq|cu|cub)\.in$|^(?:asp|vb|ado)\.net$/i
/** "450@kg" is a rate, not a UPI id: a unit after the @ (no bank handle is a unit). */
const UPI_UNIT_HANDLE = /@(?:kgs?|g|gms?|mt|tons?|tonnes?|pcs?|pieces?|units?|each|sq\w*|sft|rft|rmt|nos|box(?:es)?|bags?|ltrs?|litres?|mtrs?|months?|days?|hrs?|hours?|rs|inr)$/i
const isRateNotUpi = (m: string): boolean => UPI_UNIT_HANDLE.test(m)

const LOCAL = '[A-Za-z0-9._%+-]+'
const LABEL = '[A-Za-z0-9-]+'
const DOT_WORD = '(?:\\s*\\[\\s*dot\\s*\\]\\s*|\\s*\\(\\s*dot\\s*\\)\\s*|\\s*\\{\\s*dot\\s*\\}\\s*|\\s+dot\\s+)'
const DOT_SEP = `(?:\\s*\\.\\s*|${DOT_WORD})`
const AT_BRACKETED = '\\s*(?:\\[\\s*at\\s*\\]|\\(\\s*at\\s*\\)|\\{\\s*at\\s*\\})\\s*'
const MAIL_TLD = '(?:com|in|net|org|co|io|info|biz)'

/**
 * Every non-phone contact pattern (phones: `PHONE_DIGIT_PATTERNS` +
 * `NUMBER_WORDS` through the tokenizer). Not global: `findContactSpans` scans
 * with global copies. `whatsapp_cue`, `gstin` and `pan` are refused in model
 * output only (see MASKED_CONTACT_KINDS).
 */
export const CONTACT_PATTERNS: Readonly<Record<Exclude<ContactKind, 'phone'>, readonly RegExp[]>> = {
  email: [
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    // "ravi [at] gmail [dot] com", "ravi(at)gmail.com", "ravi at gmail dot com" — a spelled "at" needs a spelled "dot".
    new RegExp(`\\b${LOCAL}(?:${AT_BRACKETED}${LABEL}(?:${DOT_SEP}${LABEL})*?${DOT_SEP}${MAIL_TLD}|\\s+at\\s+${LABEL}(?:${DOT_SEP}${LABEL})*?${DOT_WORD}${MAIL_TLD})\\b`, 'i'),
  ],
  // UPI VPA: name@bank (no dot-TLD after the handle): ravi@upi, 98765@ybl, shop.name@okaxis.
  upi: [/\b[A-Za-z0-9._-]{2,}@[A-Za-z][A-Za-z0-9_]{1,}\b(?!\.[A-Za-z])/],
  url: [
    /\b[Hh][Tt][Tt][Pp][Ss]?:\/\/[^\s<>"'()]+/,
    /\b[Ww]{3}\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}[^\s<>"'()]*/,
    new RegExp(`\\b[A-Za-z0-9][A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.(?:${TLD_ALTERNATION})\\b(?:\\/[^\\s<>"'()]*)?`),
  ],
  handle: [
    // wa.me / t.me / telegram.me / instagram.com / facebook.com / fb.com links
    /\b(?:wa|t|telegram)\.me\/[^\s<>"'()]+|\b(?:instagram|facebook|fb)\.com\/[^\s<>"'()]+/i,
    // "telegram: x", "insta id: x", "skype - x"
    /\b(?:telegram|insta(?:gram)?|skype|snapchat)\s*(?:id|handle)?\s*[:@-]\s*\S+/i,
    // a bare @handle (5+ characters, at least one letter), not an email's local part
    /(?<![A-Za-z0-9._%+-])@(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{5,}(?![A-Za-z0-9_@]|\.[A-Za-z])/,
  ],
  whatsapp_cue: [/\bwhatsapp\s*(?:me\s*)?(?:on|at|number|no\.?)\s*[:+\d]/i],
  gstin: [/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/],
  pan: [/\b[A-Z]{5}\d{4}[A-Z]\b/],
}

const GLOBAL_PATTERNS = {} as Record<Exclude<ContactKind, 'phone'>, readonly RegExp[]>
for (const kind of Object.keys(CONTACT_PATTERNS) as Exclude<ContactKind, 'phone'>[]) {
  GLOBAL_PATTERNS[kind] = CONTACT_PATTERNS[kind].map((re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))
}

// ── phones: the tokenizer ─────────────────────────────────────────────────────

interface PhoneToken {
  start: number
  end: number
  digits: string
  word: boolean
  plus: boolean
  mult: number
}

function phoneTokens(t: string): PhoneToken[] {
  const out: PhoneToken[] = []
  for (const m of t.matchAll(PHONE_TOKEN_RE)) {
    const start = m.index ?? 0
    const end = start + m[0].length
    if (m[2] !== undefined) {
      out.push({ start, end, digits: m[2], word: false, plus: m[1] === '+', mult: 0 })
      continue
    }
    const w = (m[3] ?? '').toLowerCase()
    const mult = NUMBER_MULTIPLIERS[w] ?? NUMBER_MULTIPLIERS[m[3] ?? ''] ?? 0
    const value = NUMBER_WORDS[w] ?? NUMBER_WORDS[m[3] ?? '']
    out.push({ start, end, digits: mult ? '' : String(value ?? ''), word: true, plus: false, mult })
  }
  return out
}

function gapOk(t: string, a: PhoneToken, b: PhoneToken): boolean {
  const gap = t.slice(a.end, b.start)
  return (a.word || b.word ? WORD_GAP_RE : DIGIT_GAP_RE).test(gap)
}

/** Clusters of tokens joined by short separators; "double x" folded into one token. */
function phoneClusters(t: string): PhoneToken[][] {
  const raw = phoneTokens(t)
  const clusters: PhoneToken[][] = []
  let cur: PhoneToken[] = []
  const flush = () => {
    if (cur.length) clusters.push(cur)
    cur = []
  }
  for (let k = 0; k < raw.length; k++) {
    let tok = raw[k]!
    if (tok.mult) {
      const next = raw[k + 1]
      if (next && !next.mult && next.digits.length === 1 && gapOk(t, tok, next)) {
        tok = { start: tok.start, end: next.end, digits: next.digits.repeat(tok.mult), word: true, plus: false, mult: 0 }
        k++
      } else {
        flush()
        continue
      }
    }
    const prev = cur[cur.length - 1]
    if (prev && !gapOk(t, prev, tok)) flush()
    cur.push(tok)
  }
  flush()
  return clusters
}

/** The longest phone number is 0091 + 10 digits. */
const MAX_PHONE_DIGITS = 14

function phoneSpans(t: string): [number, number][] {
  const spans: [number, number][] = []
  for (const c of phoneClusters(t)) {
    let i = 0
    while (i < c.length) {
      let acc = ''
      let best = -1
      for (let j = i; j < c.length; j++) {
        acc += c[j]!.digits
        if (acc.length > MAX_PHONE_DIGITS) break
        if (isPhoneDigits(acc, c[i]!.plus)) best = j
      }
      if (best >= 0) {
        spans.push([c[i]!.start, c[best]!.end])
        i = best + 1
      } else {
        i++
      }
    }
  }
  return spans
}

// ── the API ───────────────────────────────────────────────────────────────────

export interface ContactSpan {
  kind: ContactKind
  /** Indexes into the ORIGINAL text, [start, end). */
  start: number
  end: number
  /** The original characters. */
  match: string
}

/**
 * Every contact detail in `text`, in order of position (spans of different
 * kinds may overlap: an email is also a domain). `kinds` narrows the scan.
 */
export function findContactSpans(text: string, kinds: readonly ContactKind[] = CONTACT_KINDS): ContactSpan[] {
  const src = text ?? ''
  const { text: t, map } = foldForMatch(src)
  const out: ContactSpan[] = []
  const add = (kind: ContactKind, a: number, b: number) => {
    if (b <= a) return
    const start = map[a]!
    const end = map[b - 1]! + 1
    out.push({ kind, start, end, match: src.slice(start, end) })
  }
  const want = new Set(kinds)
  if (want.has('phone')) for (const [a, b] of phoneSpans(t)) add('phone', a, b)
  for (const kind of CONTACT_KINDS) {
    if (kind === 'phone' || !want.has(kind)) continue
    for (const re of GLOBAL_PATTERNS[kind]) {
      for (const m of t.matchAll(re)) {
        const a = m.index ?? 0
        if (kind === 'url' && URL_STOPLIST.test(m[0])) continue
        if (kind === 'upi' && isRateNotUpi(m[0])) continue
        add(kind, a, a + m[0].length)
      }
    }
  }
  return out.sort((x, y) => x.start - y.start || y.end - x.end)
}

export interface MaskResult {
  text: string
  redacted: boolean
  /** The kinds that were masked, deduplicated, in first-seen order. */
  kinds: ContactKind[]
}

/**
 * Replace every contact detail with `replacement` (default `[contact hidden]`).
 * Overlapping or touching spans become one replacement. `kinds` defaults to
 * MASKED_CONTACT_KINDS (phones, emails, UPI ids, links, handles).
 */
export function maskContactInfo(text: string, opts: { replacement?: string; kinds?: readonly ContactKind[] } = {}): MaskResult {
  const src = text ?? ''
  const spans = findContactSpans(src, opts.kinds ?? MASKED_CONTACT_KINDS)
  if (spans.length === 0) return { text: src, redacted: false, kinds: [] }
  const replacement = opts.replacement ?? CONTACT_MASK
  const merged: [number, number][] = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && s.start <= last[1]) last[1] = Math.max(last[1], s.end)
    else merged.push([s.start, s.end])
  }
  let out = ''
  let at = 0
  for (const [a, b] of merged) {
    out += src.slice(at, a) + replacement
    at = b
  }
  out += src.slice(at)
  return { text: out, redacted: true, kinds: [...new Set(spans.map((s) => s.kind))] }
}

/** True when the text carries any contact detail the storage masker would hide. */
export function hasContactInfo(text: string): boolean {
  return findContactSpans(text, MASKED_CONTACT_KINDS).length > 0
}
