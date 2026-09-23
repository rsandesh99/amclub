import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
import { signKycDocument } from '@/lib/auth/kyc-documents'

const querySchema = z.object({ v: z.string().uuid() })

/**
 * GET /api/v1/admin/verifications/[providerId]/document?v=<verificationId>
 *
 * Opens a provider's KYC credential document for an admin/ops reviewer
 * (USER_EXPECTATIONS_AUDIT P0-9). document_url holds the bucket path; this
 * signs it at click time (15-minute TTL) and redirects, so a queue page left
 * open never carries a dead or long-lived link. Legacy rows that hold a full
 * signed URL are re-signed from their path. The response is never cached.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const { id: providerId } = await params
  const parsed = querySchema.safeParse({ v: request.nextUrl.searchParams.get('v') })
  if (!parsed.success || !z.string().uuid().safeParse(providerId).success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 422 })
  }

  const admin = await createAdminClient()
  const { data: row } = await admin
    .from('provider_verifications')
    .select('document_url')
    .eq('id', parsed.data.v)
    .eq('provider_id', providerId)
    .maybeSingle()
  if (!row?.document_url) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const signed = await signKycDocument(admin, row.document_url)
  if (!signed) return NextResponse.json({ error: 'document_unavailable' }, { status: 404 })

  const res = NextResponse.redirect(signed, 302)
  res.headers.set('Cache-Control', 'no-store')
  res.headers.set('Referrer-Policy', 'no-referrer')
  return res
}
