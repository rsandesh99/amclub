/**
 * S2.4 — the weekly Munshi growth nudge (informational; ADR-010 consequences). At most one a week per provider, one
 * deterministic nudge picked in priority order, fixed copy, no model, no confirm, no ai_decisions row.
 *
 *   1. an incomplete profile field (the provider's own /profile/me)
 *   2. a category with ≥ 3 unmatched requests in their state in the last 30 days that they do not list
 *      (an aggregate count of platform data — never a buyer identity)
 *   3. the weakest score component's tip, when that component is a real weakness (< GROWTH_TIP_BELOW)
 *   4. a score rise of ≥ GROWTH_RISE_MIN points this month, naming the component that moved most
 *
 * (3) is gated on a real weakness; a weakest component always exists, so without the bar (4) could never fire.
 */
import { z } from 'zod'
import { PROVIDER_COMPONENTS, type ProviderComponent } from './score'
import { SCORE_TIPS, toScoreTipLocale, type ScoreTipLocale } from './score-tips'

export const GROWTH_PROFILE_FIELDS = ['about', 'logo', 'city', 'languages', 'years_experience'] as const
export type GrowthProfileField = (typeof GROWTH_PROFILE_FIELDS)[number]
export const GROWTH_DEMAND_MIN = 3
export const GROWTH_TIP_BELOW = 70
export const GROWTH_RISE_MIN = 5
export const GROWTH_INTERVAL_DAYS = 7

export const growthNudgeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('profile_field'), field: z.enum(GROWTH_PROFILE_FIELDS) }).strict(),
  z.object({ kind: z.literal('category_demand'), category_slug: z.string().min(1).max(80), count: z.number().int().min(GROWTH_DEMAND_MIN).max(10_000) }).strict(),
  z.object({ kind: z.literal('score_tip'), component: z.enum(PROVIDER_COMPONENTS) }).strict(),
  z.object({ kind: z.literal('score_rise'), component: z.enum(PROVIDER_COMPONENTS), points: z.number().int().min(GROWTH_RISE_MIN).max(100) }).strict(),
])
export type GrowthNudge = z.infer<typeof growthNudgeSchema>

export interface GrowthFacts {
  /** the provider's own missing listing fields, in GROWTH_PROFILE_FIELDS order */
  profileGaps: readonly GrowthProfileField[]
  /** categories the provider does not list, with the unmatched-request count in their state (30 days) */
  demand: readonly { category_slug: string; count: number }[]
  /** the weakest scored component and its value, when a snapshot exists */
  weakest: { component: ProviderComponent; value: number } | null
  /** this month's net rise and the component that moved most, when one exists */
  rise: { component: ProviderComponent; points: number } | null
}

/** Pure: the one nudge for this week, or null (nothing worth saying). */
export function pickGrowthNudge(f: GrowthFacts): GrowthNudge | null {
  const gap = GROWTH_PROFILE_FIELDS.find((g) => f.profileGaps.includes(g))
  if (gap) return { kind: 'profile_field', field: gap }
  const demand = [...f.demand].filter((d) => d.count >= GROWTH_DEMAND_MIN).sort((a, b) => b.count - a.count || a.category_slug.localeCompare(b.category_slug))[0]
  if (demand) return { kind: 'category_demand', category_slug: demand.category_slug, count: demand.count }
  if (f.weakest && f.weakest.value < GROWTH_TIP_BELOW) return { kind: 'score_tip', component: f.weakest.component }
  if (f.rise && f.rise.points >= GROWTH_RISE_MIN) return { kind: 'score_rise', component: f.rise.component, points: Math.min(100, Math.round(f.rise.points)) }
  return null
}

const FIELD: Record<ScoreTipLocale, Record<GrowthProfileField, string>> = {
  en: { about: 'a short description of your work', logo: 'your logo', city: 'your city', languages: 'the languages you work in', years_experience: 'your years of experience' },
  hi: { about: 'अपने काम का छोटा विवरण', logo: 'अपना लोगो', city: 'अपना शहर', languages: 'जिन भाषाओं में आप काम करते हैं', years_experience: 'अपने अनुभव के वर्ष' },
  te: { about: 'మీ పని గురించి చిన్న వివరణ', logo: 'మీ లోగో', city: 'మీ నగరం', languages: 'మీరు పనిచేసే భాషలు', years_experience: 'మీ అనుభవ సంవత్సరాలు' },
  ta: { about: 'உங்கள் வேலை பற்றிய சிறு விளக்கம்', logo: 'உங்கள் லோகோ', city: 'உங்கள் நகரம்', languages: 'நீங்கள் பணியாற்றும் மொழிகள்', years_experience: 'உங்கள் அனுபவ ஆண்டுகள்' },
}
const COMPONENT: Record<ScoreTipLocale, Record<ProviderComponent, string>> = {
  en: { responsiveness: 'response time', on_time: 'on-time delivery', buyer_confirmation: 'buyer confirmations', dispute_record: 'dispute record', decision_rate: 'decisions on requests' },
  hi: { responsiveness: 'जवाब का समय', on_time: 'समय पर डिलीवरी', buyer_confirmation: 'ख़रीदार की पुष्टि', dispute_record: 'विवाद रिकॉर्ड', decision_rate: 'माँगों पर फ़ैसला' },
  te: { responsiveness: 'స్పందన సమయం', on_time: 'సమయానికి డెలివరీ', buyer_confirmation: 'కొనుగోలుదారు నిర్ధారణలు', dispute_record: 'వివాదాల రికార్డు', decision_rate: 'అభ్యర్థనలపై నిర్ణయాలు' },
  ta: { responsiveness: 'பதில் நேரம்', on_time: 'சரியான நேரத்தில் டெலிவரி', buyer_confirmation: 'வாங்குபவர் உறுதிப்படுத்தல்கள்', dispute_record: 'சர்ச்சை பதிவு', decision_rate: 'கோரிக்கைகளில் முடிவுகள்' },
}

