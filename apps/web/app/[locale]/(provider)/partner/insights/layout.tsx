import { sectionTitle } from '@/lib/i18n/section-title'

/** The tab title for /partner/insights and the pages below it ("… | AMClub"). */
export const generateMetadata = sectionTitle('partner_v3', 'insights_title')

export default function InsightsSectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
