import { sectionTitle } from '@/lib/i18n/section-title'

/** The tab title for /partner/rfqs and the pages below it ("… | AMClub"). */
export const generateMetadata = sectionTitle('nav_v3', 'rfqs')

export default function RfqsSectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
