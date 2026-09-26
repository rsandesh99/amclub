import { requireAdminPage } from '@/lib/privacy/page'
import { sectionTitle } from '@/lib/i18n/section-title'
import { WhatsAppConsoleClient } from './WhatsAppConsoleClient'

export const dynamic = 'force-dynamic'
export const generateMetadata = sectionTitle('admin_whatsapp', 'title')

/**
 * /admin/whatsapp (ADR-030 §6) — the WhatsApp ops console: overview (driver, quality, tier, last webhooks), delivery
 * log, templates vs the code registry, spend, consents and suppressions, unrouted inbound. Admin / ops only (checked
 * here and by every API route); every read is on the service role; phones are masked.
 */
export default async function AdminWhatsAppPage() {
  await requireAdminPage()
  return <WhatsAppConsoleClient />
}
