import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthedSupabase } from '@/lib/auth/request'
import { serverError } from '@/lib/api/errors'
import { requireNotDelegated } from '@/lib/agent/scope'

const bodySchema = z.object({
  providerId: z.string().uuid(),
  action: z.enum(['save', 'unsave']),
})

async function getMsmeId(
  supabase: Awaited<ReturnType<typeof getAuthedSupabase>>['supabase'],
  userId: string,
) {
  const { data } = await supabase
    .from('msme_profiles')
    .select('id, deleted_at')
    .eq('user_id', userId)
    .maybeSingle()
  // A suspended buyer (P0-8) has no active buyer identity.
  return data && !data.deleted_at ? data.id : null
}

// Per-user data — must never be cacheable by shared intermediaries.
const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** List the current MSME's saved provider ids. (cookie or Bearer auth) */
export async function GET() {
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  const msmeId = await getMsmeId(supabase, userId)
  if (!msmeId) return NextResponse.json({ providerIds: [] }, { headers: NO_STORE })
  const { data } = await supabase
    .from('saved_providers')
    .select('provider_id')
    .eq('msme_id', msmeId)
  return NextResponse.json(
    { providerIds: (data ?? []).map((r) => r.provider_id) },
    { headers: NO_STORE },
  )
}

/** Toggle a saved provider. RLS saved_providers owner-all enforces ownership. */
export async function POST(request: NextRequest) {
  // Audit wave 3: no agent tool wraps this route, so a delegated agent token is refused.
  const delegated = await requireNotDelegated('POST /saved')
  if (delegated) return delegated
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 422 })

  const msmeId = await getMsmeId(supabase, userId)
  if (!msmeId) {
    return NextResponse.json({ error: 'MSME profile required' }, { status: 403 })
  }

  const { providerId, action } = parsed.data
  if (action === 'save') {
    const { error } = await supabase
      .from('saved_providers')
      .upsert({ msme_id: msmeId, provider_id: providerId }, { onConflict: 'msme_id,provider_id' })
    if (error) return serverError('[saved POST save]', error)
    return NextResponse.json({ saved: true })
  }

  const { error } = await supabase
    .from('saved_providers')
    .delete()
    .eq('msme_id', msmeId)
    .eq('provider_id', providerId)
  if (error) return serverError('[saved POST unsave]', error)
  return NextResponse.json({ saved: false })
}
