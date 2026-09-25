import { sectionTitle } from '@/lib/i18n/section-title'

/** The tab title for /partner/listings and the pages below it ("… | AMClub"). */
export const generateMetadata = sectionTitle('nav_v3', 'listings')

export default function ListingsSectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
