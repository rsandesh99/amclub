import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth/session'

export default async function ProviderLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser()

  if (!user) {
    redirect('/login?next=/partner')
  }

  if (!user.roles.includes('provider')) {
    // User is authenticated but doesn't have provider role — redirect to MSME home
    redirect('/app')
  }

  return <>{children}</>
}
