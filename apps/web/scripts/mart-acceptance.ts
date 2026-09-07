/**
 * AMC Mart — ACCEPTANCE BUNDLE (Launch Gate item 1). One command runs the
 * milestone suites in order against BASE_URL and prints a scoreboard:
 *
 *   default (flag ON on the target):  verify-mart (M0) → verify-goods-rfq (M2)
 *                                     → DB killtests (schema, pools, goods RFQ) when DATABASE_URL is a LOCAL db
 *   --inert (flag OFF on the target): verify-mart-inert
 *
 * Each suite is its own process (its own env + cleanup); a failing suite
 * fails the bundle but the rest still run so the scoreboard is complete.
 *
 * Run: BASE_URL=<preview> pnpm --filter @amclub/web mart:acceptance
 *      BASE_URL=<prod>    pnpm --filter @amclub/web mart:acceptance -- --inert
 */
import { spawnSync } from 'child_process'
import path from 'path'

const inert = process.argv.includes('--inert')
const here = path.resolve(__dirname)
const webRoot = path.resolve(here, '..')
const dbUrl = process.env['DATABASE_URL']
const localDb = !!dbUrl && !/supabase\.co|pooler\.supabase|amclub-prod/i.test(dbUrl)

interface Suite { name: string; cwd: string; cmd: string; args: string[] }
const web = (name: string, file: string): Suite => ({ name, cwd: webRoot, cmd: 'pnpm', args: ['exec', 'tsx', `scripts/${file}`] })
const db = (name: string, file: string): Suite => ({ name, cwd: path.resolve(webRoot, '../../packages/db'), cmd: 'pnpm', args: ['exec', 'tsx', `src/scripts/${file}`, '--url', dbUrl!] })

const suites: Suite[] = inert
  ? [web('inertness (flag OFF)', 'verify-mart-inert.ts')]
  : [
      web('M0 catalog + goods lifecycle + authz', 'verify-mart.ts'),
      web('M2 goods RFQ lifecycle', 'verify-goods-rfq.ts'),
      ...(localDb ? [db('DB: 0022 schema', 'killtest-mart-schema.ts'), db('DB: 0023 pools', 'killtest-mart-pools.ts'), db('DB: 0024 goods RFQ', 'killtest-mart-goods-rfq.ts')] : []),
    ]

console.log(`\nMart acceptance ${inert ? '(inert)' : '(flag ON)'} → ${process.env['BASE_URL'] ?? 'http://localhost:3000'}${localDb ? ' + local DB killtests' : ''}\n`)
const results: { name: string; code: number; summary: string }[] = []
for (const s of suites) {
  console.log(`━━ ${s.name}`)
  const r = spawnSync(s.cmd, s.args, { cwd: s.cwd, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  const summary = (r.stdout.match(/(\d+) passed, (\d+) failed/) ?? r.stdout.match(/(\d+) pass, (\d+) warn, (\d+) fail/))?.[0] ?? (r.status === 0 ? 'ok' : `exit ${r.status}`)
  results.push({ name: s.name, code: r.status ?? 1, summary })
}
console.log('\n━━ scoreboard')
for (const r of results) console.log(`  ${r.code === 0 ? '✅' : '❌'} ${r.name}: ${r.summary}`)
const failed = results.filter((r) => r.code !== 0).length
console.log(`\n${failed === 0 ? '✅' : '❌'} ${results.length - failed}/${results.length} suites green\n`)
process.exit(failed ? 1 : 0)
