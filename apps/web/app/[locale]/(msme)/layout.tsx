import { redirect } from 'next/navigation'
import { getSessionUser, getMsmeProfile, getProviderProfile } from '@/lib/auth/session'
import { AppShell } from '@/components/shell/AppShell'

export default async function MsmeLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser()
  if (!user) {
    redirect('/login')
  }

  const [msme, provider] = await Promise.all([getMsmeProfile(user.id), getProviderProfile(user.id)])

  // Layout-level gate: every (msme) page requires a buyer profile. Redirecting
  // HERE (before the shell flushes) keeps it a real HTTP 307 — page-level
  // redirects after this layout's awaits arrive as a streamed meta-refresh
  // (200 + ~1s loading flash) instead.
  if (!msme) {
    redirect('/signup?complete=1')
  }

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
