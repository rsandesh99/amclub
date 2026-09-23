import { redirect } from 'next/navigation'
import { getSessionUser, getMsmeProfile, getProviderProfile } from '@/lib/auth/session'
import { AppShell } from '@/components/shell/AppShell'
import { PublicHeader } from '@/components/catalog/PublicHeader'
import { createAdminClient } from '@/lib/supabase/server'
import { getMsmeSuspension } from '@/lib/auth/suspension'
import { isOnFor, isOnForEveryone } from '@/lib/experiments'

/**
 * Checkout's own route group (Experience v3 E5). With the `checkout` flag off
 * it behaves exactly like the (msme) layout: sign-in required (middleware),
 * a buyer profile required, the buyer shell.
 *
 * Flag on (FR-5.1, N1): a signed-out visitor stays on /app/checkout/[id] —
 * the middleware lets this one path through and the page shows InlineAuth —
 * and a signed-in user without a buyer profile finishes it inline instead of
 * being sent to the signup wizard. A suspended buyer still goes to
 * /account-suspended.
 *
 * No loading.tsx in this group on purpose: without a Suspense boundary the
 * page's notFound() (unknown or inactive package) is a real 404, not a
 * streamed 200.
 */
export default async function CheckoutLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser()
  if (!user) {
    // Guests only while the flag is on for everyone (there is no user to bucket).
    if (!isOnForEveryone('checkout')) redirect('/login')
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <PublicHeader />
        <main className="flex-1">{children}</main>
      </div>
    )
  }

  const [msme, provider] = await Promise.all([getMsmeProfile(user.id), getProviderProfile(user.id)])
  if (!msme) {
    if (await getMsmeSuspension(await createAdminClient(), user.id)) redirect('/account-suspended')
    if (!isOnFor('checkout', user.id)) redirect('/signup?complete=1')
  }

  return (
    <AppShell
      context="msme"
      name={user.fullName}
      roles={user.roles}
      userId={user.id}
      hasMsmeProfile={Boolean(msme)}
      hasProviderProfile={Boolean(provider)}
      focused={isOnFor('checkout', user.id)}
    >
      {children}
    </AppShell>
  )
}
