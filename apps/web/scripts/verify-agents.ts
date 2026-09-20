/**
 * verify-agents — S0.1 authz + inertness kill-test (verify-* convention).
 *
 * Three modes, like eval:golden:
 *   OFFLINE (always): runtime-credential HMAC round-trip / tamper / window; the
 *     grant scope-subset rule. No server, no secrets.
 *   HTTP flag-OFF (BASE_URL): every /api/v1/agent/* returns 404 (inertness) —
 *     the proof the whole surface ships dark while AGENT_ENABLED=false.
 *   HTTP flag-ON (BASE_URL + AGENT_ENABLED=true, optionally AGENT_VERIFY_*):
 *     no session -> 401; bad runtime credential -> 401; valid credential with
 *     NO grant -> 403; and, when a JWT comes back, exp <= 15 min with the
 *     expected claims. Positive-path checks that need a seeded user/secret are
 *     SKIPPED (not failed) when the inputs are absent.
 *
 * Zero prod residue: this script never writes to the database.
 * Run: BASE_URL=<url> pnpm --filter @amclub/web agents:verify
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import {
  signRuntimeCredential,
  verifyRuntimeCredential,
} from '@amclub/agent-core'
import { scopesWithinPersona, agentGrantSchema } from '@amclub/shared'

const BASE_URL = process.env['BASE_URL'] || ''
const RUNTIME_SECRET = process.env['AGENT_RUNTIME_SECRET'] || ''
const VERIFY_USER = process.env['AGENT_VERIFY_USER_ID'] || ''

type Status = 'pass' | 'FAIL' | 'skip'
const rows: { name: string; status: Status; detail?: string }[] = []
let failed = 0
function record(name: string, status: Status, detail?: string) {
  rows.push({ name, status, ...(detail ? { detail } : {}) })
  if (status === 'FAIL') failed++
}
function check(name: string, cond: boolean, detail?: string) {
  record(name, cond ? 'pass' : 'FAIL', detail)
}

async function drain(res: Response): Promise<unknown> {
  // Always read the body — an unread body keeps the request in flight (the CI
  // networkidle gotcha) and leaks sockets in a script.
  return res.json().catch(() => null)
}

function decodeClaims(token: string): Record<string, unknown> | null {
  try {
    const seg = token.split('.')[1]
    if (!seg) return null
    return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

// ── OFFLINE ──────────────────────────────────────────────────────────────────
function offline() {
  const secret = 'verify-secret'
  const u = '00000000-0000-0000-0000-000000000001'
  const r = '00000000-0000-0000-0000-000000000009'
  const cred = signRuntimeCredential(secret, { userId: u, persona: 'buyer', runId: r })
  check('runtime credential round-trips', verifyRuntimeCredential(secret, cred)?.userId === u)
  check('tampered credential rejected', verifyRuntimeCredential(secret, cred.slice(0, -2) + 'zz') === null)
  check('wrong-secret credential rejected', verifyRuntimeCredential('other', cred) === null)
  const stale = signRuntimeCredential(secret, { userId: u, persona: 'ops', runId: r, ts: Math.floor(Date.now() / 1000) - 3600 })
  check('stale credential (outside +/-5min) rejected', verifyRuntimeCredential(secret, stale) === null)
  check('scopes within persona accepted', scopesWithinPersona('buyer', ['create_rfq', 'search_catalog']))
  check("cross-persona scope rejected", !scopesWithinPersona('buyer', ['submit_quote']))
  check('grant schema rejects cross-persona scope', !agentGrantSchema.safeParse({ persona: 'buyer', scopes: ['submit_quote'], channel: 'web' }).success)
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function http() {
  if (!BASE_URL) {
    record('HTTP checks (no BASE_URL)', 'skip', 'set BASE_URL to a running server / preview / prod')
    return
  }
  const agentPaths = [
    '/api/v1/agent/grants',
    '/api/v1/agent/runs',
    '/api/v1/agent/runs/00000000-0000-0000-0000-000000000000',
    '/api/v1/agent/admin/settings',
    '/api/v1/agent/admin/runs',
    '/api/v1/agent/admin/spend',
    // S1.4
    '/api/v1/agent/admin/dossiers',
    '/api/v1/agent/admin/dossiers/stats',
    '/api/v1/agent/admin/dossiers/00000000-0000-0000-0000-000000000000',
  ]

  // Probe the flag via the token endpoint (404 while AGENT_ENABLED=false).
  const probe = await fetch(`${BASE_URL}/api/v1/agent/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  await drain(probe)
  const flagOff = probe.status === 404

  if (flagOff) {
    check('token endpoint 404s when AGENT_ENABLED=false', probe.status === 404, `status ${probe.status}`)
    for (const p of agentPaths) {
      const res = await fetch(`${BASE_URL}${p}`, { method: 'GET' })
      await drain(res)
      check(`GET ${p} 404s (inert)`, res.status === 404, `status ${res.status}`)
    }
    record('flag-ON positive path', 'skip', 'AGENT_ENABLED=false on this server — inertness verified instead')
    return
  }

  // Flag is ON.
  check('no-session token request -> 401', probe.status === 401, `status ${probe.status}`)

  const badCred = await fetch(`${BASE_URL}/api/v1/agent/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'AMC-Runtime not.a.valid.cred.xxxx' },
    body: '{}',
  })
  await drain(badCred)
  check('bad runtime credential -> 401', badCred.status === 401, `status ${badCred.status}`)

  // Admin routes reject an unauthenticated caller.
  const adminNoAuth = await fetch(`${BASE_URL}/api/v1/agent/admin/settings`, { method: 'GET' })
  await drain(adminNoAuth)
  check('admin settings without auth -> 401', adminNoAuth.status === 401, `status ${adminNoAuth.status}`)

  if (RUNTIME_SECRET && VERIFY_USER) {
    const cred = signRuntimeCredential(RUNTIME_SECRET, { userId: VERIFY_USER, persona: 'buyer', runId: '00000000-0000-0000-0000-000000000009' })
    const res = await fetch(`${BASE_URL}/api/v1/agent/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `AMC-Runtime ${cred}` },
      body: '{}',
    })
    const body = (await drain(res)) as { token?: string } | null
    if (res.status === 403) {
      check('valid runtime credential with NO grant -> 403', true)
    } else if (res.status === 200 && body?.token) {
      // A grant exists for this user — validate the minted JWT shape instead.
      const claims = decodeClaims(body.token)
      const now = Math.floor(Date.now() / 1000)
      check('minted JWT has expected claims', claims?.['role'] === 'authenticated' && claims?.['sub'] === VERIFY_USER && claims?.['amc_persona'] === 'buyer')
      check('minted JWT exp <= 15 min', typeof claims?.['exp'] === 'number' && (claims['exp'] as number) - now <= 900 + 5)
    } else {
      check('runtime credential path (grant present or 403)', false, `unexpected status ${res.status}`)
    }
  } else {
    record('runtime-credential positive/negative path', 'skip', 'set AGENT_RUNTIME_SECRET + AGENT_VERIFY_USER_ID to run')
  }
}

async function main() {
  offline()
  await http()

  console.log(`\nverify-agents ${BASE_URL ? `-> ${BASE_URL}` : '(offline only)'}\n`)
  for (const r of rows) {
    const mark = r.status === 'pass' ? '✓' : r.status === 'skip' ? '⏭' : '✗'
    console.log(`  ${mark} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
  }
  const skipped = rows.filter((r) => r.status === 'skip').length
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${rows.length} checks: ${rows.length - failed - skipped} pass, ${skipped} skipped, ${failed} FAIL\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
