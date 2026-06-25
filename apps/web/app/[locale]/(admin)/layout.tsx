import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth/session'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser()

  if (!user) {
    redirect('/login?next=/admin/verifications')
  }

  if (!user.roles.includes('admin') && !user.roles.includes('ops')) {
    redirect('/app')
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-gray-200 bg-surface px-6 py-4">
        <div className="flex items-center justify-between">
          <span className="text-lg font-bold text-primary">AMClub Admin</span>
          <span className="text-sm text-foreground-secondary">{user.fullName ?? user.email ?? user.phone}</span>
        </div>
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  )
}
