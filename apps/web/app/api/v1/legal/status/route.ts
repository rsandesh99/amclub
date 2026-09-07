import { NextResponse } from 'next/server'
import { LEGAL_VERSIONS_EFFECTIVE as LEGAL_VERSIONS } from '@/lib/legal/versions'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { getAcceptedVersions, isProviderAccount, missingLegalDocs } from '@/lib/legal/acceptance'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** Which legal documents the caller still has to accept (cookie or Bearer). */
export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })

  const admin = await createAdminClient()
  const isProvider = await isProviderAccount(admin, userId)
  const [required, accepted] = await Promise.all([
    missingLegalDocs(admin, userId, isProvider),
    getAcceptedVersions(admin, userId),
  ])
  return NextResponse.json({ required, accepted, versions: LEGAL_VERSIONS, isProvider }, { headers: NO_STORE })
}
