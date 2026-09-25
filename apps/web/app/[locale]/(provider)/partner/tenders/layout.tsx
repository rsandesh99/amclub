import { sectionTitle } from '@/lib/i18n/section-title'

/** The tab title for /partner/tenders and the pages below it ("… | AMClub"). */
export const generateMetadata = sectionTitle('partner_v3', 'tenders_title')

export default function TendersSectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
