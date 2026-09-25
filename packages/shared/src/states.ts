import { pickI18n, type I18nText } from './i18n-text'

/**
 * Indian states / UTs — 2-letter codes used across the DB (`state` columns),
 * search filters and wizards. Single source for web + mobile (moved here from
 * apps/web/lib/constants/india.ts in Phase 8 §4 so mobile stops hand-syncing).
 */
export const INDIAN_STATES: { value: string; label: string }[] = [
  { value: 'AN', label: 'Andaman & Nicobar Islands' },
  { value: 'AP', label: 'Andhra Pradesh' },
  { value: 'AR', label: 'Arunachal Pradesh' },
  { value: 'AS', label: 'Assam' },
  { value: 'BR', label: 'Bihar' },
  { value: 'CH', label: 'Chandigarh' },
  { value: 'CG', label: 'Chhattisgarh' },
  { value: 'DN', label: 'Dadra & Nagar Haveli and Daman & Diu' },
  { value: 'DL', label: 'Delhi' },
  { value: 'GA', label: 'Goa' },
  { value: 'GJ', label: 'Gujarat' },
  { value: 'HR', label: 'Haryana' },
  { value: 'HP', label: 'Himachal Pradesh' },
  { value: 'JK', label: 'Jammu & Kashmir' },
  { value: 'JH', label: 'Jharkhand' },
  { value: 'KA', label: 'Karnataka' },
  { value: 'KL', label: 'Kerala' },
  { value: 'LA', label: 'Ladakh' },
  { value: 'LD', label: 'Lakshadweep' },
  { value: 'MP', label: 'Madhya Pradesh' },
  { value: 'MH', label: 'Maharashtra' },
  { value: 'MN', label: 'Manipur' },
  { value: 'ML', label: 'Meghalaya' },
  { value: 'MZ', label: 'Mizoram' },
  { value: 'NL', label: 'Nagaland' },
  { value: 'OD', label: 'Odisha' },
  { value: 'PY', label: 'Puducherry' },
  { value: 'PB', label: 'Punjab' },
  { value: 'RJ', label: 'Rajasthan' },
  { value: 'SK', label: 'Sikkim' },
  { value: 'TN', label: 'Tamil Nadu' },
  { value: 'TS', label: 'Telangana' },
  { value: 'TR', label: 'Tripura' },
  { value: 'UP', label: 'Uttar Pradesh' },
  { value: 'UK', label: 'Uttarakhand' },
  { value: 'WB', label: 'West Bengal' },
]

/** Wide alias — callers hold codes as plain strings (DB columns, form state). */
export type IndianStateCode = string

/**
 * E14 FR-14.2 — state / UT names in four languages, one map and one picker
 * (`pickI18n`), like the category names. `INDIAN_STATES[].label` stays the
 * English name because search tokens, GST vendor-state matching and the voice
 * parser read it; every screen renders `indianStateName` / `indianStateOptions`.
 */
