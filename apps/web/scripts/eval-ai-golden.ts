/**
 * Phase 8 §6 — golden-set eval for the voice-RFQ parser.
 *
 * Runs every case in tests/ai-golden/cases.json through the REAL parser and
 * compares the structured fields: category_slug, specialization (template
 * field), state, uncertain. description_english is checked non-empty only
 * (LLM restatements vary legitimately).
 *
 * Three modes, picked automatically:
 *  1. OPENROUTER_API_KEY set → parser called in-process (CI with secret).
 *  2. No key but EVAL_BASE_URL + SUPABASE_SERVICE_ROLE_KEY → drives the
 *     deployed /api/v1/admin/voice-parse-text diagnostic (the key lives in
 *     Vercel) with a kill-test admin user, cleaned up afterwards.
 *  3. Neither → prints SKIPPED, exits 0 — safe on every CI runner.
 *
 * Live cost: ~25 temperature-0 calls ≈ ₹0.25 on the default model.
 *
 * Run: pnpm --filter @amclub/web eval:golden
 *      EVAL_BASE_URL=https://amclub-web.vercel.app pnpm --filter @amclub/web eval:golden
 * (Re-execs itself with --conditions=react-server so the parser's
 *  `server-only` import resolves outside Next.)
 */
import { spawnSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { config } from 'dotenv'
config({ path: path.resolve(__dirname, '../.env.local') })

if (!(process.env['NODE_OPTIONS'] ?? '').includes('react-server')) {
  const r = spawnSync('npx', ['tsx', __filename], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --conditions=react-server`.trim() },
  })
  process.exit(r.status ?? 1)
}

interface GoldenCase {
  id: string
  lang: string
  note?: string
  utterance: string
  expect: {
    category_slug: string | null
    specialization?: string | string[] | null
    state?: string | null
    uncertain: boolean
  }
}

type ParseFn = (text: string, lang: string) => Promise<{ parse: Record<string, unknown> }>

/** Mode 2 — parse via the deployed admin diagnostic endpoint. */
async function makeRemoteParser(): Promise<{ parseFn: ParseFn; cleanup: () => Promise<void> }> {
  const { createClient } = await import('@supabase/supabase-js')
  const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']!
  const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
  const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
  const BASE = process.env['EVAL_BASE_URL']!
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })
  const email = `golden_${Date.now()}@killtest.amclub`
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error(error.message)
  await admin.from('users').insert({ id: data.user.id, email, roles: ['admin'] })
  const anon = createClient(URL_, ANON, { auth: { persistSession: false } })
  const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
  const token = s.session!.access_token
  return {
    parseFn: async (text, lang) => {
      const res = await fetch(`${BASE}/api/v1/admin/voice-parse-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text, lang }),
      })
      if (!res.ok) throw new Error(`endpoint ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return res.json()
    },
    cleanup: async () => {
      await admin.from('ai_invocations').delete().eq('user_id', data.user.id)
      await admin.from('users').delete().eq('id', data.user.id)
      await admin.auth.admin.deleteUser(data.user.id).catch(() => {})
    },
  }
}

async function main() {
  let parseFn: ParseFn
  let cleanup: (() => Promise<void>) | null = null
  let mode: string

  if (process.env['OPENROUTER_API_KEY']) {
    const { getParser } = await import('../lib/voice/parser')
    const parser = getParser()
    parseFn = (text, lang) => parser.parse(text, lang)
    mode = 'in-process (live key)'
  } else if (process.env['EVAL_BASE_URL'] && process.env['SUPABASE_SERVICE_ROLE_KEY']) {
    const remote = await makeRemoteParser()
    parseFn = remote.parseFn
    cleanup = remote.cleanup
    mode = `remote via ${process.env['EVAL_BASE_URL']}`
  } else {
    console.log('⊘ SKIPPED — OPENROUTER_API_KEY not set (and no EVAL_BASE_URL for remote mode).')
    console.log('  Locally: EVAL_BASE_URL=https://amclub-web.vercel.app pnpm --filter @amclub/web eval:golden')
    console.log('  CI: add OPENROUTER_API_KEY as a repo secret to enable this job.')
    return
  }

  const file = path.resolve(__dirname, '../../../tests/ai-golden/cases.json')
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf8')) as { cases: GoldenCase[] }
  console.log(`\nGolden eval — ${cases.length} cases, ${mode}\n`)

  let pass = 0
  const failures: string[] = []

  for (const c of cases) {
    let verdict = ''
    try {
      const { parse: rawParse } = await parseFn(c.utterance, c.lang)
      const parse = rawParse as {
        category_slug: string | null
        specialization: string | null
        state: string | null
        description_english: string
        uncertain: boolean
      }
      const problems: string[] = []
      if (parse.category_slug !== c.expect.category_slug) {
        problems.push(`category ${parse.category_slug} ≠ ${c.expect.category_slug}`)
      }
      if (parse.uncertain !== c.expect.uncertain) {
        problems.push(`uncertain ${parse.uncertain} ≠ ${c.expect.uncertain}`)
      }
      if (c.expect.specialization !== undefined) {
        const want = c.expect.specialization
        const ok = Array.isArray(want) ? want.includes(parse.specialization ?? '') : parse.specialization === want
        if (!ok) problems.push(`specialization ${parse.specialization} ∉ ${JSON.stringify(want)}`)
      }
      if (c.expect.state !== undefined && parse.state !== c.expect.state) {
        problems.push(`state ${parse.state} ≠ ${c.expect.state}`)
      }
      if (!parse.description_english || parse.description_english.trim().length < 10) {
        problems.push('description_english empty/too short')
      }
      if (problems.length === 0) {
        pass++
        verdict = '✓'
      } else {
        verdict = `✗ ${problems.join('; ')}`
        failures.push(`${c.id}: ${problems.join('; ')}`)
      }
    } catch (e) {
      verdict = `✗ threw: ${e instanceof Error ? e.message.slice(0, 120) : e}`
      failures.push(`${c.id}: ${verdict}`)
    }
    console.log(`  ${verdict.startsWith('✓') ? '✓' : '✗'} ${c.id.padEnd(36)} ${verdict.startsWith('✓') ? '' : verdict}`)
  }

  if (cleanup) await cleanup()

  console.log(`\n═ golden eval: ${pass}/${cases.length} passed`)
  if (failures.length > 0) {
    console.log('\nFailures:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
