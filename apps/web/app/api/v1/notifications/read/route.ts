import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthedSupabase } from '@/lib/auth/request'

const bodySchema = z.object({
  id: z.string().uuid().optional(),
  all: z.boolean().optional(),
})

/** POST — mark one notification ({id}) or all ({all:true}) as read. RLS scopes
 *  the update to the owner, so no extra ownership check is needed. */
export async function POST(request: NextRequest) {
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json ?? {})
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const now = new Date().toISOString()
  let q = supabase.from('notifications').update({ read_at: now }).is('read_at', null)
  if (parsed.data.id) q = q.eq('id', parsed.data.id)
  else if (!parsed.data.all) return NextResponse.json({ error: 'Provide id or all:true' }, { status: 422 })

  const { error } = await q
  if (error) return NextResponse.json({ error: 'Could not update' }, { status: 500 })
  return NextResponse.json({ ok: true })
}
