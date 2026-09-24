import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getSessionUser, getProviderProfile } from '@/lib/auth/session'
import { AssistantHome } from '@/components/assistant/AssistantHome'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('assistant_home')
  return { title: t('title') }
}

/** /partner/ai — the provider's assistant home. Without a provider profile yet, onboarding comes first. */
export default async function ProviderAssistantHomePage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/ai')
  if (!(await getProviderProfile(user.id))) redirect('/partner/onboarding')
  return <AssistantHome persona="provider" userId={user.id} />
}
