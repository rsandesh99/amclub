import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * S2.1 — the agent-writes audit (ARCHITECTURE.md §4, the taint law's other
 * half). Agent code — the runtime agents, the WhatsApp dispatcher and the
 * Vercel-side agent libs — may write ONLY agent-owned tables. Money, status and
 * user-data writes happen in /api/v1 routes and lib functions under the user's
 * own session (or the founder's click). This test greps both trees for
 * `.from('<table>') … .insert|update|upsert|delete(` and fails on any table
 * outside the allow-list; two tables are allowed for ONE named column each.
 *
 * Limits (FOLLOWUPS S2.1): a dynamic table name (`.from(tableVar)`) is not
 * seen; a multi-line chain is matched across up to 6 lines.
 */

/** Tables agent code may write, with the reason. */
export const AGENT_WRITE_ALLOWLIST: Readonly<Record<string, string>> = {
  agent_runs: 'the run ledger (S0.1) — every run row',
  agent_events: 'the append-only run trace (S0.1)',
  agent_grants: 'delegated-identity grants (S0.1) — insert on consent, revoke on the user\'s request',
  agent_settings: 'the closed config registry (S0.1) — rigs restore what they touch',
  ai_invocations: 'model-call telemetry (Phase 8b / S0.1)',
  ai_decisions: 'the ONE confirmation ledger (0027) — written when a human confirms',
  wa_conversations: 'WhatsApp conversation state (S0.5)',
  wa_messages: 'WhatsApp inbound / outbound log (S0.5)',
  payout_dossiers: 'the Payout-Evidence dossier (S1.4) — recommendation only; the founder decides on the existing route',
  evidence_photo_hashes: 'dHash cache for duplicate photos (S1.4)',
  onboarding_sessions: 'the WhatsApp interview session (S1.6)',
  provider_capability_facts: 'facts the provider confirmed by button (S1.6) — never provider_profiles',
  dispute_triages: 'the triage card (S1.7) — recommendation only; the resolve route is the money path',
  rfq_intake_extractions: 'intake results the buyer confirms with the Create tap (S1.8)',
  munshi_drafts: 'Munshi proposals (S2.2) — a draft row per RFQ / thread; the quote / clarification / message routes are the writes',
  munshi_provider_state: 'Munshi per-provider scan state, daily counter, reminders (S2.2)',
  quote_extractions: 'quote prefill the provider confirms with Submit (S1.1)',
  provider_price_book: 'the provider\'s own price memory, upserted from their confirmed quotes (S1.1)',
}

/**
 * Column-scoped exceptions: a non-agent table may be written ONLY for these
 * columns (checked against the literal keys of the `.update({ … })` object).
 * `updated_at` is always allowed alongside.
 */
export const AGENT_WRITE_COLUMN_EXCEPTIONS: Readonly<Record<string, readonly string[]>> = {
  // S1.5 — the quality report and its timestamp live on the RFQ row; fan-out release is lib/rfq/release.ts, not agent code.
  rfqs: ['quality_report', 'quality_checked_at', 'quality_decision', 'compare_pointers'],
  // S1.7 — the dispute points at its latest triage; the resolution columns are the resolve route's alone.
  disputes: ['triage_id'],
}

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '../../..')
const TREES = ['apps/agent-runtime/src', 'apps/web/lib/agent', 'apps/web/lib/voice/clarify.ts']

function files(p: string): string[] {
  const abs = join(ROOT, p)
  const st = statSync(abs)
  if (st.isFile()) return [abs]
  const out: string[] = []
  for (const name of readdirSync(abs)) {
    const full = join(abs, name)
    if (statSync(full).isDirectory()) out.push(...files(relative(ROOT, full)))
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full)
  }
  return out
}

interface WriteHit { file: string; line: number; table: string; op: string; columns: string[] }

const FROM_RE = /\.from\(\s*'([a-z_]+)'\s*\)/g
const OP_RE = /\.(insert|update|upsert|delete)\(\s*(\{[^}]*\})?/

function scan(): WriteHit[] {
  const hits: WriteHit[] = []
  for (const tree of TREES) {
    for (const file of files(tree)) {
      const src = readFileSync(file, 'utf8')
      const lines = src.split('\n')
      for (let i = 0; i < lines.length; i++) {
        FROM_RE.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = FROM_RE.exec(lines[i]!)) !== null) {
          const table = m[1]!
          // the operation may follow on the same line or within the next 6 lines (chained builder) — but only
          // until the next `.from(`: a later chain on another table is not this write.
          const window = lines.slice(i, i + 7).join('\n')
          let after = window.slice(window.indexOf(m[0]) + m[0].length)
          const nextFrom = after.indexOf('.from(')
          if (nextFrom >= 0) after = after.slice(0, nextFrom)
          const op = OP_RE.exec(after)
          if (!op) continue
          const cols = op[2] ? [...op[2].matchAll(/([A-Za-z_]+)\s*:/g)].map((c) => c[1]!) : []
          hits.push({ file: relative(ROOT, file).replace(/\\/g, '/'), line: i + 1, table, op: op[1]!, columns: cols })
        }
      }
    }
  }
  return hits
}

describe('S2.1 agent-writes audit', () => {
  const hits = scan()

  it('found the writes it expects to audit (the scan is not silently empty)', () => {
    expect(hits.length).toBeGreaterThan(10)
    expect(hits.some((h) => h.table === 'ai_invocations' || h.table === 'agent_events' || h.table === 'rfq_intake_extractions')).toBe(true)
  })

  it('every agent-code write targets an allow-listed agent-owned table, or an allowed column of rfqs / disputes', () => {
    const offenders = hits.filter((h) => {
      if (AGENT_WRITE_ALLOWLIST[h.table]) return false
      const allowedCols = AGENT_WRITE_COLUMN_EXCEPTIONS[h.table]
      if (!allowedCols) return true
      if (h.op !== 'update') return true
      return !h.columns.every((c) => c === 'updated_at' || allowedCols.includes(c))
    })
    expect(offenders.map((h) => `${h.file}:${h.line} ${h.op} ${h.table} {${h.columns.join(',')}}`)).toEqual([])
  })

  it('never writes orders, quotes, payouts, provider_profiles, msme_profiles, users or payments', () => {
    const forbidden = ['orders', 'quotes', 'payouts', 'provider_profiles', 'msme_profiles', 'users', 'payments', 'refunds', 'invoices']
    expect(hits.filter((h) => forbidden.includes(h.table)).map((h) => `${h.file}:${h.line} ${h.op} ${h.table}`)).toEqual([])
  })

  it('the allow-list carries a reason per table', () => {
    for (const [t, why] of Object.entries(AGENT_WRITE_ALLOWLIST)) expect(why.length, t).toBeGreaterThan(10)
  })
})
