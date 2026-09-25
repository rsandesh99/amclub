import { sectionTitle } from '@/lib/i18n/section-title'

/** The tab title for /app/saved and the pages below it ("… | AMClub"). */
export const generateMetadata = sectionTitle('nav_v3', 'saved')

export default function SavedSectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
