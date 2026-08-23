import { redirect } from 'next/navigation'
import { getSessionUser, getMsmeProfile, getProviderProfile } from '@/lib/auth/session'
import { AppShell } from '@/components/shell/AppShell'

export default async function MsmeLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser()
  if (!user) {
    redirect('/login')
  }

  const [msme, provider] = await Promise.all([getMsmeProfile(user.id), getProviderProfile(user.id)])

  return (
    <AppShell
      context="msme"
      name={user.fullName}
      roles={user.roles}
      hasMsmeProfile={Boolean(msme)}
      hasProviderProfile={Boolean(provider)}
    >
      {children}
    </AppShell>
  )
}
