import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'

/** GET — flagged reviews queue for ops (A4). */
export async function GET(request: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!user.roles.includes('admin') && !user.roles.includes('ops')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const status = new URL(request.url).searchParams.get('status') ?? 'flagged'
  const admin = await createAdminClient()
  const { data } = await admin
    .from('reviews')
    .select('id, rating, text, status, created_at, provider:provider_profiles(display_name, slug)')
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(100)

  return NextResponse.json({ reviews: data ?? [] })
}
