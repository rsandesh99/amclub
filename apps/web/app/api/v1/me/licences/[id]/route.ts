import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { isObligationsOn, removeLicence, updateLicence } from '@/lib/licences'

/** Experience v3 E9b — edit (PATCH) or remove (DELETE = soft delete, rule 4) one of the caller's licences. 404 while dark. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const patchSchema = z
  .object({
    number: z.string().trim().min(1).max(64).nullable().optional(),
    issuedOn: isoDate.nullable().optional(),
    expiresOn: isoDate.nullable().optional(),
    authority: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .strict()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function gate(id: string) {
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return { res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const
  if (!(await isObligationsOn()) || !UUID.test(id)) return { res: NextResponse.json({ error: 'Not found' }, { status: 404 }) } as const
  const delegated = await requireNotDelegated('me/licences')
  if (delegated) return { res: delegated } as const
  return { supabase } as const
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const g = await gate(id)
  if ('res' in g) return g.res
  const parsed = patchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body', code: 'invalid_body' }, { status: 422 })
  const r = await updateLicence(g.supabase, id, parsed.data)
  if (!r.ok) return NextResponse.json({ error: r.code, code: r.code }, { status: r.status })
  return NextResponse.json({ licence: r.licence })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const g = await gate(id)
  if ('res' in g) return g.res
  if (!(await removeLicence(g.supabase, id))) return NextResponse.json({ error: 'not_found', code: 'not_found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
