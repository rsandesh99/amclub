import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth/session'

export default async function MsmeLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser()

  if (!user) {
    redirect('/login')
  }

  // If user has no msme_profiles row yet, redirect to signup to complete profile
  // (handled per-page via API rather than here to keep layout fast)

  return <>{children}</>
}
