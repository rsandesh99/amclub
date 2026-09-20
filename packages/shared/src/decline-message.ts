import { z } from 'zod'

/**
 * Buyer decline → courteous provider message (S1.2). The model (task class
 * decline_message, routine tier) writes two sentences in the provider's
 * language; when the agent is off, the budget is exceeded or the gateway
 * fails, the fixed template below goes out instead — a decline never depends
 * on the model. Platform voice ("AMClub"), no blame, no contact details, no
 * buyer identity, no negotiation invitation.
 */

export const QUOTE_DECLINE_REASONS = ['price_high', 'delivery_slow', 'details_unclear', 'terms_unacceptable', 'chose_other', 'other'] as const
export type QuoteDeclineReason = (typeof QUOTE_DECLINE_REASONS)[number]
export const quoteDeclineReasonSchema = z.enum(QUOTE_DECLINE_REASONS)

/** Reasons a buyer may pick in the sheet — `chose_other` is reserved for the system auto-decline on accept. */
export const BUYER_DECLINE_REASONS: readonly QuoteDeclineReason[] = ['price_high', 'delivery_slow', 'details_unclear', 'terms_unacceptable', 'other']

export const DECLINE_MESSAGE_LOCALES = ['en', 'hi', 'ta', 'te'] as const
export type DeclineMessageLocale = (typeof DECLINE_MESSAGE_LOCALES)[number]
export const declineMessageLocaleSchema = z.enum(DECLINE_MESSAGE_LOCALES)

export const declineMessageSchema = z
  .object({
    message: z.string().min(1).max(320),
    locale: declineMessageLocaleSchema,
  })
  .strict()
export type DeclineMessage = z.infer<typeof declineMessageSchema>

