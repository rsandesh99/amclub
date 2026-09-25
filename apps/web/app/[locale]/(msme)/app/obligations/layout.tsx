import { sectionTitle } from '@/lib/i18n/section-title'

/** The tab title for /app/obligations and the pages below it ("… | AMClub"). */
export const generateMetadata = sectionTitle('licences_v3', 'ob_title')

export default function ObligationsSectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
