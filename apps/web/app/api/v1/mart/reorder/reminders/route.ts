import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { martApiGate } from '@/lib/mart/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { setReorderReminder } from '@/lib/mart/reorder'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'

const bodySchema = z.object({ productId: z.string().uuid(), on: z.boolean() })

/**
 * E16 N44 — the buyer turns the reorder reminder for one listing on or off.
 * Only a listing they have bought (else 404); the interval is their usual one
 * (shared usualReorderIntervalDays). Written on the service role after the
 * buyer's own session is checked (the table has no client writes).
 */
export async function POST(request: NextRequest) {
  const gate = martApiGate()
  if (gate) return gate
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const rl = await enforce(limiters.authed, `mart-reorder:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const admin = await createAdminClient()
  const { data: msme } = await admin.from('msme_profiles').select('id').eq('user_id', userId).is('deleted_at', null).maybeSingle()
  if (!msme) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const reminder = await setReorderReminder(admin, msme.id, userId, parsed.data.productId, parsed.data.on)
    if (!reminder) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ reminder }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    return serverError('[mart/reorder/reminders POST]', e)
  }
}
