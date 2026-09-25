import { sectionTitle } from '@/lib/i18n/section-title'

/** The tab title for /partner/earnings and the pages below it ("… | AMClub"). */
export const generateMetadata = sectionTitle('nav_v3', 'earnings')

export default function EarningsSectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
