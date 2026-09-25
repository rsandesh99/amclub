import { sectionTitle } from '@/lib/i18n/section-title'

/** The tab title for /partner/profile and the pages below it ("… | AMClub"). */
export const generateMetadata = sectionTitle('nav_v3', 'profile')

export default function ProfileSectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
