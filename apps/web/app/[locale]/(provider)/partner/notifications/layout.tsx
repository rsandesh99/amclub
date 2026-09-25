import { sectionTitle } from '@/lib/i18n/section-title'

/** The tab title for /partner/notifications and the pages below it ("… | AMClub"). */
export const generateMetadata = sectionTitle('notifications', 'title')

export default function NotificationsSectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
