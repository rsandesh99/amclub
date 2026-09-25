import { sectionTitle } from '@/lib/i18n/section-title'

/** The tab title for /partner/actions and the pages below it ("… | AMClub"). */
export const generateMetadata = sectionTitle('next_action', 'needs_your_action')

export default function ActionsSectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
