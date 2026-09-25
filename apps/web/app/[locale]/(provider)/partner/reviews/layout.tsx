import { sectionTitle } from '@/lib/i18n/section-title'

/** The tab title for /partner/reviews and the pages below it ("… | AMClub"). */
export const generateMetadata = sectionTitle('nav_v3', 'reviews')

export default function ReviewsSectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