export const INDIAN_STATE_NAMES: Record<string, I18nText> = {
  AN: { en: 'Andaman & Nicobar Islands', hi: 'अंडमान और निकोबार द्वीपसमूह', te: 'అండమాన్ & నికోబార్ దీవులు', ta: 'அந்தமான் & நிக்கோபார் தீவுகள்' },
  AP: { en: 'Andhra Pradesh', hi: 'आंध्र प्रदेश', te: 'ఆంధ్రప్రదేశ్', ta: 'ஆந்திரப் பிரதேசம்' },
  AR: { en: 'Arunachal Pradesh', hi: 'अरुणाचल प्रदेश', te: 'అరుణాచల్ ప్రదేశ్', ta: 'அருணாச்சலப் பிரதேசம்' },
  AS: { en: 'Assam', hi: 'असम', te: 'అస్సాం', ta: 'அசாம்' },
  BR: { en: 'Bihar', hi: 'बिहार', te: 'బిహార్', ta: 'பீகார்' },
  CH: { en: 'Chandigarh', hi: 'चंडीगढ़', te: 'చండీగఢ్', ta: 'சண்டிகர்' },
  CG: { en: 'Chhattisgarh', hi: 'छत्तीसगढ़', te: 'ఛత్తీస్‌గఢ్', ta: 'சத்தீஸ்கர்' },
  DN: { en: 'Dadra & Nagar Haveli and Daman & Diu', hi: 'दादरा और नगर हवेली और दमन और दीव', te: 'దాద్రా & నగర్ హవేలీ మరియు డామన్ & డయ్యూ', ta: 'தாத்ரா & நகர் ஹவேலி மற்றும் டாமன் & டையூ' },
  DL: { en: 'Delhi', hi: 'दिल्ली', te: 'ఢిల్లీ', ta: 'டெல்லி' },
  GA: { en: 'Goa', hi: 'गोवा', te: 'గోవా', ta: 'கோவா' },
  GJ: { en: 'Gujarat', hi: 'गुजरात', te: 'గుజరాత్', ta: 'குஜராத்' },
  HR: { en: 'Haryana', hi: 'हरियाणा', te: 'హర్యానా', ta: 'ஹரியானா' },
  HP: { en: 'Himachal Pradesh', hi: 'हिमाचल प्रदेश', te: 'హిమాచల్ ప్రదేశ్', ta: 'இமாச்சலப் பிரதேசம்' },
  JK: { en: 'Jammu & Kashmir', hi: 'जम्मू और कश्मीर', te: 'జమ్మూ & కాశ్మీర్', ta: 'ஜம்மு & காஷ்மீர்' },
  JH: { en: 'Jharkhand', hi: 'झारखंड', te: 'జార్ఖండ్', ta: 'ஜார்க்கண்ட்' },
  KA: { en: 'Karnataka', hi: 'कर्नाटक', te: 'కర్ణాటక', ta: 'கர்நாடகா' },
  KL: { en: 'Kerala', hi: 'केरल', te: 'కేరళ', ta: 'கேரளா' },
  LA: { en: 'Ladakh', hi: 'लद्दाख', te: 'లద్దాఖ్', ta: 'லடாக்' },
  LD: { en: 'Lakshadweep', hi: 'लक्षद्वीप', te: 'లక్షద్వీప్', ta: 'இலட்சத்தீவுகள்' },
  MP: { en: 'Madhya Pradesh', hi: 'मध्य प्रदेश', te: 'మధ్యప్రదేశ్', ta: 'மத்தியப் பிரதேசம்' },
  MH: { en: 'Maharashtra', hi: 'महाराष्ट्र', te: 'మహారాష్ట్ర', ta: 'மகாராஷ்டிரா' },
  MN: { en: 'Manipur', hi: 'मणिपुर', te: 'మణిపూర్', ta: 'மணிப்பூர்' },
  ML: { en: 'Meghalaya', hi: 'मेघालय', te: 'మేఘాలయ', ta: 'மேகாலயா' },
  MZ: { en: 'Mizoram', hi: 'मिज़ोरम', te: 'మిజోరం', ta: 'மிசோரம்' },
  NL: { en: 'Nagaland', hi: 'नागालैंड', te: 'నాగాలాండ్', ta: 'நாகாலாந்து' },
  OD: { en: 'Odisha', hi: 'ओडिशा', te: 'ఒడిశా', ta: 'ஒடிசா' },
  PY: { en: 'Puducherry', hi: 'पुडुचेरी', te: 'పుదుచ్చేరి', ta: 'புதுச்சேரி' },
  PB: { en: 'Punjab', hi: 'पंजाब', te: 'పంజాబ్', ta: 'பஞ்சாப்' },
  RJ: { en: 'Rajasthan', hi: 'राजस्थान', te: 'రాజస్థాన్', ta: 'ராஜஸ்தான்' },
  SK: { en: 'Sikkim', hi: 'सिक्किम', te: 'సిక్కిం', ta: 'சிக்கிம்' },
  TN: { en: 'Tamil Nadu', hi: 'तमिलनाडु', te: 'తమిళనాడు', ta: 'தமிழ்நாடு' },
  TS: { en: 'Telangana', hi: 'तेलंगाना', te: 'తెలంగాణ', ta: 'தெலுங்கானா' },
  TR: { en: 'Tripura', hi: 'त्रिपुरा', te: 'త్రిపుర', ta: 'திரிபுரா' },
  UP: { en: 'Uttar Pradesh', hi: 'उत्तर प्रदेश', te: 'ఉత్తరప్రదేశ్', ta: 'உத்தரப் பிரதேசம்' },
  UK: { en: 'Uttarakhand', hi: 'उत्तराखंड', te: 'ఉత్తరాఖండ్', ta: 'உத்தராகண்ட்' },
  WB: { en: 'West Bengal', hi: 'पश्चिम बंगाल', te: 'పశ్చిమ బెంగాల్', ta: 'மேற்கு வங்கம்' },
}

/** A state / UT code's name in the reader's language (English for a missing slot); an unknown code is returned as-is. */
export function indianStateName(code: string | null | undefined, locale: string): string {
  if (!code) return ''
  const names = INDIAN_STATE_NAMES[code]
  return names ? pickI18n(names, locale) : code
}

/** `INDIAN_STATES` as picker options labelled in the reader's language (the value stays the code). */
export function indianStateOptions(locale: string): { value: string; label: string }[] {
  return INDIAN_STATES.map((s) => ({ value: s.value, label: indianStateName(s.value, locale) }))
}
