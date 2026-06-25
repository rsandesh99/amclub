import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'

const bodySchema = z.object({
  providerId: z.string().uuid(),
  action: z.enum(['save', 'unsave']),
})

async function getMsmeId(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const { data } = await supabase
    .from('msme_profiles')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle()
  return data?.id ?? null
}

/** List the current MSME's saved provider ids. */
export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ providerIds: [] })
  const supabase = await createClient()
  const msmeId = await getMsmeId(supabase, user.id)
  if (!msmeId) return NextResponse.json({ providerIds: [] })
  const { data } = await supabase
    .from('saved_providers')
    .select('provider_id')
    .eq('msme_id', msmeId)
  return NextResponse.json({ providerIds: (data ?? []).map((r) => r.provider_id) })
}

/** Toggle a saved provider. RLS saved_providers owner-all enforces ownership. */
export async function POST(request: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 422 })

  const supabase = await createClient()
  const msmeId = await getMsmeId(supabase, user.id)
  if (!msmeId) {
    return NextResponse.json({ error: 'MSME profile required' }, { status: 403 })
  }

  const { providerId, action } = parsed.data
  if (action === 'save') {
    const { error } = await supabase
      .from('saved_providers')
      .upsert({ msme_id: msmeId, provider_id: providerId }, { onConflict: 'msme_id,provider_id' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ saved: true })
  }

  const { error } = await supabase
    .from('saved_providers')
    .delete()
    .eq('msme_id', msmeId)
    .eq('provider_id', providerId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ saved: false })
}
