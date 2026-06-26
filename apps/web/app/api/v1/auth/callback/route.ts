import { createServerClient } from '@supabase/ssr'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/server'
import { upsertUserRow } from '@/lib/auth/session'
import { safeNext } from '@/lib/auth/safe-next'

/**
 * OAuth / magic-link callback. The new-vs-returning decision is made HERE by
 * PROFILE EXISTENCE, not by which button was clicked (Google login and signup
 * converge on one flow):
 *   - has a profile  → role home (/app | /partner | /admin)
 *   - no profile yet → the appropriate signup wizard (the `next` hint picks
 *                      MSME vs provider). The wizard runs ONCE.
 * One identity = one account: the public.users row is upserted by id, and we
 * never overwrite an existing user's roles.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? ''

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=missing_code', origin))
  }

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        },
      },
    },
  )

  const { data, error } = await supabase.auth.exchangeCodeForSession(code)
  if (error || !data.user) {
    return NextResponse.redirect(new URL('/login?error=auth_failed', origin))
  }
  const authUser = data.user

  const admin = await createAdminClient()

  // Ensure a public.users row exists WITHOUT clobbering an existing user's roles.
  const { data: existingUser } = await admin
    .from('users')
    .select('roles')
    .eq('id', authUser.id)
    .maybeSingle()

  let roles: string[]
  if (existingUser) {
    roles = existingUser.roles ?? ['msme']
  } else {
    roles = ['msme']
    await upsertUserRow({
      id: authUser.id,
      ...(authUser.phone ? { phone: authUser.phone } : {}),
      ...(authUser.email ? { email: authUser.email } : {}),
      ...(authUser.user_metadata?.['full_name'] ? { fullName: authUser.user_metadata['full_name'] as string } : {}),
      roles,
    })
  }

  // Decide destination by profile existence.
  const [{ data: msme }, { data: provider }] = await Promise.all([
    admin.from('msme_profiles').select('id').eq('user_id', authUser.id).maybeSingle(),
    admin.from('provider_profiles').select('id').eq('user_id', authUser.id).maybeSingle(),
  ])

  const wantsNext = safeNext(next)
  let dest: string
  if (roles.includes('admin') || roles.includes('ops')) {
    dest = '/admin/verifications'
  } else if (provider || msme) {
    // Returning user → honor a deep-link `next` if present, else role home.
    dest = wantsNext ?? (provider ? '/partner' : '/app')
  } else {
    // Brand-new user → run the right wizard ONCE. `next` carries the intent.
    dest = next.startsWith('/partner') ? '/partner/onboarding' : '/signup?complete=1'
  }

  return NextResponse.redirect(new URL(dest, origin))
}
