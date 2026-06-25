import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'
import { packageSchema } from '@amclub/shared'
import { toPackageRow } from '@/lib/partner/packageRow'

// Edit accepts the full package shape; status may also be 'paused'.
const editSchema = packageSchema.extend({
  status: z.enum(['draft', 'active', 'paused']).default('active'),
})

async function ownPackage(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  packageId: string,
) {
  const { data } = await supabase
    .from('packages')
    .select('id, provider:provider_profiles!inner(user_id)')
    .eq('id', packageId)
    .maybeSingle()
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const ownerId = (data as any)?.provider?.user_id
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return Boolean(data) && ownerId === userId
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const json = await request.json().catch(() => null)
  const parsed = editSchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data

  const supabase = await createClient()
  if (!(await ownPackage(supabase, user.id, id))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { data: category } = await supabase
    .from('categories')
    .select('id')
    .eq('slug', d.category_slug)
    .maybeSingle()
  if (!category) return NextResponse.json({ error: 'Invalid category' }, { status: 422 })

  const { error } = await supabase
    .from('packages')
    .update(toPackageRow({ ...d, status: d.status === 'paused' ? 'active' : d.status }, category.id))
    .eq('id', id)

  // toPackageRow forces status from the draft|active union; set paused explicitly.
  if (!error && d.status === 'paused') {
    await supabase.from('packages').update({ status: 'paused' }).eq('id', id)
  }

  if (error) {
    console.error('[partner/packages PATCH]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ id, status: d.status })
}

const statusPatchSchema = z.object({ status: z.enum(['active', 'paused', 'draft']) })

/** Lightweight status toggle (pause/activate) without a full edit payload. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const json = await request.json().catch(() => null)
  const parsed = statusPatchSchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid status' }, { status: 422 })

  const supabase = await createClient()
  if (!(await ownPackage(supabase, user.id, id))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const { error } = await supabase.from('packages').update({ status: parsed.data.status }).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ id, status: parsed.data.status })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const supabase = await createClient()
  if (!(await ownPackage(supabase, user.id, id))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  // Soft delete (§2.5 rule 4) — never hard-delete provider content.
  const { error } = await supabase
    .from('packages')
    .update({ status: 'removed', deleted_at: new Date().toISOString() })
    .eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ id, deleted: true })
}
