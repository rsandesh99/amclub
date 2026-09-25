import { sectionTitle } from '@/lib/i18n/section-title'

/** The tab title for /app/licences and the pages below it ("… | AMClub"). */
export const generateMetadata = sectionTitle('licences_v3', 'title')

export default function LicencesSectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
