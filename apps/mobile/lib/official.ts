/**
 * The official AMClub contacts on mobile (audit §5 item 8): ONE WhatsApp number — the business number from
 * EXPO_PUBLIC_WHATSAPP_NUMBER, or the company line while it is unset — plus the support and grievance contacts.
 * The facts and the rule live in @amclub/shared official-channels (the web reads the same ones).
 */
import Constants from 'expo-constants'
import { GRIEVANCE_OFFICER, GRIEVANCE_SLA, SUPPORT_EMAIL, officialWhatsApp, waMeHref } from '@amclub/shared'

// Dot notation: Expo inlines EXPO_PUBLIC_* only when read as process.env.EXPO_PUBLIC_NAME.
export const OFFICIAL_WHATSAPP = officialWhatsApp(process.env.EXPO_PUBLIC_WHATSAPP_NUMBER)

/** The web app's origin (the same one lib/api calls); public pages such as /help open there. */
const WEB_ORIGIN =
  (Constants.expoConfig?.extra?.['apiUrl'] as string | undefined) ??
  process.env.EXPO_PUBLIC_API_URL ??
  'http://localhost:3000'

/** A public web page in the reader's language (the web keeps English unprefixed). */
export function webPageUrl(path: string, locale: string): string {
  return `${WEB_ORIGIN}${locale && locale !== 'en' ? `/${locale}` : ''}${path}`
}
export const OFFICIAL_WHATSAPP_HREF = waMeHref(OFFICIAL_WHATSAPP.digits)
/** D-WA3 — the "Offers" switch shows only with this on (or after an existing marketing opt-in). */
export const WHATSAPP_MARKETING_ENABLED = process.env.EXPO_PUBLIC_WHATSAPP_MARKETING_ENABLED === 'true'
export { GRIEVANCE_OFFICER, GRIEVANCE_SLA, SUPPORT_EMAIL }
