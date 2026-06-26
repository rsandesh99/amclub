import { redirect } from 'next/navigation'
import { getSessionUser, getMsmeProfile, getProviderProfile } from '@/lib/auth/session'

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser()

  // Redirect AWAY from auth pages only users who already have a complete account.
  // A profile-less authenticated user (new Google/email signup) MUST be allowed
  // to render the signup wizard here — otherwise /signup?complete=1 ↔ /app loop
  // (the MSME home redirects profile-less users back to /signup?complete=1).
  if (user) {
    if (user.roles.includes('admin') || user.roles.includes('ops')) {
      redirect('/admin/verifications')
    }
    const [msme, provider] = await Promise.all([
      getMsmeProfile(user.id),
      user.roles.includes('provider') ? getProviderProfile(user.id) : Promise.resolve(null),
    ])
    if (provider) redirect('/partner')
    if (msme) redirect('/app')
    // else: authenticated but no profile yet → fall through to the wizard.
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">{children}</div>
    </div>
  )
}
