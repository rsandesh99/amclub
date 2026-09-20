import { compareLabel, type CompareFlag, type ComparePointers, type CompareQuoteResult, type PointerLocale } from '@amclub/shared'

/**
 * Stub producer for `quote_compare@v1` (keyless / CI and the eval): one line
 * per flag (≤ 3), restated in the target locale from a fixed phrase table.
 * Deterministic, schema-valid, and free of the banned phrases by construction.
 */
const PHRASES: Record<PointerLocale, Record<CompareFlag, string>> = {
  en: {
    gst_not_included: 'Quote {L}: GST is not included — the normalised total adds it.',
    gst_unstated: 'Quote {L}: GST is unstated — confirm before comparing totals.',
    transport_not_included: 'Quote {L}: transport is not included and will be extra.',
    transport_unstated: 'Quote {L}: transport is unstated — ask whether it is included.',
    delivery_unstated: 'Quote {L}: delivery time is unstated.',
    validity_short: 'Quote {L}: the price is valid for only a few more days.',
    validity_expired: 'Quote {L}: the stated validity date has already passed.',
    advance_high: 'Quote {L}: asks for more than half the amount in advance.',
    advance_unstated: 'Quote {L}: advance terms are unstated.',
    cheapest_after_normalization: 'Quote {L}: lowest normalised total in this set.',
    fastest: 'Quote {L}: shortest stated delivery in this set.',
    only_quote: 'Quote {L}: the only quote so far — nothing to compare against yet.',
  },
  hi: {
    gst_not_included: 'कोटेशन {L}: GST शामिल नहीं है — सामान्यीकृत कुल में इसे जोड़ा गया है।',
    gst_unstated: 'कोटेशन {L}: GST के बारे में कुछ नहीं कहा गया — कुल की तुलना से पहले पुष्टि करें।',
    transport_not_included: 'कोटेशन {L}: ट्रांसपोर्ट शामिल नहीं है और अतिरिक्त लगेगा।',
    transport_unstated: 'कोटेशन {L}: ट्रांसपोर्ट के बारे में कुछ नहीं कहा गया — पूछें कि शामिल है या नहीं।',
    delivery_unstated: 'कोटेशन {L}: डिलीवरी का समय नहीं बताया गया।',
    validity_short: 'कोटेशन {L}: कीमत केवल कुछ और दिनों के लिए मान्य है।',
    validity_expired: 'कोटेशन {L}: बताई गई वैधता तिथि बीत चुकी है।',
    advance_high: 'कोटेशन {L}: आधे से अधिक राशि एडवांस में माँगी गई है।',
    advance_unstated: 'कोटेशन {L}: एडवांस की शर्तें नहीं बताई गईं।',
    cheapest_after_normalization: 'कोटेशन {L}: इस सेट में सबसे कम सामान्यीकृत कुल।',
    fastest: 'कोटेशन {L}: इस सेट में सबसे कम बताया गया डिलीवरी समय।',
    only_quote: 'कोटेशन {L}: अभी तक एकमात्र कोटेशन — तुलना के लिए और कुछ नहीं।',
  },
  ta: {
    gst_not_included: 'விலைப்புள்ளி {L}: GST சேர்க்கப்படவில்லை — சீரமைத்த மொத்தத்தில் சேர்க்கப்பட்டுள்ளது.',
    gst_unstated: 'விலைப்புள்ளி {L}: GST குறிப்பிடப்படவில்லை — மொத்தத்தை ஒப்பிடும் முன் உறுதிப்படுத்தவும்.',
    transport_not_included: 'விலைப்புள்ளி {L}: போக்குவரத்து சேர்க்கப்படவில்லை, கூடுதலாகும்.',
    transport_unstated: 'விலைப்புள்ளி {L}: போக்குவரத்து குறிப்பிடப்படவில்லை — சேர்க்கப்பட்டுள்ளதா எனக் கேட்கவும்.',
    delivery_unstated: 'விலைப்புள்ளி {L}: வழங்கும் காலம் குறிப்பிடப்படவில்லை.',
    validity_short: 'விலைப்புள்ளி {L}: விலை இன்னும் சில நாட்களுக்கே செல்லுபடியாகும்.',
    validity_expired: 'விலைப்புள்ளி {L}: குறிப்பிட்ட செல்லுபடி தேதி முடிந்துவிட்டது.',
    advance_high: 'விலைப்புள்ளி {L}: பாதிக்கும் மேலான தொகை முன்பணமாகக் கேட்கப்படுகிறது.',
    advance_unstated: 'விலைப்புள்ளி {L}: முன்பண நிபந்தனைகள் குறிப்பிடப்படவில்லை.',
    cheapest_after_normalization: 'விலைப்புள்ளி {L}: இந்தத் தொகுப்பில் மிகக் குறைந்த சீரமைத்த மொத்தம்.',
    fastest: 'விலைப்புள்ளி {L}: இந்தத் தொகுப்பில் மிகக் குறைந்த குறிப்பிட்ட வழங்கும் காலம்.',
    only_quote: 'விலைப்புள்ளி {L}: இதுவரை ஒரே விலைப்புள்ளி — ஒப்பிட வேறு எதுவும் இல்லை.',
  },
  te: {
    gst_not_included: 'కొటేషన్ {L}: GST కలిసి లేదు — సాధారణీకరించిన మొత్తంలో అది కలిపారు.',
    gst_unstated: 'కొటేషన్ {L}: GST గురించి చెప్పలేదు — మొత్తాలను పోల్చే ముందు నిర్ధారించండి.',
    transport_not_included: 'కొటేషన్ {L}: రవాణా కలిసి లేదు, అదనంగా అవుతుంది.',
    transport_unstated: 'కొటేషన్ {L}: రవాణా గురించి చెప్పలేదు — కలిసి ఉందా అని అడగండి.',
    delivery_unstated: 'కొటేషన్ {L}: డెలివరీ సమయం చెప్పలేదు.',
    validity_short: 'కొటేషన్ {L}: ధర ఇంకా కొన్ని రోజులకే చెల్లుతుంది.',
    validity_expired: 'కొటేషన్ {L}: చెప్పిన చెల్లుబాటు తేదీ ఇప్పటికే గడిచిపోయింది.',
    advance_high: 'కొటేషన్ {L}: సగానికి పైగా మొత్తాన్ని అడ్వాన్స్‌గా అడుగుతున్నారు.',
    advance_unstated: 'కొటేషన్ {L}: అడ్వాన్స్ షరతులు చెప్పలేదు.',
    cheapest_after_normalization: 'కొటేషన్ {L}: ఈ సెట్‌లో అత్యల్ప సాధారణీకరించిన మొత్తం.',
    fastest: 'కొటేషన్ {L}: ఈ సెట్‌లో అత్యల్ప చెప్పిన డెలివరీ సమయం.',
    only_quote: 'కొటేషన్ {L}: ఇప్పటివరకు ఒకే కొటేషన్ — పోల్చడానికి ఇంకేమీ లేదు.',
  },
}

export function stubComparePointers(input: { results: readonly CompareQuoteResult[]; locale: PointerLocale }): ComparePointers {
  return {
    pointers: input.results.map((r, i) => ({
      quote_id: r.id,
      lines: r.flags.slice(0, 3).map((f) => PHRASES[input.locale][f].replace('{L}', compareLabel(i)).slice(0, 160)),
    })),
  }
}
