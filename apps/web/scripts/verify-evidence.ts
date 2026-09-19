/**
 * verify-evidence — S0.3 services evidence engine (verify-* convention).
 *
 * Two modes, zero prod residue (reads only — never writes to the DB):
 *   CONTRACT (always): the milestone machine (in order, once each, only while
 *     open) and evaluateServicesReleaseGate (held until work-complete photo +
 *     buyer confirmation, no dispute), plus the cutover-inertness rule (a null
 *     evidence_required_from never enforces; a date enforces only orders placed
 *     on/after it).
 *   STRUCTURAL (needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY):
 *     order_milestones carries the new evidence columns on the target DB.
 *
 * The full seeded order lifecycle is exercised by the acceptance harness; this
 * gate proves the contract + that migration 0028 landed. Run:
 *   pnpm --filter @amclub/web exec tsx scripts/verify-evidence.ts
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'
import {
  canAddMilestone,
  evaluateServicesReleaseGate,
  nextMilestoneKind,
  type MilestoneKind,
} from '@amclub/shared'

const UUID = '00000000-0000-0000-0000-000000000001'
let failed = 0
const rows: { name: string; ok: boolean | 'skip'; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: string) {
  rows.push({ name, ok, ...(detail ? { detail } : {}) })
  if (!ok) failed++
}

/** Pure inertness rule (mirrors lib/orders/evidence.ts getServicesEvidence). */
function enforced(cutover: string | null, orderCreatedAt: string): boolean {
  const placedOn = orderCreatedAt.slice(0, 10)
  return !!cutover && placedOn >= cutover
}

function contract() {
  // machine
  check('next starts at accepted', nextMilestoneKind([]) === 'accepted')
  check('next ends at null when complete', nextMilestoneKind(['accepted', 'site_or_materials', 'in_progress', 'work_complete']) === null)
  check('out-of-order rejected', !canAddMilestone([], 'in_progress', 'in_progress').ok)
  check('duplicate rejected', !canAddMilestone(['accepted'], 'accepted', 'in_progress').ok)
  check('add rejected when order not open', !canAddMilestone([], 'accepted', 'completed').ok)
  check('in-order add accepted', canAddMilestone(['accepted', 'site_or_materials'], 'in_progress', 'in_progress').ok)

  // gate
  const wc = (p: string | null) => [{ kind: 'work_complete' as MilestoneKind, photo_doc_id: p }]
  check('held without work-complete photo', evaluateServicesReleaseGate({ milestones: [], buyerConfirmedAt: new Date(), disputeOpen: false }).reasons.includes('missing_work_complete_photo'))
  check('held while unconfirmed', evaluateServicesReleaseGate({ milestones: wc(UUID), buyerConfirmedAt: null, disputeOpen: false }).reasons.includes('awaiting_buyer_confirmation'))
  check('held while disputed', evaluateServicesReleaseGate({ milestones: wc(UUID), buyerConfirmedAt: new Date(), disputeOpen: true }).reasons.includes('dispute_open'))
  check('released when clear', evaluateServicesReleaseGate({ milestones: wc(UUID), buyerConfirmedAt: new Date(), disputeOpen: false }).ok)

  // cutover inertness
  check('null cutover never enforces', enforced(null, '2026-09-20T00:00:00Z') === false)
  check('order before cutover not enforced', enforced('2026-10-01', '2026-09-20T00:00:00Z') === false)
  check('order on/after cutover enforced', enforced('2026-10-01', '2026-10-05T00:00:00Z') === true)
}

async function structural() {
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL']
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY']
  if (!url || !key) {
    rows.push({ name: 'structural checks', ok: 'skip', detail: 'set NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY' })
    return
  }
  const db = createClient(url, key, { auth: { persistSession: false } })
  // A select of the new columns errors (42703 undefined_column) if 0028 is not applied.
  const { error } = await db.from('order_milestones').select('kind, photo_doc_id, note, created_by').limit(0)
  check('order_milestones has evidence columns (0028 applied)', !error, error?.message)
}

async function main() {
  contract()
  await structural()
  console.log('\nverify-evidence\n')
  for (const r of rows) {
    const mark = r.ok === 'skip' ? '⏭' : r.ok ? '✓' : '✗'
    console.log(`  ${mark} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
  }
  const skipped = rows.filter((r) => r.ok === 'skip').length
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${rows.length} checks: ${rows.length - failed - skipped} pass, ${skipped} skipped, ${failed} FAIL\n`)
  // Set exitCode + let Node drain (a forced process.exit races the supabase
  // client's teardown and trips a libuv assertion on Windows).
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 2
})
