/**
 * "What can you help me with?" — a deterministic text match (S2.3 support).
 *
 * The classifier has no intent for a question about the assistant itself, so
 * it lands in `other` and used to get the "I did not quite get that" template.
 * The engine consults this ONLY on a turn the model left unclear (`other`, or
 * a how-to with no topic) and not escalated: then the reply is the
 * `capabilities` template (what the assistant can do, with examples) and the
 * turn does not count toward the unclear streak. A match never overrides a
 * real intent or an escalation, and no text is generated — the template is
 * fixed copy in `@amclub/shared` (`SUPPORT_COPY`).
 */
const PATTERNS: readonly RegExp[] = [
  // en — "what can you help me with", "what can you do", "how can you help", "what do you do"
  /\b(what|how)\b[^?.!]{0,20}?\b(can|could|do|will|would)\s+(you|u)\s+(help|do|assist|support)\b/,
  /\bwhat\s+(are|r)\s+(you|u)\s+(for|able to do|capable of)\b/,
  /\bwho\s+(are|r)\s+(you|u)\b/,
  /\bwhat\s+(can|should)\s+i\s+ask\b/,
  /\b(your\s+)?(features|capabilities)\b/,
  /^(help|help me|menu|options)$/,
  // hi — "आप क्या मदद कर सकते हैं", "आप क्या कर सकते हैं", "kis cheez mein madad kar sakte ho"
  /(क्या|किस|किसमें|किन).{0,20}(मदद|सहायता|कर सकते|कर सकती)/,
  /^(मदद|सहायता)$/,
  /\b(kya|kis|kisme|kismein)\b.{0,20}\b(madad|help|kar sakte|kar sakti)\b/,
  /^(madad|sahayata)$/,
  // te — "మీరు ఏమి సహాయం చేయగలరు", "ఏం చేయగలరు"
  /(ఏమి|ఏం|ఏ).{0,20}(సహాయం|చేయగల)/,
  /^సహాయం$/,
  // ta — "நீங்கள் என்ன உதவி செய்ய முடியும்", "என்ன செய்ய முடியும்"
  /என்ன.{0,20}(உதவி|செய்ய முடியும்)/,
  /^உதவி$/,
]

/** Lower-cased, trimmed, trailing punctuation dropped (so "Help?" and "help" match the same bare-word rule). */
function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[\s?!.।॥]+$/u, '').trim()
}

export function isSupportCapabilitiesQuestion(text: string): boolean {
  const t = norm(text)
  if (!t || t.length > 160) return false
  return PATTERNS.some((re) => re.test(t))
}