/** The one line (fixed copy; the category name comes from the platform's own category list). */
export function growthNudgeLine(n: GrowthNudge, locale: string | null | undefined, categoryName?: string | null): string {
  const l = toScoreTipLocale(locale)
  switch (n.kind) {
    case 'profile_field':
      return { en: `Add ${FIELD.en[n.field]} to your AMClub profile. Buyers read it before they pick whom to ask.`, hi: `अपनी AMClub प्रोफ़ाइल में ${FIELD.hi[n.field]} जोड़ें। ख़रीदार पूछने से पहले इसे पढ़ते हैं।`, te: `మీ AMClub ప్రొఫైల్‌లో ${FIELD.te[n.field]} జోడించండి. ఎవరిని అడగాలో నిర్ణయించే ముందు కొనుగోలుదారులు దీన్ని చదువుతారు.`, ta: `உங்கள் AMClub சுயவிவரத்தில் ${FIELD.ta[n.field]} சேர்க்கவும். யாரிடம் கேட்பது என முடிவெடுக்கும் முன் வாங்குபவர்கள் இதைப் படிக்கிறார்கள்.` }[l]
    case 'category_demand': {
      const c = categoryName ?? n.category_slug
      return { en: `${n.count} requests for ${c} in your state found no provider this month. If you offer it, add the category to your profile.`, hi: `इस महीने आपके राज्य में ${c} की ${n.count} माँगों को कोई प्रोवाइडर नहीं मिला। अगर आप यह सेवा देते हैं, तो यह श्रेणी अपनी प्रोफ़ाइल में जोड़ें।`, te: `ఈ నెల మీ రాష్ట్రంలో ${c} కోసం ${n.count} అభ్యర్థనలకు ప్రొవైడర్ దొరకలేదు. మీరు ఈ సేవ అందిస్తే, ఈ విభాగాన్ని మీ ప్రొఫైల్‌కు జోడించండి.`, ta: `இந்த மாதம் உங்கள் மாநிலத்தில் ${c} க்கான ${n.count} கோரிக்கைகளுக்கு வழங்குநர் கிடைக்கவில்லை. நீங்கள் இதை வழங்கினால், இந்தப் பிரிவை உங்கள் சுயவிவரத்தில் சேர்க்கவும்.` }[l]
    }
    case 'score_tip':
      return SCORE_TIPS[l][n.component]
    case 'score_rise':
      return { en: `Your ${COMPONENT.en[n.component]} improved this month, and your AMC Score rose by ${n.points} points. Keep it up.`, hi: `इस महीने आपका ${COMPONENT.hi[n.component]} बेहतर हुआ और आपका AMC स्कोर ${n.points} अंक बढ़ा। ऐसे ही जारी रखें।`, te: `ఈ నెల మీ ${COMPONENT.te[n.component]} మెరుగైంది, మీ AMC స్కోర్ ${n.points} పాయింట్లు పెరిగింది. ఇలాగే కొనసాగించండి.`, ta: `இந்த மாதம் உங்கள் ${COMPONENT.ta[n.component]} மேம்பட்டது, உங்கள் AMC மதிப்பெண் ${n.points} புள்ளிகள் உயர்ந்தது. இப்படியே தொடருங்கள்.` }[l]
  }
}

/** The provider's own missing listing fields (web computes this for /profile/me). */
export function providerProfileGaps(p: { about?: string | null; logo_url?: string | null; city?: string | null; languages?: readonly string[] | null; years_experience?: number | null }): GrowthProfileField[] {
  const out: GrowthProfileField[] = []
  if (!p.about || p.about.trim().length < 40) out.push('about')
  if (!p.logo_url) out.push('logo')
  if (!p.city || !p.city.trim()) out.push('city')
  if (!p.languages || p.languages.length === 0) out.push('languages')
  if (p.years_experience === null || p.years_experience === undefined) out.push('years_experience')
  return out
}
