import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'

/** GET — flagged reviews queue for ops (A4). */
export async function GET(request: NextRequest) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

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
