/**
 * The ONE list of scheduled crons and what counts as a bad run (audit M35).
 *
 * vercel.json schedules them, every cron route records a heartbeat through
 * lib/jobs/heartbeat.ts, and /admin renders this list. `pnpm lint` runs
 * scripts/lint/cron-registry.ts, which fails when vercel.json, the cron route
 * folders and this list disagree — a new cron cannot go unwatched.
 *
 * Pure data + pure functions (no server-only import): the admin page and the
 * lint script import it too.
 */

export const CRON_HEARTBEAT_STATUSES = ['ok', 'degraded', 'failed'] as const
/** ok = finished clean · degraded = finished but reported failures · failed = threw. */
export type CronHeartbeatStatus = (typeof CRON_HEARTBEAT_STATUSES)[number]

/** Everything a run can report as wrong. Each has `admin_ops.jobs_issue_<code>` copy ({n}). */
export const CRON_ISSUE_CODES = [
  'payouts_failed',
  'payouts_held',
  'payouts_unconfirmed',
  'refunds_failing',
  'not_enqueued',
  'update_errors',
  'step_errors',
] as const
export type CronIssueCode = (typeof CRON_ISSUE_CODES)[number]
export interface CronIssue {
  code: CronIssueCode
  n: number
}

/** A failed run's summary is this prefix + the error text. */
export const CRON_ERROR_PREFIX = 'error: '

type Result = Record<string, unknown>

export interface CronJobDef {
  /** The route folder under app/api/v1/cron and the heartbeat name. */
  name: string
  /** Red when the last beat is older than this: about two missed runs plus slack. */
  staleAfterMs: number
  /** The job beats only with this switch on (pool-close records nothing while MART_ENABLED=false). */
  requires?: 'mart'
  /** What in this job's result is a failure. Absent: only a throw fails it. */
  issues?: (r: Result) => CronIssue[]
}

/**
 * Route folders under app/api/v1/cron that are deliberately NOT scheduled.
 * `daily` runs every money job once, by hand, for backfills (ADR 001).
 */
export const UNSCHEDULED_CRON_ROUTES = ['daily'] as const

const H = 3_600_000

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const obj = (v: unknown): Result => (v !== null && typeof v === 'object' ? (v as Result) : {})
const issue = (code: CronIssueCode, v: unknown): CronIssue[] => (num(v) > 0 ? [{ code, n: num(v) }] : [])

/**
 * The agent crons only ask the runtime to run a job. Not enqueuing is expected while the
 * switch is off (`agent_disabled`) or the runtime is not deployed yet (`not_configured`:
 * those agents read as off web-side, RUNTIME.md); any other reason (HTTP error, timeout)
 * means the runtime refused or never answered.
 */
const EXPECTED_NOT_ENQUEUED = new Set(['agent_disabled', 'not_configured'])
const enqueueIssues = (r: Result): CronIssue[] =>
  r['enqueued'] === false && !EXPECTED_NOT_ENQUEUED.has(String(r['reason'])) ? [{ code: 'not_enqueued', n: 1 }] : []

export const CRON_JOBS: readonly CronJobDef[] = [
  // Money (ADR 026): a refund still failing, a payout refused / held / unconfirmed is amber.
  { name: 'auto-cancel', staleAfterMs: 3 * H, issues: (r) => issue('refunds_failing', num(r['refundsStillFailing']) + num(r['captureRefundsFailing'])) },
  { name: 'auto-accept', staleAfterMs: 3 * H },
  {
    name: 'payouts',
    staleAfterMs: 26 * H,
    issues: (r) => [...issue('payouts_failed', r['failed']), ...issue('payouts_held', r['held']), ...issue('payouts_unconfirmed', r['unconfirmed'])],
  },
  {
    name: 'reconcile',
    staleAfterMs: 14 * H,
    issues: (r) => [...issue('payouts_failed', obj(r['unconfirmedPayouts'])['failed']), ...issue('payouts_unconfirmed', obj(r['unconfirmedPayouts'])['unknown'])],
  },
  { name: 'rfq-expire', staleAfterMs: 3 * H, issues: (r) => issue('step_errors', r['stepErrors']) },
  {
    name: 'provider-stats',
    staleAfterMs: 26 * H,
    issues: (r) => [
      ...issue('update_errors', r['failed']),
      ...issue(
        'step_errors',
        (obj(r['publicStats'])['skipped'] ? 1 : 0) + num(obj(r['gstin'])['errors']) + (obj(r['quoteSla'])['error'] ? 1 : 0),
      ),
    ],
  },
  { name: 'score-compute', staleAfterMs: 26 * H },
  { name: 'benchmark-compute', staleAfterMs: 26 * H },
  { name: 'licence-reminders', staleAfterMs: 26 * H },
  { name: 'onboarding-nudges', staleAfterMs: 2 * H },
  { name: 'data-foundations', staleAfterMs: 26 * H }, // nightly 21:40 UTC (E15 retention + F4)
  { name: 'pool-close', staleAfterMs: 3 * H, requires: 'mart' }, // hourly Mart cron; inert (no beat) while MART_ENABLED=false
  // Agent crons beat even while AGENT_ENABLED=false (they only skip the enqueue).
  { name: 'agent-munshi-scan', staleAfterMs: 1 * H, issues: enqueueIssues },
  { name: 'agent-munshi-followup', staleAfterMs: 3 * H, issues: enqueueIssues },
  { name: 'agent-onboarding-expire', staleAfterMs: 3 * H, issues: enqueueIssues },
  { name: 'agent-munshi-growth', staleAfterMs: 8 * 24 * H, issues: enqueueIssues }, // weekly (S2.4)
  { name: 'agent-procurement-watch', staleAfterMs: 1 * H, issues: enqueueIssues }, // every 15 min (S3.1)
  { name: 'agent-demand-pools', staleAfterMs: 3 * H }, // hourly (S3.4); a no-op beat while the switch is off
]

/** The failures a finished run reported (empty = ok). Unknown job names report nothing. */
export function cronRunIssues(name: string, result: Result | null | undefined): CronIssue[] {
  const job = CRON_JOBS.find((j) => j.name === name)
  if (!job?.issues || !result) return []
  return job.issues(result)
}

/** "payouts_failed=2 payouts_held=1" — short, greppable in SQL, parsed back by the admin page. */
export function encodeCronIssues(issues: readonly CronIssue[]): string | null {
  return issues.length ? issues.map((i) => `${i.code}=${i.n}`).join(' ') : null
}

export function decodeCronIssues(summary: string | null | undefined): CronIssue[] {
  if (!summary || summary.startsWith(CRON_ERROR_PREFIX)) return []
  const out: CronIssue[] = []
  for (const part of summary.split(' ')) {
    const [code, n] = part.split('=')
    if ((CRON_ISSUE_CODES as readonly string[]).includes(code ?? '') && Number(n) > 0) out.push({ code: code as CronIssueCode, n: Number(n) })
  }
  return out
}
