/**
 * S2.4 — the optional coaching note on the provider's own AMC Score card (`score_note@v1`, ADR-010). The model is
 * fed NUMBERS and component keys only (no free text anywhere, so no untrusted surface) and writes ONE informational
 * sentence. It is output-policed twice: the customer-facing contract (contact / payment / ranking / approval / urls,
 * in agent-core) and this module's rules — no promise language, no number that was not in the input. On any
 * violation the card renders the deterministic tips alone (`note: null`). No ai_decisions row (informational).
 */
import { z } from 'zod'
import type { ProviderComponent } from './score'
import { SCORE_TIPS, toScoreTipLocale, type ScoreTipLocale } from './score-tips'

export const SCORE_NOTE_MAX = 280

export const scoreNoteSchema = z.object({ note: z.string().trim().min(1).max(SCORE_NOTE_MAX) }).strict()
export type ScoreNote = z.infer<typeof scoreNoteSchema>

/** Promises the platform cannot keep (a score never guarantees work). Case-insensitive substring match. */
export const SCORE_NOTE_PROMISE_PHRASES: Record<ScoreTipLocale, readonly string[]> = {
  en: ['guarantee', 'guaranteed', 'will increase your orders', 'will get you more orders', 'more orders for sure', 'you will win', 'promise', 'assured', 'certainly get', 'definitely get', 'will rank', 'rank higher', 'top of the list', 'first in the list'],
  hi: ['गारंटी', 'पक्का', 'ज़रूर मिलेंगे', 'जरूर मिलेंगे', 'ऑर्डर बढ़ जाएंगे', 'ऑर्डर बढ़ेंगे', 'वादा', 'सबसे ऊपर'],
  te: ['గ్యారంటీ', 'హామీ', 'ఖచ్చితంగా వస్తాయి', 'ఆర్డర్లు పెరుగుతాయి', 'వాగ్దానం', 'మొదటి స్థానం'],
  ta: ['உத்தரவாதம்', 'நிச்சயமாக கிடைக்கும்', 'ஆர்டர்கள் அதிகரிக்கும்', 'வாக்குறுதி', 'முதலிடம்'],
}

// Devanagari, Telugu and Tamil digit zeros → 0..9
const INDIC_DIGITS: Record<string, string> = {}
for (const base of [0x0966, 0x0c66, 0x0be6]) for (let i = 0; i < 10; i++) INDIC_DIGITS[String.fromCharCode(base + i)] = String(i)
function foldDigits(s: string): string {
  return s.replace(/[०-९౦-౯௦-௯]/g, (c) => INDIC_DIGITS[c] ?? c)
}

/**
 * Problems with a note (empty = fine): a promise phrase in ANY locale's list, or a number that is not one of the
 * input numbers (component values, weights, the score). Indic digits are folded first.
 */
export function scoreNoteProblems(note: string, allowedNumbers: readonly number[]): string[] {
  const out: string[] = []
  const lower = note.toLowerCase()
  for (const list of Object.values(SCORE_NOTE_PROMISE_PHRASES)) for (const p of list) if (lower.includes(p.toLowerCase())) out.push(`promise: ${p}`)
  const allowed = new Set(allowedNumbers.map((n) => String(Math.round(n))))
  for (const d of foldDigits(note).match(/\d+(?:[.,]\d+)?/g) ?? []) {
    const plain = d.replace(/[.,]\d+$/, '')
    if (!allowed.has(plain)) out.push(`number not in the input: ${d}`)
  }
  return out
}

const LEAD: Record<ScoreTipLocale, string> = {
  en: 'One thing to work on this week:',
  hi: 'इस हफ़्ते ध्यान देने लायक एक बात:',
  te: 'ఈ వారం దృష్టి పెట్టాల్సిన ఒక విషయం:',
  ta: 'இந்த வாரம் கவனிக்க வேண்டிய ஒன்று:',
}
const ALL_GOOD: Record<ScoreTipLocale, string> = {
  en: 'Every part of your record is healthy. Keep replying, delivering on time and uploading your work photos.',
  hi: 'आपके रिकॉर्ड का हर हिस्सा अच्छा है। जवाब देते रहें, समय पर डिलीवर करें और काम की फ़ोटो अपलोड करते रहें।',
  te: 'మీ రికార్డులోని ప్రతి భాగం బాగుంది. స్పందిస్తూ ఉండండి, సమయానికి డెలివర్ చేయండి, పని ఫోటోలు అప్‌లోడ్ చేస్తూ ఉండండి.',
  ta: 'உங்கள் பதிவின் ஒவ்வொரு பகுதியும் நன்றாக உள்ளது. பதிலளிப்பதைத் தொடருங்கள், சரியான நேரத்தில் டெலிவர் செய்யுங்கள், வேலைப் புகைப்படங்களைப் பதிவேற்றுங்கள்.',
}

/** The keyless / fallback note: the lead line + the weakest component's tip (no numbers, no promises). */
export function stubScoreNote(locale: string | null | undefined, weakest: ProviderComponent | null): ScoreNote {
  const l = toScoreTipLocale(locale)
  const text = weakest ? `${LEAD[l]} ${SCORE_TIPS[l][weakest]}` : ALL_GOOD[l]
  return { note: text.length > SCORE_NOTE_MAX ? text.slice(0, SCORE_NOTE_MAX - 1).trimEnd() + '…' : text }
}
