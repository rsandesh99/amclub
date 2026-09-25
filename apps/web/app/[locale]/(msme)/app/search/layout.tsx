import { sectionTitle } from '@/lib/i18n/section-title'

/** The tab title for /app/search and the pages below it ("… | AMClub"). */
export const generateMetadata = sectionTitle('nav_v3', 'search')

export default function SearchSectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
