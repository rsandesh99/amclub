/**
 * Prompt golden runner (ADR-009 §5). Runs in STUB mode when no LLM key is
 * configured (CI, keyless dev) and in LIVE mode where a key exists, so the same
 * command proves the prompt registry + gateway + schema pipeline in CI and
 * validates real model output when a key is present. Exits non-zero on any
 * failure.
 *
 * Sets: `hello` (S0.1 smoke), `photo_plausibility` (S1.4 vision; synthetic
 * fixtures from scripts/gen-photo-fixtures.ts; live ≥ 80 % agreement) and
 * `quote_extract` (S1.1; live ≥ 90 % of cases agree on every numeric / boolean
 * / date field with `uncertain_fields` ⊇ expected, and EVERY injection case
 * must pass regardless of the percentage). In stub mode the stub producer
 * echoes each case's expectation so CI proves the pipeline.
 *
 * Run: pnpm --filter @amclub/agent-core eval [--set hello|photo_plausibility|quote_extract|all]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clampQuoteExtraction, type QuoteExtraction } from '@amclub/shared'
import {
  buildQuoteExtractParts,
  createGateway,
  gatewayConfigFromEnv,
  getPrompt,
  loadDefaultPrompts,
  type Gateway,
} from '../src/index'
import { helloSchema } from '../src/prompts/hello/schema'
import { photoPlausibilitySchema } from '../src/prompts/photo_plausibility/schema'
import { quoteExtractionSchema } from '../src/prompts/quote_extract/schema'

const here = dirname(fileURLToPath(import.meta.url))

interface HelloCase {
  input: string
  expectOk: boolean
}
interface PhotoCase {
  image: string
  claimed_stage: string
  expected: { is_screenshot_or_document: boolean; looks_like_work: boolean }
  duplicate_of?: string
}
interface QuoteCase {
  id: string
  text: string
  context: { kind: 'services' | 'goods'; unit?: string; qty?: number; today: string }
  expect: QuoteExtraction
  injection?: boolean
  forbidden_in_summary?: string[]
}
interface SetResult {
  name: string
  pass: number
  fail: number
  ok: boolean
}

async function runHello(gateway: Gateway, live: boolean): Promise<SetResult> {
  const cases = JSON.parse(readFileSync(join(here, '../golden/hello.json'), 'utf8')) as HelloCase[]
  const prompt = getPrompt('hello', 'v1')
  let pass = 0
  let fail = 0
  for (const c of cases) {
    try {
      const res = await gateway.chatJson({
        taskClass: prompt.taskClass,
        prompt,
        schema: helloSchema,
        parts: { trusted: [c.input] },
        stub: () => ({ reply: `Hi! Received: ${c.input}`.slice(0, 120), ok: true as const }),
      })
      if (res.data.ok === c.expectOk && res.data.reply.length > 0) {
        pass++
        console.log(`  ✓ ${live ? 'live' : 'stub'}  ${JSON.stringify(c.input)} -> ${JSON.stringify(res.data.reply).slice(0, 60)}`)
      } else {
        fail++
        console.error(`  ✗ ${JSON.stringify(c.input)} -> unexpected ${JSON.stringify(res.data)}`)
      }
    } catch (e) {
      fail++
      console.error(`  ✗ ${JSON.stringify(c.input)} -> ${(e as Error).message}`)
    }
  }
  return { name: 'hello@v1', pass, fail, ok: fail === 0 }
}

async function runPhotoPlausibility(gateway: Gateway, live: boolean): Promise<SetResult> {
  const cases = JSON.parse(readFileSync(join(here, '../golden/photo_plausibility.json'), 'utf8')) as PhotoCase[]
  const prompt = getPrompt('photo_plausibility', 'v1')
  let agree = 0
  let errors = 0
  for (const c of cases) {
    const bytes = readFileSync(join(here, '../golden/photos', c.image))
    const url = `data:image/jpeg;base64,${bytes.toString('base64')}`
    try {
      const res = await gateway.chatJson({
        taskClass: prompt.taskClass,
        prompt,
        schema: photoPlausibilitySchema,
        parts: {
          trusted: [
            'Order category: general services (synthetic eval)',
            'Order title: evidence photo review (synthetic eval)',
            `Image ${c.image}: claimed stage = ${c.claimed_stage}; uploaded 2026-09-01T09:00:00Z`,
          ],
          images: [{ url, mime: 'image/jpeg', label: c.image }],
        },
        stub: () => ({
          findings: [
            {
              doc_id: c.image,
              looks_like_work: c.expected.looks_like_work,
              matches_stage: c.expected.looks_like_work,
              is_screenshot_or_document: c.expected.is_screenshot_or_document,
              concerns: c.expected.looks_like_work ? [] : ['synthetic fixture'],
              confidence: 0.9,
            },
          ],
        }),
      })
      const f = res.data.findings.find((x) => x.doc_id === c.image) ?? res.data.findings[0]
      const ok = !!f && f.is_screenshot_or_document === c.expected.is_screenshot_or_document && f.looks_like_work === c.expected.looks_like_work
      if (ok) agree++
      console.log(`  ${ok ? '✓' : '·'} ${live ? 'live' : 'stub'}  ${c.image.padEnd(18)} doc=${String(f?.is_screenshot_or_document).padEnd(5)} work=${String(f?.looks_like_work).padEnd(5)} (expected doc=${c.expected.is_screenshot_or_document} work=${c.expected.looks_like_work})`)
    } catch (e) {
      errors++
      console.error(`  ✗ ${c.image} -> ${(e as Error).message}`)
    }
  }
  const total = cases.length
  const pct = total ? Math.round((agree / total) * 100) : 0
  const ok = errors === 0 && (live ? pct >= 80 : agree === total)
  console.log(`  agreement ${agree}/${total} (${pct} %)${live ? ' — live threshold 80 %' : ''}`)
  return { name: 'photo_plausibility@v1', pass: agree, fail: total - agree + errors, ok }
}

const QUOTE_COMPARE_FIELDS = ['price_paise', 'unit_price_paise', 'delivery_days', 'gst_included', 'transport_included', 'valid_until', 'advance_percent', 'gst_rate_bps', 'hsn_code'] as const

async function runQuoteExtract(gateway: Gateway, live: boolean): Promise<SetResult> {
  const cases = JSON.parse(readFileSync(join(here, '../golden/quote_extract.json'), 'utf8')) as QuoteCase[]
  const prompt = getPrompt('quote_extract', 'v1')
  const disagreements: Record<string, number> = Object.fromEntries([...QUOTE_COMPARE_FIELDS, 'uncertain_fields', 'forbidden_in_summary'].map((f) => [f, 0]))
  let agree = 0
  let errors = 0
  let injectionTotal = 0
  let injectionPass = 0
  for (const c of cases) {
    const parts = buildQuoteExtractParts({ text: c.text, rfqId: `golden-${c.id}`, today: c.context.today, kind: c.context.kind, unit: c.context.unit ?? null, qty: c.context.qty ?? null, locale: 'en' })
    try {
      const res = await gateway.chatJson({
        taskClass: prompt.taskClass,
        prompt,
        schema: quoteExtractionSchema,
        parts,
        temperature: 0,
        stub: () => c.expect,
      })
      // Compare what production would STORE: the clamped object.
      const got = clampQuoteExtraction(res.data, { kind: c.context.kind, today: c.context.today })
      const bad: string[] = []
      for (const f of QUOTE_COMPARE_FIELDS) {
        if (got[f] !== c.expect[f]) {
          bad.push(`${f}=${JSON.stringify(got[f])}≠${JSON.stringify(c.expect[f])}`)
          disagreements[f] = (disagreements[f] ?? 0) + 1
        }
      }
      const missingUncertain = c.expect.uncertain_fields.filter((u) => !got.uncertain_fields.includes(u))
      if (missingUncertain.length) {
        bad.push(`uncertain missing ${missingUncertain.join(',')}`)
        disagreements['uncertain_fields'] = (disagreements['uncertain_fields'] ?? 0) + 1
      }
      const summary = got.scope_summary.toLowerCase()
      const leaked = (c.forbidden_in_summary ?? []).filter((m) => summary.includes(m.toLowerCase()))
      if (leaked.length) {
        bad.push(`summary leaks ${leaked.join(' | ')}`)
        disagreements['forbidden_in_summary'] = (disagreements['forbidden_in_summary'] ?? 0) + 1
      }
      const ok = bad.length === 0
      if (ok) agree++
      if (c.injection) {
        injectionTotal++
        if (ok) injectionPass++
      }
      console.log(`  ${ok ? '✓' : '·'} ${live ? 'live' : 'stub'}  ${c.id.padEnd(30)}${c.injection ? ' [injection]' : ''}${ok ? '' : `  ${bad.join('; ')}`}`)
    } catch (e) {
      errors++
      if (c.injection) injectionTotal++
      console.error(`  ✗ ${c.id} -> ${(e as Error).message}`)
    }
  }
  const total = cases.length
  const pct = total ? Math.round((agree / total) * 100) : 0
  const injectionsOk = injectionPass === injectionTotal
  const ok = errors === 0 && injectionsOk && (live ? pct >= 90 : agree === total)
  console.log(`  agreement ${agree}/${total} (${pct} %)${live ? ' — live threshold 90 %' : ''}; injection ${injectionPass}/${injectionTotal} (all must pass)`)
  const noisy = Object.entries(disagreements).filter(([, n]) => n > 0)
  if (noisy.length) console.log(`  per-field disagreements: ${noisy.map(([f, n]) => `${f}=${n}`).join(', ')}`)
  return { name: 'quote_extract@v1', pass: agree, fail: total - agree + errors, ok }
}

async function main() {
  loadDefaultPrompts()
  const cfg = gatewayConfigFromEnv()
  const gateway = createGateway(cfg)
  const live = !cfg.forceStub && !!cfg.apiKey
  const argIdx = process.argv.indexOf('--set')
  const set = argIdx >= 0 ? (process.argv[argIdx + 1] ?? 'all') : 'all'

  const results: SetResult[] = []
  if (set === 'all' || set === 'hello') results.push(await runHello(gateway, live))
  if (set === 'all' || set === 'photo_plausibility') results.push(await runPhotoPlausibility(gateway, live))
  if (set === 'all' || set === 'quote_extract') results.push(await runQuoteExtract(gateway, live))
  if (results.length === 0) {
    console.error(`unknown --set '${set}' (hello | photo_plausibility | quote_extract | all)`)
    process.exit(2)
  }
  console.log('')
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}: ${r.pass} passed, ${r.fail} failed (${live ? 'LIVE' : 'STUB'} mode)`)
  console.log('')
  process.exit(results.every((r) => r.ok) ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
