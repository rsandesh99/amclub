import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth/session'
import { AppShell } from '@/components/shell/AppShell'
import { AdminNav } from '@/components/shell/AdminNav'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser()

  if (!user) {
    redirect('/login?next=/admin/verifications')
  }

  if (!user.roles.includes('admin') && !user.roles.includes('ops')) {
    redirect('/app')
  }

  return (
    <AppShell context="admin" name={user.fullName} roles={user.roles}>
      <AdminNav />
      <div className="p-6">{children}</div>
    </AppShell>
  )
}
