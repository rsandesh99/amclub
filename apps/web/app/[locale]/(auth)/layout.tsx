import { redirect } from 'next/navigation'
import { getSessionUser, getMsmeProfile, getProviderProfile } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { getMsmeSuspension } from '@/lib/auth/suspension'

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
    // A provider WITHOUT a buyer profile must be able to reach the signup
    // wizard to CREATE one ("Set up buyer account") — redirecting them to
    // /partner here made /app → /signup?complete=1 → /partner a dead loop.
    if (provider && msme) {
      redirect(provider.status === 'active' ? '/partner' : '/app')
    }
    if (msme) redirect('/app')
    // A suspended buyer has no ACTIVE profile but must not reach the wizard.
    if (await getMsmeSuspension(await createAdminClient(), user.id)) redirect('/account-suspended')
    // else: authenticated but profile-less (or provider-only) → fall through
    // to the wizard so the missing profile can be completed.
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">{children}</div>
    </div>
  )
}
