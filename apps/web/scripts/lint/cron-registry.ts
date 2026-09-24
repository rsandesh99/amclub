/**
 * Audit M35 — every scheduled cron is watched. Fails `pnpm lint` when:
 *  - vercel.json schedules a cron that lib/jobs/cron-registry.ts (CRON_JOBS, the /admin jobs panel) does not list,
 *  - CRON_JOBS lists a job vercel.json does not schedule,
 *  - a folder under app/api/v1/cron is neither scheduled nor in UNSCHEDULED_CRON_ROUTES,
 *  - a scheduled cron route does not record its heartbeat (runCronJob / recordHeartbeat),
 *  - a job's staleAfterMs is shorter than its own schedule interval (it would always read red),
 *  - the degraded / failed rules drift (a self-check on fixed results below).
 *
 * Run: pnpm --filter @amclub/web exec tsx scripts/lint/cron-registry.ts
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { CRON_JOBS, UNSCHEDULED_CRON_ROUTES, cronRunIssues, decodeCronIssues, encodeCronIssues } from '../../lib/jobs/cron-registry'

const ROOT = path.resolve(__dirname, '../..')
const CRON_DIR = path.join(ROOT, 'app/api/v1/cron')
const problems: string[] = []

const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')) as { crons?: { path: string; schedule: string }[] }
const scheduled = new Map<string, string>()
for (const c of vercel.crons ?? []) {
  const m = /^\/api\/v1\/cron\/([a-z0-9-]+)$/.exec(c.path)
  if (!m) problems.push(`vercel.json cron path ${c.path} is not /api/v1/cron/<name>`)
  else scheduled.set(m[1]!, c.schedule)
}
const registered = new Map(CRON_JOBS.map((j) => [j.name, j]))
const folders = readdirSync(CRON_DIR).filter((f) => statSync(path.join(CRON_DIR, f)).isDirectory())

for (const name of scheduled.keys()) {
  if (!registered.has(name)) problems.push(`${name}: scheduled in vercel.json but missing from CRON_JOBS (lib/jobs/cron-registry.ts) — /admin would never show it`)
}
for (const name of registered.keys()) {
  if (!scheduled.has(name)) problems.push(`${name}: in CRON_JOBS but not scheduled in vercel.json`)
}
for (const f of folders) {
  if (!scheduled.has(f) && !(UNSCHEDULED_CRON_ROUTES as readonly string[]).includes(f)) {
    problems.push(`app/api/v1/cron/${f}: not scheduled in vercel.json and not listed in UNSCHEDULED_CRON_ROUTES`)
  }
}
for (const name of scheduled.keys()) {
  const route = path.join(CRON_DIR, name, 'route.ts')
  if (!existsSync(route)) {
    problems.push(`${name}: scheduled but app/api/v1/cron/${name}/route.ts does not exist`)
    continue
  }
  const src = readFileSync(route, 'utf8')
  if (!src.includes(`runCronJob(admin, '${name}'`) && !src.includes(`recordHeartbeat(admin, '${name}'`)) {
    problems.push(`${name}: route never records its heartbeat under that name (use runCronJob(admin, '${name}', …))`)
  }
}

/** Smallest gap between two runs of a 5-field cron: enough for the shapes vercel.json uses. */
function intervalMs(schedule: string): number {
  const [min, hour, dom, , dow] = schedule.split(/\s+/)
  const H = 3_600_000
  if (dow && dow !== '*') return 7 * 24 * H
  if (dom && dom !== '*') return 28 * 24 * H
  const step = (field: string | undefined, unit: number, span: number) => {
    if (!field || field === '*') return unit
    const every = /^\*\/(\d+)$/.exec(field)
    if (every) return Number(every[1]) * unit
    const list = field.split(',').length
    return (span / list) * unit
  }
  if (hour && hour !== '*') return step(hour, H, 24)
  return step(min, 60_000, 60)
}
for (const [name, schedule] of scheduled) {
  const job = registered.get(name)
  if (job && job.staleAfterMs <= intervalMs(schedule)) {
    problems.push(`${name}: staleAfterMs ${job.staleAfterMs} ms is not longer than its schedule "${schedule}" — it would always read red`)
  }
}

// Self-check of the outcome rules (what /admin paints amber).
const expect = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`rule self-check "${label}": got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}
expect('clean payout run is ok', cronRunIssues('payouts', { processed: 3, held: 0, unconfirmed: 0, failed: 0 }), [])
expect(
  'payout failures are degraded',
  encodeCronIssues(cronRunIssues('payouts', { processed: 1, held: 1, unconfirmed: 0, failed: 2 })),
  'payouts_failed=2 payouts_held=1',
)
expect('refunds still failing', encodeCronIssues(cronRunIssues('auto-cancel', { refundsStillFailing: 1 })), 'refunds_failing=1')
expect('reconcile nested counts', encodeCronIssues(cronRunIssues('reconcile', { unconfirmedPayouts: { paid: 1, failed: 1, unknown: 2 } })), 'payouts_failed=1 payouts_unconfirmed=2')
expect('agent switch off is ok', cronRunIssues('agent-munshi-scan', { enqueued: false, reason: 'agent_disabled' }), [])
expect('runtime not deployed is ok', cronRunIssues('agent-munshi-scan', { enqueued: false, reason: 'not_configured' }), [])
expect('runtime refusal is degraded', encodeCronIssues(cronRunIssues('agent-munshi-scan', { enqueued: false, reason: 'http_503' })), 'not_enqueued=1')
expect('provider-stats side steps', encodeCronIssues(cronRunIssues('provider-stats', { failed: 0, publicStats: { skipped: 'x' }, gstin: { errors: 2 }, quoteSla: { cells: 0 } })), 'step_errors=3')
expect('summary round-trips', decodeCronIssues('payouts_failed=2 payouts_held=1'), [{ code: 'payouts_failed', n: 2 }, { code: 'payouts_held', n: 1 }])
expect('an error summary has no issues', decodeCronIssues('error: boom'), [])

if (problems.length > 0) {
  console.error(`✗ cron registry (audit M35): ${problems.length} problem(s)`)
  for (const p of problems) console.error(`  • ${p}`)
  process.exit(1)
}
console.log(`✓ cron registry: ${scheduled.size} scheduled crons, all watched at /admin with outcome rules (${UNSCHEDULED_CRON_ROUTES.join(', ')} unscheduled by design).`)
