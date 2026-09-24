import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { agentApiGate } from '@/lib/agent/gate'
import { agentAvailability } from '@/lib/agent/availability'
import { capabilitiesFor } from '@/lib/agent/capabilities'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'

/**
 * GET /api/v1/agent/assistant?persona=buyer|provider — what the corner
 * launcher needs when it opens: which of this person's assistant capabilities
 * are on, and whether they allowed the assistant on the web. Booleans about
 * the caller only; 404s while AGENT_ENABLED=false.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const personaSchema = z.enum(['buyer', 'provider']).catch('buyer')

export async function GET(request: NextRequest) {
  const gate = agentApiGate()
  if (gate) return gate
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const persona = personaSchema.parse(request.nextUrl.searchParams.get('persona'))

  const [avail, grants] = await Promise.all([
    agentAvailability(await createAdminClient(), userId),
    supabase.from('agent_grants').select('id').eq('persona', persona).eq('channel', 'web').is('revoked_at', null).limit(1),
  ])
  const on = Object.fromEntries(capabilitiesFor(persona).map((c) => [c.key, c.agent === null ? true : avail[c.agent]]))
  return NextResponse.json({ persona, on, allowed: (grants.data ?? []).length > 0 }, { headers: { 'Cache-Control': 'private, no-store' } })
}
