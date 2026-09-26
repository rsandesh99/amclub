import { requireAdminPage } from '@/lib/privacy/page'
import { sectionTitle } from '@/lib/i18n/section-title'
import { PrivacyQueueClient } from './PrivacyQueueClient'

export const dynamic = 'force-dynamic'
export const generateMetadata = sectionTitle('admin_privacy', 'title')

/**
 * /admin/privacy (ADR-030 §6) — the DPDP request queue (open first by due date, overdue flagged), the access export,
 * the WhatsApp erasure, and the retention settings with the last wa-retention run. Admin / ops only.
 */
export default async function AdminPrivacyPage() {
  await requireAdminPage()
  return <PrivacyQueueClient />
}
