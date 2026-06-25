import { createServerClient } from '@supabase/ssr'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { upsertUserRow } from '@/lib/auth/session'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/app'

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

  // Ensure public.users row exists
  await upsertUserRow({
    id: data.user.id,
    ...(data.user.phone ? { phone: data.user.phone } : {}),
    ...(data.user.email ? { email: data.user.email } : {}),
    ...(data.user.user_metadata?.['full_name'] ? { fullName: data.user.user_metadata['full_name'] as string } : {}),
    roles: ['msme'],
  })

  return NextResponse.redirect(new URL(next, origin))
}
