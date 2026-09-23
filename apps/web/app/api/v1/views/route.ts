import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { BOT_UA, viewBeaconSchema } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { clientIp, enforce, limiters } from '@/lib/rate-limit'
import { isExperienceLive } from '@/lib/experiments'
import { todayIST } from '@/lib/agent/quote-extract'

/**
 * POST /api/v1/views (PRD Experience v3 E11, N29) — the provider-funnel view
 * beacon for a provider profile or package page. Counts a visitor once per
 * subject per IST day (IP + user agent), never a bot, never the owner's own
 * view; only active subjects count (bump_view_count). Always answers 204 so
 * the beacon reveals nothing. 404 while the `partner` experience is off.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  if (!isExperienceLive('partner')) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const done = new NextResponse(null, { status: 204 })
  const ua = request.headers.get('user-agent') ?? ''
  if (!ua || BOT_UA.test(ua)) return done
  const parsed = viewBeaconSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return done
  const ip = clientIp(request)
  const ipCap = await enforce(limiters.viewIp, `views-ip:${ip}`)
  if (!ipCap.ok) return done
  const visitor = createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 24)
  const day = todayIST()
  const once = await enforce(limiters.viewOnce, `view:${visitor}:${parsed.data.kind}:${parsed.data.id}:${day}`)
  if (!once.ok) return done

  const admin = await createAdminClient()
  // The owner's own views never count.
  const { userId } = await getAuthedSupabase()
  if (userId) {
    const { data: me } = await admin.from('provider_profiles').select('id').eq('user_id', userId).maybeSingle()
    if (me) {
      const ownerId = parsed.data.kind === 'provider'
        ? parsed.data.id
        : ((await admin.from('packages').select('provider_id').eq('id', parsed.data.id).maybeSingle()).data?.provider_id as string | undefined)
      if (ownerId === me.id) return done
    }
  }
  await admin.rpc('bump_view_count', { p_kind: parsed.data.kind, p_id: parsed.data.id, p_day: day })
  return done
}
