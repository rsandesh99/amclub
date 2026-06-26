import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth/session'

export default async function ProviderLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser()

  if (!user) {
    redirect('/login?next=/partner')
  }

  // Require auth only — NOT the provider role. This group hosts /partner/onboarding
  // (the become-a-provider flow), which authenticated MSME / Google / email users
  // must be able to reach before they have the role. The provider role is granted
  // on application submit. Pages here (dashboard, listings) redirect users without
  // a provider profile to onboarding, and all provider data is keyed to the user's
  // own provider profile (null for non-providers → empty, no leak).

  return <>{children}</>
}
