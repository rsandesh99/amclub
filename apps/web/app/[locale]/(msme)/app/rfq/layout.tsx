import { sectionTitle } from '@/lib/i18n/section-title'

/** The tab title for /app/rfq and the pages below it ("… | AMClub"). */
export const generateMetadata = sectionTitle('nav_v3', 'requirements')

export default function RfqSectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
