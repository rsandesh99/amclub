import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { isObligationsOn, signedCertificateUrl, storeLicenceCertificate } from '@/lib/licences'

/**
 * Experience v3 E9b — the licence certificate (private bucket
 * `licence-certificates`, images / PDFs, 5 MB). POST multipart `file` stores
 * or replaces it; GET redirects the owner to a 15-minute signed link. 404
 * while dark or for anyone else's licence.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function gate(id: string) {
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return { res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const
  if (!(await isObligationsOn()) || !UUID.test(id)) return { res: NextResponse.json({ error: 'Not found' }, { status: 404 }) } as const
  const delegated = await requireNotDelegated('me/licences/certificate')
  if (delegated) return { res: delegated } as const
  return { supabase } as const
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const g = await gate(id)
  if ('res' in g) return g.res
  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  const r = await storeLicenceCertificate(g.supabase, id, file instanceof File ? file : null)
  if (!r.ok) return NextResponse.json({ error: r.code, code: r.code }, { status: r.status })
  return NextResponse.json({ ok: true }, { status: 201 })
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const g = await gate(id)
  if ('res' in g) return g.res
  const url = await signedCertificateUrl(g.supabase, id)
  if (!url) return NextResponse.json({ error: 'not_found', code: 'not_found' }, { status: 404 })
  return NextResponse.redirect(url, { headers: { 'Cache-Control': 'private, no-store' } })
}
