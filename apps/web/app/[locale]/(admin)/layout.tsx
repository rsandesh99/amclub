import { redirect } from 'next/navigation'
import { getSessionUser, getMsmeProfile, getProviderProfile } from '@/lib/auth/session'
import { AppShell } from '@/components/shell/AppShell'
import { AdminNav } from '@/components/shell/AdminNav'
import { COUPONS_ENABLED } from '@/lib/flags'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser()

  if (!user) {
    redirect('/login?next=/admin/verifications')
  }

  if (!user.roles.includes('admin') && !user.roles.includes('ops')) {
    redirect('/app')
  }

  const [msme, provider] = await Promise.all([getMsmeProfile(user.id), getProviderProfile(user.id)])

  return (
    <AppShell
      context="admin"
      name={user.fullName}
      roles={user.roles}
      hasMsmeProfile={Boolean(msme)}
      hasProviderProfile={Boolean(provider)}
    >
      <AdminNav couponsEnabled={COUPONS_ENABLED} />
      <div className="p-6">{children}</div>
    </AppShell>
  )
}
