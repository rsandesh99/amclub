import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth/session'

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser()
  // If already logged in, redirect to appropriate home
  if (user) {
    if (user.roles.includes('admin') || user.roles.includes('ops')) {
      redirect('/admin/verifications')
    }
    if (user.roles.includes('provider')) {
      redirect('/partner')
    }
    redirect('/app')
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">{children}</div>
    </div>
  )
}
