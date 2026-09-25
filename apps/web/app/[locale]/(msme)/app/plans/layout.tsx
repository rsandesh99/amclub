import { sectionTitle } from '@/lib/i18n/section-title'

/** The tab title for /app/plans and the pages below it ("… | AMClub"). */
export const generateMetadata = sectionTitle('plans', 'title')

export default function PlansSectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
