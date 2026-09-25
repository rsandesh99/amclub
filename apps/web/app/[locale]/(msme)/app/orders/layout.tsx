import { sectionTitle } from '@/lib/i18n/section-title'

/** The tab title for /app/orders and the pages below it ("… | AMClub"). */
export const generateMetadata = sectionTitle('nav_v3', 'orders')

export default function OrdersSectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
