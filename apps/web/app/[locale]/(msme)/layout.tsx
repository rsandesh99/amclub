import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth/session'
import { AppShell } from '@/components/shell/AppShell'

export default async function MsmeLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser()
  if (!user) {
    redirect('/login')
  }

  return (
    <AppShell context="msme" name={user.fullName} roles={user.roles}>
      {children}
    </AppShell>
  )
}
