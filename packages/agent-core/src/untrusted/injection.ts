/**
 * S2.1 — the instruction-pattern detector. Scores third-party text for the
 * families of prompt injection the programme has seen in its golden sets:
 * override phrases, role claims, tool / API invocations, exfiltration
 * requests, off-platform payment, fake tag closes, JSON-shaped output
 * attempts — in English, Hindi, Telugu, Tamil and Hinglish.
 *
 * Detect and log, never block: the score marks the Envelope and (in a run)
 * writes an `injection_suspected` event; the model still sees the content
 * inside the tags. Blocking would let an attacker lock a buyer's own RFQ by
 * quoting a phrase. Hard refusal lives in the output contract (output.ts).
 *
 * Pure. The weighted sum of DISTINCT rules hit, capped at 100; ≥ 40 is
 * "suspected". Weights are chosen so one clear override / tool / payment /
 * tag-forge phrase crosses the line alone, while a bare word ("cash",
 * "approved", "system") stays below it.
 */

export type InjectionFamily = 'override' | 'role' | 'tool' | 'exfil' | 'payment' | 'tag_forge' | 'json_forge'

export interface InjectionRule {
  id: string
  family: InjectionFamily
  re: RegExp
  weight: number
}

export const INJECTION_SUSPECT_THRESHOLD = 40

// Devanagari, Telugu, Tamil, Bengali and Gujarati digits → ASCII, so phone
// masking and the detector see the same number the reader sees.
const INDIC_DIGIT_BLOCKS = [0x0966, 0x0c66, 0x0be6, 0x09e6, 0x0ae6]
export function foldIndicDigits(s: string): string {
  let out = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    let mapped: string | null = null
    for (const base of INDIC_DIGIT_BLOCKS) {
      if (cp >= base && cp <= base + 9) { mapped = String(cp - base); break }
    }
    out += mapped ?? ch
  }
  return out
}

const r = (id: string, family: InjectionFamily, re: RegExp, weight: number): InjectionRule => ({ id, family, re, weight })