/** Fixed per-reason × locale template — the stub producer AND the fallback. */
const TEMPLATES: Record<QuoteDeclineReason, Record<DeclineMessageLocale, string>> = {
  price_high: {
    en: 'Thank you for quoting on this request through AMClub. The buyer has gone another way on price this time; you are welcome to quote on future requests.',
    hi: 'AMClub पर इस अनुरोध के लिए कोटेशन देने के लिए धन्यवाद। इस बार खरीदार ने कीमत के आधार पर दूसरा रास्ता चुना है; आगे के अनुरोधों पर आपका कोटेशन सादर आमंत्रित है।',
    ta: 'AMClub வழியாக இந்தக் கோரிக்கைக்கு விலைப்புள்ளி அளித்தமைக்கு நன்றி. இந்த முறை வாங்குபவர் விலையின் அடிப்படையில் வேறு முடிவு எடுத்துள்ளார்; எதிர்காலக் கோரிக்கைகளுக்கு நீங்கள் விலைப்புள்ளி அளிக்கலாம்.',
    te: 'AMClub ద్వారా ఈ అభ్యర్థనకు కొటేషన్ ఇచ్చినందుకు ధన్యవాదాలు. ఈసారి కొనుగోలుదారు ధర ఆధారంగా వేరే నిర్ణయం తీసుకున్నారు; భవిష్యత్ అభ్యర్థనలకు మీరు కొటేషన్ ఇవ్వవచ్చు.',
  },
  delivery_slow: {
    en: 'Thank you for quoting on this request through AMClub. The timeline did not fit the buyer’s need this time; you are welcome to quote on future requests.',
    hi: 'AMClub पर इस अनुरोध के लिए कोटेशन देने के लिए धन्यवाद। इस बार समय-सीमा खरीदार की ज़रूरत से मेल नहीं खाई; आगे के अनुरोधों पर आपका कोटेशन सादर आमंत्रित है।',
    ta: 'AMClub வழியாக இந்தக் கோரிக்கைக்கு விலைப்புள்ளி அளித்தமைக்கு நன்றி. இந்த முறை காலக்கெடு வாங்குபவரின் தேவைக்குப் பொருந்தவில்லை; எதிர்காலக் கோரிக்கைகளுக்கு நீங்கள் விலைப்புள்ளி அளிக்கலாம்.',
    te: 'AMClub ద్వారా ఈ అభ్యర్థనకు కొటేషన్ ఇచ్చినందుకు ధన్యవాదాలు. ఈసారి గడువు కొనుగోలుదారు అవసరానికి సరిపోలేదు; భవిష్యత్ అభ్యర్థనలకు మీరు కొటేషన్ ఇవ్వవచ్చు.',
  },
  details_unclear: {
    en: 'Thank you for quoting on this request through AMClub. The buyer needed more detail on scope and terms than the quote gave; stating what is included and what is extra helps on future requests.',
    hi: 'AMClub पर इस अनुरोध के लिए कोटेशन देने के लिए धन्यवाद। खरीदार को दायरे और शर्तों पर कोटेशन से अधिक विवरण चाहिए था; आगे के अनुरोधों में क्या शामिल है और क्या अतिरिक्त है, यह स्पष्ट लिखना मदद करता है।',
    ta: 'AMClub வழியாக இந்தக் கோரிக்கைக்கு விலைப்புள்ளி அளித்தமைக்கு நன்றி. வேலை வரம்பு மற்றும் நிபந்தனைகள் குறித்து வாங்குபவருக்கு மேலும் விவரம் தேவைப்பட்டது; எதிர்காலக் கோரிக்கைகளில் எது அடங்கும், எது கூடுதல் என்று குறிப்பிடுவது உதவும்.',
    te: 'AMClub ద్వారా ఈ అభ్యర్థనకు కొటేషన్ ఇచ్చినందుకు ధన్యవాదాలు. పని పరిధి, షరతులపై కొనుగోలుదారుకు మరింత వివరం అవసరమైంది; భవిష్యత్ అభ్యర్థనల్లో ఏమి కలిసి ఉంది, ఏమి అదనం అని స్పష్టంగా రాయడం సహాయపడుతుంది.',
  },
  terms_unacceptable: {
    en: 'Thank you for quoting on this request through AMClub. The commercial terms did not work for the buyer this time; you are welcome to quote on future requests.',
    hi: 'AMClub पर इस अनुरोध के लिए कोटेशन देने के लिए धन्यवाद। इस बार व्यावसायिक शर्तें खरीदार के लिए उपयुक्त नहीं रहीं; आगे के अनुरोधों पर आपका कोटेशन सादर आमंत्रित है।',
    ta: 'AMClub வழியாக இந்தக் கோரிக்கைக்கு விலைப்புள்ளி அளித்தமைக்கு நன்றி. இந்த முறை வணிக நிபந்தனைகள் வாங்குபவருக்குப் பொருந்தவில்லை; எதிர்காலக் கோரிக்கைகளுக்கு நீங்கள் விலைப்புள்ளி அளிக்கலாம்.',
    te: 'AMClub ద్వారా ఈ అభ్యర్థనకు కొటేషన్ ఇచ్చినందుకు ధన్యవాదాలు. ఈసారి వాణిజ్య షరతులు కొనుగోలుదారుకు సరిపోలేదు; భవిష్యత్ అభ్యర్థనలకు మీరు కొటేషన్ ఇవ్వవచ్చు.',
  },
  chose_other: {
    en: 'Thank you for quoting on this request through AMClub. The buyer has awarded it to another provider; you are welcome to quote on future requests.',
    hi: 'AMClub पर इस अनुरोध के लिए कोटेशन देने के लिए धन्यवाद। खरीदार ने इसे किसी अन्य प्रदाता को दिया है; आगे के अनुरोधों पर आपका कोटेशन सादर आमंत्रित है।',
    ta: 'AMClub வழியாக இந்தக் கோரிக்கைக்கு விலைப்புள்ளி அளித்தமைக்கு நன்றி. வாங்குபவர் இதை வேறொரு வழங்குநருக்கு வழங்கியுள்ளார்; எதிர்காலக் கோரிக்கைகளுக்கு நீங்கள் விலைப்புள்ளி அளிக்கலாம்.',
    te: 'AMClub ద్వారా ఈ అభ్యర్థనకు కొటేషన్ ఇచ్చినందుకు ధన్యవాదాలు. కొనుగోలుదారు దీన్ని మరో ప్రొవైడర్‌కు అప్పగించారు; భవిష్యత్ అభ్యర్థనలకు మీరు కొటేషన్ ఇవ్వవచ్చు.',
  },
  other: {
    en: 'Thank you for quoting on this request through AMClub. The buyer will not be going ahead with this quote; you are welcome to quote on future requests.',
    hi: 'AMClub पर इस अनुरोध के लिए कोटेशन देने के लिए धन्यवाद। खरीदार इस कोटेशन के साथ आगे नहीं बढ़ेंगे; आगे के अनुरोधों पर आपका कोटेशन सादर आमंत्रित है।',
    ta: 'AMClub வழியாக இந்தக் கோரிக்கைக்கு விலைப்புள்ளி அளித்தமைக்கு நன்றி. இந்த விலைப்புள்ளியுடன் வாங்குபவர் தொடரப் போவதில்லை; எதிர்காலக் கோரிக்கைகளுக்கு நீங்கள் விலைப்புள்ளி அளிக்கலாம்.',
    te: 'AMClub ద్వారా ఈ అభ్యర్థనకు కొటేషన్ ఇచ్చినందుకు ధన్యవాదాలు. ఈ కొటేషన్‌తో కొనుగోలుదారు ముందుకు వెళ్లడం లేదు; భవిష్యత్ అభ్యర్థనలకు మీరు కొటేషన్ ఇవ్వవచ్చు.',
  },
}

export function declineMessageTemplate(reason: QuoteDeclineReason, locale: DeclineMessageLocale): DeclineMessage {
  return { message: TEMPLATES[reason][locale], locale }
}

/** Provider's message locale: first languages[] entry we render, else the user's preferred locale, else en. */
export function resolveDeclineLocale(providerLanguages: readonly string[] | null | undefined, preferredLocale: string | null | undefined): DeclineMessageLocale {
  const known = new Set<string>(DECLINE_MESSAGE_LOCALES)
  for (const l of providerLanguages ?? []) if (known.has(l)) return l as DeclineMessageLocale
  if (preferredLocale && known.has(preferredLocale)) return preferredLocale as DeclineMessageLocale
  return 'en'
}

/** Unicode-script sanity for the eval and the runtime: hi ⇒ Devanagari, ta ⇒ Tamil, te ⇒ Telugu, en ⇒ mostly Latin. */
export function messageMatchesLocaleScript(message: string, locale: DeclineMessageLocale): boolean {
  if (locale === 'hi') return /[ऀ-ॿ]/.test(message)
  if (locale === 'ta') return /[஀-௿]/.test(message)
  if (locale === 'te') return /[ఀ-౿]/.test(message)
  return !/[ऀ-ॿ஀-௿ఀ-౿]/.test(message)
}
