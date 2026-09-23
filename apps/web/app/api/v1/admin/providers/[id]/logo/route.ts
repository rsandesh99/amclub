import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { logoDecisionSchema } from '@amclub/shared'
import { requireAdmin } from '@/lib/auth/admin'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'
import { writeAudit } from '@/lib/audit/log'
import { publicAssetUrl } from '@/lib/mart/assets'
import { revalidateProviderCatalog } from '@/lib/catalog/revalidate'

/**
 * POST /api/v1/admin/providers/[id]/logo (E3 / N12) — approve or reject a
 * provider's pending logo. Approve copies the private upload into the public
 * bucket and sets logo_url; reject clears it. Audit-logged; never an agent tool.
 */
export const runtime = 'nodejs'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error
  const delegated = await requireNotDelegated('admin/providers/logo')
  if (delegated) return delegated
  const rl = await enforce(limiters.adminMutation, `admin:${gate.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const { id } = await params
  const parsed = logoDecisionSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = await createAdminClient()
  const { data: p } = await admin.from('provider_profiles').select('id, logo_url, logo_pending_url, logo_status').eq('id', id).maybeSingle()
  if (!p) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (p.logo_status !== 'pending' || !p.logo_pending_url) return NextResponse.json({ error: 'no_pending_logo' }, { status: 409 })

  if (parsed.data.decision === 'reject') {
    const { error } = await admin.from('provider_profiles').update({ logo_status: 'rejected', logo_pending_url: null }).eq('id', id)
    if (error) return serverError('[admin/logo reject]', error)
    await writeAudit(admin, request, { actorId: gate.userId, action: 'provider_logo_rejected', entity: 'provider_profiles', entityId: id, after: { reason: parsed.data.reason ?? null } })
    return NextResponse.json({ status: 'rejected' })
  }

  const { data: blob, error: dlErr } = await admin.storage.from('kyc-documents').download(p.logo_pending_url as string)
  if (dlErr || !blob) return serverError('[admin/logo download]', dlErr ?? 'missing')
  const key = (p.logo_pending_url as string)
  const { error: upErr } = await admin.storage.from('public-assets').upload(key, Buffer.from(await blob.arrayBuffer()), { contentType: 'image/webp', upsert: false, cacheControl: '31536000' })
  if (upErr) return serverError('[admin/logo publish]', upErr)
  const url = publicAssetUrl(key)
  const { error } = await admin.from('provider_profiles').update({ logo_url: url, logo_status: 'approved', logo_pending_url: null }).eq('id', id)
  if (error) return serverError('[admin/logo approve]', error)
  await writeAudit(admin, request, { actorId: gate.userId, action: 'provider_logo_approved', entity: 'provider_profiles', entityId: id, before: { logo_url: p.logo_url }, after: { logo_url: url } })
  await revalidateProviderCatalog(admin, id)
  return NextResponse.json({ status: 'approved', url })
}