export const INJECTION_RULES: readonly InjectionRule[] = [
  // ── override ───────────────────────────────────────────────────────────────
  r('override.ignore_previous', 'override', /\b(ignore|disregard|forget|override|skip)\s+(?:(?:all|any|the|of|previous|prior|earlier|above|these|those|your|my|system|other)\s+){1,3}(instructions?|rules?|prompts?|guidelines?|directions?|constraints?)\b/i, 45),
  // S2.2 — 'ignore your price book' / 'skip the policy' / 'disregard the system prompt': an override aimed at a named artefact.
  r('override.ignore_object', 'override', /\b(ignore|disregard|forget|skip|bypass)\s+(?:(?:all|any|the|your|my|our|this|that|of)\s+){0,2}(price\s?book|price\s?history|policy|policies|guardrails?|system\s?prompt|safety\s+(?:rules?|checks?)|band|clamp|allow-?list)\b/i, 40),
  r('override.new_instructions', 'override', /\b(new|updated|real|actual|revised|secret)\s+(instructions?|task|rules?|prompt)\s*[:\-]/i, 40),
  r('override.system_prefix', 'override', /(^|[\n\r]|[.!?]\s+)\s*(system|assistant|developer|instruction)\s*:/i, 40),
  r('override.from_now_on', 'override', /\b(from now on|starting now|henceforth|for the rest of (this|the) (conversation|chat))\b/i, 25),
  r('override.hi', 'override', /(पिछले|पहले|ऊपर|ऊपरी|सारे|सिस्टम)\s*(के\s*|की\s*)?(निर्देश|आदेश|नियम|हिदायत)(ों)?\s*(को\s*)?(भूल|अनदेख|नज़रअंदाज़|नजरअंदाज|छोड़|रद्द)/, 45),
  r('override.hi_new', 'override', /(नए|नई|असली)\s*(निर्देश|आदेश|नियम)\s*[:\-]/, 40),
  r('override.hinglish', 'override', /\b(pichle|pichhle|purane|upar ke|saare|sare|system ke)\s+(instructions?|rules?|nirdesh|niyam)\s+(ko\s+)?(ignore|bhool|bhul|chhod|chod|bhulo|nazarandaz)/i, 45),
  r('override.te', 'override', /(మునుపటి|పైన|గత|అన్ని|సిస్టమ్)\s*(సూచనల|ఆదేశాల|నియమాల|సూచనలను|ఆదేశాలను)(ను|ని)?\s*(విస్మరించ|మర్చిపో|పట్టించుకోక|వదిలేయ)/, 45),
  r('override.te_new', 'override', /(కొత్త|అసలు)\s*(సూచనలు|ఆదేశాలు|నియమాలు)\s*[:\-]/, 40),
  r('override.ta', 'override', /(முந்தைய|மேலே|மேலுள்ள|முன்|எல்லா|சிஸ்டம்)\s*(அறிவுறுத்தல்|வழிமுறை|விதி|கட்டளை)(கள)?(ை)?\s*(புறக்கணி|மற|மறந்து|விட்டுவிடு)/, 45),
  r('override.ta_new', 'override', /(புதிய|உண்மையான)\s*(வழிமுறைகள்|அறிவுறுத்தல்கள்|விதிகள்)\s*[:\-]/, 40),
  // ── role claims ────────────────────────────────────────────────────────────
  r('role.i_am', 'role', /\b(i am|i'm|this is|we are)\s+(the\s+|an?\s+)?(admin|administrator|founder|ops|operator|moderator|owner of amclub|amclub (staff|team|support|admin)|system|developer)\b/i, 40),
  r('role.as_the', 'role', /\b(as|being)\s+(the|an?)\s+(admin|administrator|founder|ops|operator|system|developer|moderator)\b/i, 40),
  r('role.you_are_now', 'role', /\b(you are now|you're now|act as|pretend (to be|you are)|behave as)\s+(the\s+|an?\s+)?(admin|system|developer|unrestricted|jailbroken|root|founder)/i, 40),
  r('role.hi', 'role', /(मैं|मै|हम)\s*(एडमिन|ऐडमिन|फाउंडर|संस्थापक|ऑप्स|सिस्टम|डेवलपर|मॉडरेटर)\s*(हूँ|हूं|हैं)/, 40),
  r('role.hi_you', 'role', /(अब\s*(से\s*)?)?(तुम|आप)\s*(एडमिन|सिस्टम|डेवलपर)\s*(हो|हैं)/, 40),
  r('role.hinglish', 'role', /\b(main|mai|mein|hum)\s+(admin|founder|ops|system|developer)\s+(hoon|hun|hu|hain|hai)\b/i, 40),
  r('role.te', 'role', /(నేను|మేము)\s*(అడ్మిన్|ఫౌండర్|ఆప్స్|సిస్టమ్|డెవలపర్)/, 40),
  r('role.ta', 'role', /(நான்|நாங்கள்)\s*(அட்மின்|நிறுவனர்|ஆப்ஸ்|சிஸ்டம்|டெவலப்பர்)/, 40),
  // ── tool / API invocations ─────────────────────────────────────────────────
  r('tool.call_tool', 'tool', /\b(call|invoke|run|use|execute|trigger)\s+(the\s+)?[\w-]+\s+(tool|function|endpoint)\b/i, 40),
  // S2.3 — 'call nudge_counterparty now', 'run submit_quote': a snake_case identifier after a call verb is a tool name.
  r('tool.call_snake', 'tool', /\b(call|invoke|run|execute|trigger|fire)\s+(the\s+)?[a-z]+(?:_[a-z]+)+\b/i, 40),
  r('tool.api', 'tool', /\b(POST|PATCH|PUT|DELETE|GET)\s+\/api\b|\/api\/v1\/(admin|agent|payouts?|orders)\b/i, 40),
  r('tool.money', 'tool', /\b(release|approve|authori[sz]e|process)\s+(the\s+|my\s+|our\s+)?(payout|refund|payment|funds|escrow)\b|\bmark\s+(\w+\s+){0,3}(as\s+)?(verified|approved|paid|resolved|complete|delivered)\b|\b(resolve|close|decide)\s+(the\s+|this\s+)?dispute\s+(in|for)\s+(my|our|the (buyer|provider|seller))\b|\bset\s+(the\s+)?(status|payout|kyc)\s+(to|=)\b/i, 45),
  r('tool.approve_quote', 'tool', /\b(accept|approve|select|choose)\s+(this|my|our)\s+(quote|bid|offer)\s+(automatically|now|immediately|for the buyer)\b|\bauto[- ]?(accept|approve)\b/i, 35),
  r('tool.hi', 'tool', /(पेआउट|भुगतान|रिफंड|पैसे|एस्क्रो)\s*(को\s*)?(रिलीज़|रिलीज|जारी|मंज़ूर|मंजूर|पास)\s*(करो|करें|कर दो|कर दीजिए)/, 45),
  r('tool.hi_verify', 'tool', /(वेरिफाइड|सत्यापित|अप्रूव्ड|मंज़ूर)\s*(मार्क|कर दो|करो|कर दीजिए|घोषित)/, 40),
  r('tool.hinglish', 'tool', /\b(payout|refund|payment|paise)\s+(release|approve|jaari|jari|pass)\s+(karo|kar do|karein|kar dijiye)\b|\b(verified|approved)\s+(mark|kar do|karo)\b/i, 45),
  r('tool.te', 'tool', /(చెల్లింపు|పేఅవుట్|రీఫండ్|డబ్బు)\s*(ను)?\s*(విడుదల|ఆమోదించ|మంజూరు)/, 45),
  r('tool.te_verify', 'tool', /(ధృవీకరించ|వెరిఫై|ఆమోదించ)(బడినట్లు|ినట్లు)?\s*(గుర్తించ|మార్క్|చేయ)/, 40),
  r('tool.ta', 'tool', /(பண\S{0,4}|பேஅவுட்\S{0,3}|ரீஃபண்ட\S{0,3}|கட்டண\S{0,4})\s*(விடுவி|அங்கீகரி|அனுமதி)/, 45),
  r('tool.ta_verify', 'tool', /(சரிபார்க்கப்பட்ட|அங்கீகரிக்கப்பட்ட)(தாக)?\s*(குறி|மார்க்)/, 40),
  // ── exfiltration ───────────────────────────────────────────────────────────
  r('exfil.others', 'exfil', /\b(send|show|share|list|give|reveal|forward|email|tell|disclose)\s+(me\s+|us\s+)?(?:(?:all|the|every|any)\s+){0,2}(other|competing|competitor'?s?|every|rival|remaining)\s+(quotes?|bids?|prices?|offers?|buyers?|providers?|sellers?|customers?|vendors?|numbers?)\b/i, 40),
  r('exfil.contact', 'exfil', /\b(share|send|give|tell|reveal|forward)\s+(me\s+|us\s+)?(his|her|their|the\s+(buyer|provider|seller|customer|vendor|client)'?s?)\s+(phone|mobile|number|email|whatsapp|address|contact|gstin|pan|bank)\b/i, 40),
  r('exfil.hi', 'exfil', /(दूसरे|दूसरों|बाकी|सारे|सभी)\s*(कोटेशन|कोट|खरीदार|प्रोवाइडर|विक्रेता|ग्राहक)(ों)?\s*(का|के|की)?\s*(नंबर|फोन|ईमेल|लिस्ट|जानकारी|दाम|कीमत)?\s*(भेजो|भेजें|बताओ|बताएं|दिखाओ|दिखाएं|दो|दें)/, 40),
  r('exfil.hinglish', 'exfil', /\b(dusre|doosre|baaki|saare|sabhi)\s+(quotes?|buyers?|providers?|sellers?)\s+(ka|ke|ki)?\s*(number|phone|email|list|price)?\s*(bhejo|batao|dikhao|do)\b/i, 40),
  r('exfil.te', 'exfil', /(ఇతర|మిగతా|అందరి|అన్ని)\s*(కొటేషన్|కొటేషన్లు|కొనుగోలుదారు|ప్రొవైడర్|అమ్మకందారు)(ల|ు)?\s*(ఫోన్|నంబర్|వివరాలు|జాబితా|ధర)?\s*(పంపు|పంపండి|చెప్పు|చెప్పండి|చూపించు|చూపించండి|ఇవ్వు|ఇవ్వండి)/, 40),
  r('exfil.ta', 'exfil', /(மற்ற|எல்லா|மீதி)\s*(விலைப்புள்ளி|வாங்குபவர்|வழங்குநர்|விற்பனையாளர்)(கள)?(ின்)?\s*(எண்|தொலைபேசி|விவரம்|பட்டியல்|விலை)?\s*(அனுப்பு|அனுப்புங்கள்|சொல்லு|சொல்லுங்கள்|காட்டு|காட்டுங்கள்|கொடு)/, 40),
  // ── off-platform payment ───────────────────────────────────────────────────
  r('payment.direct', 'payment', /\bpay\s+(me|us|him|her|them)\s+(directly|in cash|by cash|via upi|on upi|through upi|to my|to our|outside)\b|\bdirect\s+(payment|transfer|bank transfer)\s+(to|into)\s+(my|our|his|her)\b|\b(transfer|send|pay)\s+(it|the (money|amount|advance|payment|balance))\s+(directly\s+)?(to|into)\s+(my|our|his|her|their)\s+(account|upi|number|wallet)\b/i, 40),
  r('payment.upi', 'payment', /\b(my|our|his|her)\s+upi(\s*id|\s*number)?\b|\bupi\s*(id|vpa)\s*[:=]|\b(gpay|google\s*pay|phonepe|phone\s*pe|paytm)\s+(number|id|to|me|us|par|pe)\b|\b(send|transfer|pay)\s+(the\s+)?(money|amount|payment|advance|balance)\s+(to|via|on|through)\s+(my|our|upi|gpay|phonepe|paytm)\b|\b[a-z0-9._-]{2,}@(ybl|okaxis|oksbi|okicici|okhdfcbank|paytm|upi|ibl|axl|apl)\b/i, 40),
  r('payment.account', 'payment', /\b(my|our)\s+(bank\s+)?(account|a\/c)\s+(number|no\.?|details|is)\b|\bifsc\s*(code)?\s*[:=]?\s*[A-Z]{4}0/i, 30),
  r('payment.outside', 'payment', /\b(outside|off|bypass(ing)?|without|skip(ping)?|avoid(ing)?)\s+(of\s+)?(the\s+)?(app|platform|amclub|website|site|escrow|portal)\b|\boff[- ]platform\b|\b(deal|settle|do it)\s+(directly|privately|outside)\b|\binstead of (the\s+)?(app|platform|amclub|escrow|portal)\b/i, 40),
  r('payment.cash', 'payment', /\b(cash\s+(only|payment\s+only|deal|directly|to me|to us|in hand)|in\s+cash\s+(only|directly|to me|to us)|(only|just)\s+cash\b)/i, 30),
  r('payment.hi', 'payment', /(सीधे|सीधा|डायरेक्ट)\s*(मुझे|हमें|मेरे|हमारे|मेरा|हमारा)\s*(पैसे|पेमेंट|भुगतान|यूपीआई|खाते|खाता|अकाउंट)|(पैसे|पेमेंट|भुगतान|रकम)\s*(मुझे\s*|हमें\s*)?(सीधे|सीधा|डायरेक्ट)\s*(भेज|दे|कर|ट्रांसफर)/, 40),
  r('payment.hi_outside', 'payment', /(ऐप|एप|प्लेटफ़ॉर्म|प्लेटफॉर्म|साइट|वेबसाइट|एस्क्रो)\s*(के\s*|से\s*)?(बाहर|बिना|छोड़कर)/, 40),
  r('payment.hi_upi', 'payment', /(मेरा|हमारा|मेरे|हमारे)\s*(यूपीआई|गूगल पे|फोनपे|फोन पे|पेटीएम|खाता नंबर|अकाउंट नंबर|बैंक खाता)/, 40),
  r('payment.hi_cash', 'payment', /(सिर्फ|केवल)\s*नकद|नकद\s*में\s*(ही\s*)?(भुगतान|दो|दें)/, 30),
  r('payment.hinglish', 'payment', /\b(seedha|seedhe|seedhi|direct)\s+(mujhe|humein|hume|mere|hamare|mera|hamara)\s+(paise|paisa|payment|upi|account|khate)\b|\b(app|platform|site|escrow)\s+(ke|se)\s+bahar\b|\b(mera|hamara|mere|hamare)\s+(upi|gpay|phonepe|paytm|account\s+number|khata)\b|\bcash\s+(mein|me)\s+(hi\s+)?(do|dena|dijiye)\b/i, 40),
  r('payment.te', 'payment', /(నేరుగా|డైరెక్ట్|డైరెక్టుగా)\s*(నాకు|మాకు|నా|మా)\s*(డబ్బు|చెల్లింపు|పేమెంట్|యూపీఐ|ఖాతా|అకౌంట్)/, 40),
  r('payment.te_outside', 'payment', /(యాప్|ప్లాట్‌ఫారమ్|ప్లాట్ఫారమ్|సైట్|వెబ్‌సైట్|ఎస్క్రో)\s*(కి\s*|కు\s*|నుండి\s*)?(బయట|వెలుపల|లేకుండా)/, 40),
  r('payment.te_upi', 'payment', /(నా|మా)\s*(యూపీఐ|గూగుల్ పే|ఫోన్‌పే|ఫోన్ పే|పేటీఎం|ఖాతా నంబర్|అకౌంట్ నంబర్|బ్యాంక్ ఖాతా)/, 40),
  r('payment.te_cash', 'payment', /(కేవలం|మాత్రమే)\s*నగదు|నగదు\s*(మాత్రమే|లో\s*(మాత్రమే\s*)?(చెల్లించ|ఇవ్వ))/, 30),
  r('payment.ta', 'payment', /(நேரடியாக|நேரடி|டைரக்ட்)\s*(எனக்கு|எங்களுக்கு|என்|எங்கள்)\s*(பணம்|கட்டணம்|பேமெண்ட்|யூபிஐ|கணக்கு|அக்கவுண்ட்)/, 40),
  r('payment.ta_outside', 'payment', /(ஆப்|செயலி|தளம்|தளத்த|சைட்|இணையதள|எஸ்க்ரோ)\S*\s*(ிற்கு\s*|க்கு\s*)?(வெளியே|இல்லாமல்|தவிர்த்து)/, 40),
  r('payment.ta_upi', 'payment', /(என்|எங்கள்|எனது|எங்களது)\s*(யூபிஐ|கூகுள் பே|போன்பே|போன் பே|பேடிஎம்|கணக்கு எண்|அக்கவுண்ட் எண்|வங்கிக் கணக்கு)/, 40),
  r('payment.ta_cash', 'payment', /(மட்டும்|மட்டுமே)\s*(ரொக்கம்|பணம்)|ரொக்கமாக\s*(மட்டும்\s*)?(கொடு|செலுத்த)/, 30),
  // ── tag forgery ────────────────────────────────────────────────────────────
  r('tag.untrusted', 'tag_forge', /<\/?\s*untrusted\b/i, 45),
  r('tag.system', 'tag_forge', /<\/?\s*(system|assistant|instructions?|tool_call|function_call|developer|prompt)\b[^>]*>/i, 40),
  r('tag.bracket', 'tag_forge', /\[(system|assistant|instructions?|admin)\]/i, 25),
  // ── JSON-shaped output attempts ────────────────────────────────────────────
  r('json.keys', 'json_forge', /\{\s*"(intent|escalate|reply|refund_paise|suggested_next|summary|edit_instructions|question|skip_reason|recommendation|status|decision|approved|verified|tool|action|category_slug|doc_type|resolution|amount_paise|facts|pointers|message|price_paise|scope_summary|delivery_days|confidence|findings|question|gap|specific_enough|gaps|profile|uncertain|reply)"\s*:/i, 40),
  r('json.fence', 'json_forge', /```\s*(json)?\s*[\r\n]*\s*\{/i, 20),
  r('json.output_the', 'json_forge', /\b(output|return|respond with|reply with|answer with)\s+(only\s+)?(the\s+)?(following\s+)?(json\b|\{)/i, 25),
]

export interface InjectionScore {
  score: number
  hits: string[]
}

/** Score third-party text. `locale` is accepted for API stability; every rule runs regardless. */
export function scoreInjection(text: string, locale?: string): InjectionScore {
  void locale // reserved: every rule runs for every locale today; a locale-aware rule table is a later pass
  const t = foldIndicDigits((text ?? '').normalize('NFKC'))
  const hits: string[] = []
  let score = 0
  for (const rule of INJECTION_RULES) {
    rule.re.lastIndex = 0
    if (rule.re.test(t)) {
      hits.push(rule.id)
      score += rule.weight
    }
  }
  return { score: Math.min(100, score), hits }
}

export function isInjectionSuspected(s: InjectionScore): boolean {
  return s.score >= INJECTION_SUSPECT_THRESHOLD
}
