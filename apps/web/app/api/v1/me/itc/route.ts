import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedSupabase } from '@/lib/auth/request'

const noStore = { 'Cache-Control': 'private, no-store' }

/**
 * Experience v3 N16 — may this viewer claim the GST on a purchase as input tax
 * credit? True only for a buyer profile with a VERIFIED GSTIN. Answers a
 * yes/no, never the GSTIN. Logged-out → false (not an error: public pages ask).
 */
export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ eligible: false }, { headers: noStore })
  const admin = await createAdminClient()
  const { data } = await admin
    .from('msme_profiles')
    .select('gstin_verified')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle()
  return NextResponse.json({ eligible: data?.gstin_verified === true }, { headers: noStore })
}
