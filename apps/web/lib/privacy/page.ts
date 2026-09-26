import 'server-only'
import { notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/auth/admin'

/**
 * /admin/whatsapp and /admin/privacy pages check the admin / ops role themselves (the (admin) layout does too): a page
 * that shows chat metadata or personal-data requests never relies on its layout alone. Not an admin → 404.
 */
export async function requireAdminPage(): Promise<string> {
  const auth = await requireAdmin()
  if (auth.error) notFound()
  return auth.userId
}
