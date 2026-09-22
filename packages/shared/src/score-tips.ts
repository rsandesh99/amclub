/**
 * S2.4 — deterministic "how to raise it" tips for the provider's own AMC Score card (ADR-010). One tip per
 * component × locale, each tied to something the provider can do on the platform today. Fixed copy, never a
 * model; no numbers (the card shows the numbers from the snapshot).
 */
import type { ProviderComponent } from './score'

export const SCORE_TIP_LOCALES = ['en', 'hi', 'te', 'ta'] as const
export type ScoreTipLocale = (typeof SCORE_TIP_LOCALES)[number]

export const SCORE_TIPS: Record<ScoreTipLocale, Record<ProviderComponent, string>> = {
  en: {
    responsiveness: 'Reply to new requests sooner. Turn on Munshi reminders so a draft quote is waiting when a request arrives.',
    on_time: 'Set delivery days you can keep on your quotes and packages, then mark the work delivered by that date.',
    buyer_confirmation: 'Upload the work-complete photo when you deliver, so the buyer can confirm quickly instead of waiting for the automatic close.',
    dispute_record: 'Ask a clarification before quoting when the scope is unclear, and record any change in the order thread.',
    decision_rate: 'Decline with a reason instead of letting a request lapse. A decline counts as a response.',
  },
  hi: {
    responsiveness: 'नई माँगों का जवाब जल्दी दें। मुंशी रिमाइंडर चालू करें, ताकि माँग आते ही कोटेशन का मसौदा तैयार मिले।',
    on_time: 'कोटेशन और पैकेज में उतने ही डिलीवरी दिन रखें जितने निभा सकें, और उसी तारीख़ तक काम डिलीवर करें।',
    buyer_confirmation: 'डिलीवरी के समय काम पूरा होने की फ़ोटो अपलोड करें, ताकि ख़रीदार अपने-आप बंद होने का इंतज़ार किए बिना जल्दी पुष्टि कर सके।',
    dispute_record: 'दायरा साफ़ न हो तो कोटेशन से पहले स्पष्टीकरण पूछें, और हर बदलाव ऑर्डर थ्रेड में दर्ज करें।',
    decision_rate: 'माँग को यूँ ही समाप्त होने देने के बजाय कारण बताकर अस्वीकार करें। अस्वीकार करना भी जवाब माना जाता है।',
  },
  te: {
    responsiveness: 'కొత్త అభ్యర్థనలకు త్వరగా స్పందించండి. మున్షీ రిమైండర్లు ఆన్ చేయండి, అభ్యర్థన రాగానే కొటేషన్ డ్రాఫ్ట్ సిద్ధంగా ఉంటుంది.',
    on_time: 'మీ కొటేషన్లు, ప్యాకేజీలలో నిలబెట్టుకోగల డెలివరీ రోజులు పెట్టండి, ఆ తేదీలోగా పనిని డెలివర్ చేయండి.',
    buyer_confirmation: 'డెలివరీ సమయంలో పని పూర్తైన ఫోటో అప్‌లోడ్ చేయండి, కొనుగోలుదారు ఆటోమేటిక్ ముగింపు కోసం ఆగకుండా త్వరగా నిర్ధారించగలరు.',
    dispute_record: 'పరిధి స్పష్టంగా లేకపోతే కొటేషన్ ముందు వివరణ అడగండి, ప్రతి మార్పును ఆర్డర్ థ్రెడ్‌లో నమోదు చేయండి.',
    decision_rate: 'అభ్యర్థన గడువు ముగిసేలా వదిలేయకుండా కారణంతో తిరస్కరించండి. తిరస్కరించడం కూడా స్పందనగానే లెక్కించబడుతుంది.',
  },
  ta: {
    responsiveness: 'புதிய கோரிக்கைகளுக்கு விரைவாகப் பதிலளியுங்கள். முன்ஷி நினைவூட்டல்களை இயக்குங்கள்; கோரிக்கை வந்ததும் மேற்கோள் வரைவு தயாராக இருக்கும்.',
    on_time: 'உங்கள் மேற்கோள்கள், தொகுப்புகளில் காக்கக்கூடிய டெலிவரி நாட்களை வையுங்கள்; அந்தத் தேதிக்குள் வேலையை டெலிவர் செய்யுங்கள்.',
    buyer_confirmation: 'டெலிவரி செய்யும்போது வேலை முடிந்த புகைப்படத்தைப் பதிவேற்றுங்கள்; வாங்குபவர் தானியங்கி முடிவுக்குக் காத்திருக்காமல் விரைவாக உறுதிப்படுத்தலாம்.',
    dispute_record: 'பணி வரம்பு தெளிவாக இல்லையெனில் மேற்கோளுக்கு முன் விளக்கம் கேளுங்கள்; ஒவ்வொரு மாற்றத்தையும் ஆர்டர் உரையாடலில் பதிவு செய்யுங்கள்.',
    decision_rate: 'கோரிக்கையை காலாவதியாக விடாமல் காரணத்துடன் மறுக்கவும். மறுப்பதும் பதிலாகவே கணக்கிடப்படும்.',
  },
}

export function toScoreTipLocale(l: string | null | undefined): ScoreTipLocale {
  const base = (l ?? 'en').toLowerCase().split(/[-_]/)[0] ?? 'en'
  return (SCORE_TIP_LOCALES as readonly string[]).includes(base) ? (base as ScoreTipLocale) : 'en'
}

export function scoreTip(component: ProviderComponent, locale: string | null | undefined): string {
  return SCORE_TIPS[toScoreTipLocale(locale)][component]
}
