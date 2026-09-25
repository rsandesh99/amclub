import { sectionTitle } from '@/lib/i18n/section-title'

/** The tab title for /partner/onboarding and the pages below it ("… | AMClub"). */
export const generateMetadata = sectionTitle('provider_signup', 'page_title')

export default function OnboardingSectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
