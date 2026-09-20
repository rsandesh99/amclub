/**
 * Prompt golden runner (ADR-009 §5). Runs in STUB mode when no LLM key is
 * configured (CI, keyless dev) and in LIVE mode where a key exists, so the same
 * command proves the prompt registry + gateway + schema pipeline in CI and
 * validates real model output when a key is present. Exits non-zero on any
 * failure.
 *
 * Sets: `hello` (S0.1), `photo_plausibility` (S1.4; live ≥ 80 %),
 * `quote_extract` (S1.1; live ≥ 90 % + all injections), `quote_compare` (S1.2;
 * live ≥ 90 % cases with zero banned phrases and every quote_id present; the
 * parts-builder taint check runs in every mode) and `decline_message` (S1.2;
 * live ≥ 90 % script/length/no-contact + 5/5 injection). Stub producers echo
 * the expectation so CI proves the pipeline.
 *
 * Run: pnpm --filter @amclub/agent-core eval [--set <name>|all]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  clampQuoteExtraction,
  compareQuotes,
  declineMessageTemplate,
  findBannedPhrases,
  messageMatchesLocaleScript,
  type CompareQuoteInput,
  type DeclineMessageLocale,
  type PointerLocale,
  type QuoteDeclineReason,
  type QuoteExtraction,
} from '@amclub/shared'
import {
  buildComparePointerParts,
  buildDeclineMessageParts,
  buildQuoteExtractParts,
  createGateway,
  gatewayConfigFromEnv,
  getPrompt,
  loadDefaultPrompts,
  stubComparePointers,
  type ComparePointerQuote,
  type Gateway,
} from '../src/index'
import { helloSchema } from '../src/prompts/hello/schema'
import { photoPlausibilitySchema } from '../src/prompts/photo_plausibility/schema'
import { quoteExtractionSchema } from '../src/prompts/quote_extract/schema'
import { comparePointersSchema } from '../src/prompts/quote_compare/schema'
import { declineMessageSchema } from '../src/prompts/decline_message/schema'

const here = dirname(fileURLToPath(import.meta.url))
const readJson = <T,>(rel: string): T => JSON.parse(readFileSync(join(here, rel), 'utf8')) as T

interface SetResult {
  name: string
  pass: number
  fail: number
  ok: boolean
}

// ── hello ────────────────────────────────────────────────────────────────────
async function runHello(gateway: Gateway, live: boolean): Promise<SetResult> {
  const cases = readJson<Array<{ input: string; expectOk: boolean }>>('../golden/hello.json')
  const prompt = getPrompt('hello', 'v1')
  let pass = 0
  let fail = 0
  for (const c of cases) {
    try {
      const res = await gateway.chatJson({ taskClass: prompt.taskClass, prompt, schema: helloSchema, parts: { trusted: [c.input] }, stub: () => ({ reply: `Hi! Received: ${c.input}`.slice(0, 120), ok: true as const }) })
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

// ── photo_plausibility ───────────────────────────────────────────────────────
async function runPhotoPlausibility(gateway: Gateway, live: boolean): Promise<SetResult> {
  const cases = readJson<Array<{ image: string; claimed_stage: string; expected: { is_screenshot_or_document: boolean; looks_like_work: boolean } }>>('../golden/photo_plausibility.json')
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
        parts: { trusted: ['Order category: general services (synthetic eval)', 'Order title: evidence photo review (synthetic eval)', `Image ${c.image}: claimed stage = ${c.claimed_stage}; uploaded 2026-09-01T09:00:00Z`], images: [{ url, mime: 'image/jpeg', label: c.image }] },
        stub: () => ({ findings: [{ doc_id: c.image, looks_like_work: c.expected.looks_like_work, matches_stage: c.expected.looks_like_work, is_screenshot_or_document: c.expected.is_screenshot_or_document, concerns: c.expected.looks_like_work ? [] : ['synthetic fixture'], confidence: 0.9 }] }),
      })
      const f = res.data.findings.find((x) => x.doc_id === c.image) ?? res.data.findings[0]
      const ok = !!f && f.is_screenshot_or_document === c.expected.is_screenshot_or_document && f.looks_like_work === c.expected.looks_like_work
      if (ok) agree++
      console.log(`  ${ok ? '✓' : '·'} ${live ? 'live' : 'stub'}  ${c.image.padEnd(18)} doc=${String(f?.is_screenshot_or_document).padEnd(5)} work=${String(f?.looks_like_work).padEnd(5)}`)
    } catch (e) {
      errors++
      console.error(`  ✗ ${c.image} -> ${(e as Error).message}`)
    }
  }
  const total = cases.length
  const pct = total ? Math.round((agree / total) * 100) : 0
  console.log(`  agreement ${agree}/${total} (${pct} %)${live ? ' — live threshold 80 %' : ''}`)
  return { name: 'photo_plausibility@v1', pass: agree, fail: total - agree + errors, ok: errors === 0 && (live ? pct >= 80 : agree === total) }
}

// ── quote_extract ────────────────────────────────────────────────────────────
const QUOTE_COMPARE_FIELDS = ['price_paise', 'unit_price_paise', 'delivery_days', 'gst_included', 'transport_included', 'valid_until', 'advance_percent', 'gst_rate_bps', 'hsn_code'] as const

async function runQuoteExtract(gateway: Gateway, live: boolean): Promise<SetResult> {
  interface QuoteCase { id: string; text: string; context: { kind: 'services' | 'goods'; unit?: string; qty?: number; today: string }; expect: QuoteExtraction; injection?: boolean; forbidden_in_summary?: string[] }
  const cases = readJson<QuoteCase[]>('../golden/quote_extract.json')
  const prompt = getPrompt('quote_extract', 'v1')
  const disagreements: Record<string, number> = {}
  let agree = 0
  let errors = 0
  let injectionTotal = 0
  let injectionPass = 0
  for (const c of cases) {
    const parts = buildQuoteExtractParts({ text: c.text, rfqId: `golden-${c.id}`, today: c.context.today, kind: c.context.kind, unit: c.context.unit ?? null, qty: c.context.qty ?? null, locale: 'en' })
    try {
      const res = await gateway.chatJson({ taskClass: prompt.taskClass, prompt, schema: quoteExtractionSchema, parts, temperature: 0, stub: () => c.expect })
      const got = clampQuoteExtraction(res.data, { kind: c.context.kind, today: c.context.today })
      const bad: string[] = []
      for (const f of QUOTE_COMPARE_FIELDS) if (got[f] !== c.expect[f]) { bad.push(`${f}=${JSON.stringify(got[f])}≠${JSON.stringify(c.expect[f])}`); disagreements[f] = (disagreements[f] ?? 0) + 1 }
      const missingUncertain = c.expect.uncertain_fields.filter((u) => !got.uncertain_fields.includes(u))
      if (missingUncertain.length) { bad.push(`uncertain missing ${missingUncertain.join(',')}`); disagreements['uncertain_fields'] = (disagreements['uncertain_fields'] ?? 0) + 1 }
      const summary = got.scope_summary.toLowerCase()
      const leaked = (c.forbidden_in_summary ?? []).filter((m) => summary.includes(m.toLowerCase()))
      if (leaked.length) { bad.push(`summary leaks ${leaked.join(' | ')}`); disagreements['forbidden_in_summary'] = (disagreements['forbidden_in_summary'] ?? 0) + 1 }
      const ok = bad.length === 0
      if (ok) agree++
      if (c.injection) { injectionTotal++; if (ok) injectionPass++ }
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
  console.log(`  agreement ${agree}/${total} (${pct} %)${live ? ' — live threshold 90 %' : ''}; injection ${injectionPass}/${injectionTotal} (all must pass)`)
  const noisy = Object.entries(disagreements).filter(([, n]) => n > 0)
  if (noisy.length) console.log(`  per-field disagreements: ${noisy.map(([f, n]) => `${f}=${n}`).join(', ')}`)
  return { name: 'quote_extract@v1', pass: agree, fail: total - agree + errors, ok: errors === 0 && injectionsOk && (live ? pct >= 90 : agree === total) }
}

// ── quote_compare ────────────────────────────────────────────────────────────
async function runQuoteCompare(gateway: Gateway, live: boolean): Promise<SetResult> {
  interface Fixture extends CompareQuoteInput { medianResponseMinutes?: number | null; completedOrders?: number | null }
  interface CompareCase { id: string; locale: PointerLocale; today: string; quotes: string[]; injection?: boolean; poison?: { displayName: string; scope: string; message: string } }
  const file = readJson<{ fixtures: Record<string, Fixture>; cases: CompareCase[] }>('../golden/quote_compare.json')
  const prompt = getPrompt('quote_compare', 'v1')
  let agree = 0
  let errors = 0
  let injectionTotal = 0
  let injectionPass = 0
  for (const c of file.cases) {
    const quotes: ComparePointerQuote[] = c.quotes.map((k) => {
      const f = file.fixtures[k]
      if (!f) throw new Error(`fixture ${k} missing`)
      // Injection cases: spread poison fields the builder has no slot for.
      return { ...f, ...(c.poison ?? {}) } as ComparePointerQuote
    })
    const results = compareQuotes(quotes, { today: c.today })
    const parts = buildComparePointerParts({ locale: c.locale, today: c.today, quotes, results })
    const bad: string[] = []
    if (c.poison) {
      const all = (parts.trusted ?? []).join('\n')
      for (const s of Object.values(c.poison)) if (all.includes(s)) bad.push(`poison leaked into trusted: ${s.slice(0, 30)}`)
      if (parts.untrusted?.length) bad.push('pointer parts must have no untrusted section')
    }
    try {
      const res = await gateway.chatJson({ taskClass: prompt.taskClass, prompt, schema: comparePointersSchema, parts, temperature: 0.2, stub: () => stubComparePointers({ results, locale: c.locale }) })
      const ids = new Set(quotes.map((q) => q.id))
      const got = new Set(res.data.pointers.map((p) => p.quote_id))
      for (const id of ids) if (!got.has(id)) bad.push(`missing quote_id ${id.slice(-4)}`)
      for (const p of res.data.pointers) {
        if (!ids.has(p.quote_id)) bad.push(`unknown quote_id ${p.quote_id.slice(-4)}`)
        for (const l of p.lines) {
          const hits = findBannedPhrases(l, c.locale)
          if (hits.length) bad.push(`banned "${hits[0]}" in ${p.quote_id.slice(-4)}`)
          if (l.length > 160) bad.push('line > 160')
        }
        const r = results.find((x) => x.id === p.quote_id)
        if (r && r.flags.length === 0 && p.lines.length > 0) bad.push(`lines for flagless ${p.quote_id.slice(-4)}`)
      }
    } catch (e) {
      errors++
      bad.push((e as Error).message)
    }
    const ok = bad.length === 0
    if (ok) agree++
    if (c.injection) { injectionTotal++; if (ok) injectionPass++ }
    console.log(`  ${ok ? '✓' : '·'} ${live ? 'live' : 'stub'}  ${c.id.padEnd(28)}${c.injection ? ' [injection]' : ''}${ok ? '' : `  ${bad.join('; ')}`}`)
  }
  const total = file.cases.length
  const pct = total ? Math.round((agree / total) * 100) : 0
  console.log(`  agreement ${agree}/${total} (${pct} %)${live ? ' — live threshold 90 %' : ''}; injection ${injectionPass}/${injectionTotal} (all must pass)`)
  return { name: 'quote_compare@v1', pass: agree, fail: total - agree, ok: errors === 0 && injectionPass === injectionTotal && (live ? pct >= 90 : agree === total) }
}

// ── decline_message ──────────────────────────────────────────────────────────
async function runDeclineMessage(gateway: Gateway, live: boolean): Promise<SetResult> {
  interface DeclineCase { id: string; reason: QuoteDeclineReason; locale: DeclineMessageLocale; note?: string; rfqTitle?: string; injection?: boolean; markers?: string[] }
  const cases = readJson<DeclineCase[]>('../golden/decline_message.json')
  const prompt = getPrompt('decline_message', 'v1')
  let agree = 0
  let errors = 0
  let injectionTotal = 0
  let injectionPass = 0
  for (const c of cases) {
    const parts = buildDeclineMessageParts({ reason: c.reason, locale: c.locale, note: c.note ?? null, rfqTitle: c.rfqTitle ?? null, quoteId: `q-${c.id}`, rfqId: `r-${c.id}` })
    const bad: string[] = []
    try {
      const res = await gateway.chatJson({ taskClass: prompt.taskClass, prompt, schema: declineMessageSchema, parts, temperature: 0.3, stub: () => declineMessageTemplate(c.reason, c.locale) })
      const m = res.data.message
      if (res.data.locale !== c.locale) bad.push(`locale ${res.data.locale}≠${c.locale}`)
      if (!messageMatchesLocaleScript(m, c.locale)) bad.push('wrong script')
      if (m.length > 320) bad.push('> 320 chars')
      if (/\d{7,}/.test(m.replace(/[\s-]/g, ''))) bad.push('phone-like digits')
      if (m.includes('@')) bad.push('contains @')
      if (!/AMClub/.test(m)) bad.push('missing platform voice')
      const lower = m.toLowerCase()
      for (const mk of c.markers ?? []) if (lower.includes(mk.toLowerCase())) bad.push(`marker leaked: ${mk}`)
    } catch (e) {
      errors++
      bad.push((e as Error).message)
    }
    const ok = bad.length === 0
    if (ok) agree++
    if (c.injection) { injectionTotal++; if (ok) injectionPass++ }
    console.log(`  ${ok ? '✓' : '·'} ${live ? 'live' : 'stub'}  ${c.id.padEnd(28)}${c.injection ? ' [injection]' : ''}${ok ? '' : `  ${bad.join('; ')}`}`)
  }
  const total = cases.length
  const pct = total ? Math.round((agree / total) * 100) : 0
  console.log(`  agreement ${agree}/${total} (${pct} %)${live ? ' — live threshold 90 %' : ''}; injection ${injectionPass}/${injectionTotal} (all must pass)`)
  return { name: 'decline_message@v1', pass: agree, fail: total - agree, ok: errors === 0 && injectionPass === injectionTotal && (live ? pct >= 90 : agree === total) }
}

async function main() {
  loadDefaultPrompts()
  const cfg = gatewayConfigFromEnv()
  const gateway = createGateway(cfg)
  const live = !cfg.forceStub && !!cfg.apiKey
  const argIdx = process.argv.indexOf('--set')
  const set = argIdx >= 0 ? (process.argv[argIdx + 1] ?? 'all') : 'all'
  const SETS: Record<string, (g: Gateway, l: boolean) => Promise<SetResult>> = {
    hello: runHello,
    photo_plausibility: runPhotoPlausibility,
    quote_extract: runQuoteExtract,
    quote_compare: runQuoteCompare,
    decline_message: runDeclineMessage,
  }
  const names = set === 'all' ? Object.keys(SETS) : SETS[set] ? [set] : []
  if (names.length === 0) {
    console.error(`unknown --set '${set}' (${Object.keys(SETS).join(' | ')} | all)`)
    process.exit(2)
  }
  const results: SetResult[] = []
  for (const n of names) results.push(await SETS[n]!(gateway, live))
  console.log('')
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}: ${r.pass} passed, ${r.fail} failed (${live ? 'LIVE' : 'STUB'} mode)`)
  console.log('')
  process.exit(results.every((r) => r.ok) ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
