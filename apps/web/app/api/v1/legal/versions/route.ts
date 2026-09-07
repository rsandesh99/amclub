import { NextResponse } from 'next/server'
import { LEGAL_VERSIONS_EFFECTIVE, PROVIDER_ADDENDUM_SECTIONS_EFFECTIVE } from '@/lib/legal/versions'

export const dynamic = 'force-dynamic'

/** Public: the legal document versions in force on this deployment (the
 *  pages print the same dates). Read by scripts/verify-launch-gate.ts to
 *  prove the addendum goods schedule is live with the flag. */
export function GET() {
  return NextResponse.json(
    { versions: LEGAL_VERSIONS_EFFECTIVE, provider_addendum_sections: PROVIDER_ADDENDUM_SECTIONS_EFFECTIVE },
    { headers: { 'Cache-Control': 'public, max-age=60' } },
  )
}
