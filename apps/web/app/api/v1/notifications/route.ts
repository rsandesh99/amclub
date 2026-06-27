import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'

/**
 * GET — the caller's notification centre (in-app rows) + unread count. Works for
 * web (cookie) and mobile (Bearer). RLS scopes rows to the owner.
 * `?unread=1` returns only the count (cheap, for the bell badge poll).
 */
export async function GET(request: NextRequest) {
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const countOnly = url.searchParams.get('unread') === '1'

  const { count: unread } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .is('read_at', null)

  if (countOnly) return NextResponse.json({ unread: unread ?? 0 })

  const { data } = await supabase
    .from('notifications')
    .select('id, kind, title_i18n, body_i18n, link, read_at, created_at')
    .order('created_at', { ascending: false })
    .limit(50)

  return NextResponse.json({ notifications: data ?? [], unread: unread ?? 0 })
}
