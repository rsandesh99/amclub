import { sectionTitle } from '@/lib/i18n/section-title'

/** The tab title for /app/invoices and the pages below it ("… | AMClub"). */
export const generateMetadata = sectionTitle('nav_v3', 'invoices')

export default function InvoicesSectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
