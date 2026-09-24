import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getSessionUser } from '@/lib/auth/session'
import { AssistantHome } from '@/components/assistant/AssistantHome'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('assistant_home')
  return { title: t('title') }
}

/** /app/ai — the buyer's assistant home: what it does, what it asks first, what it never does, its settings. */
export default async function BuyerAssistantHomePage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/ai')
  return <AssistantHome persona="buyer" userId={user.id} />
}
