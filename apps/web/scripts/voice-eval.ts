/**
 * E14 FR-14.5 — the per-language voice search eval.
 *
 *   pnpm --filter @amclub/web voice:eval -- --lang te --set evals/voice/te.jsonl --token <buyer access token> [--base http://localhost:3000] [--record]
 *
 * The set is JSON lines, one real spoken query each (F6's search_queries sample
 * is the source of the texts people actually say; a native speaker records
 * them):
 *   {"audio": "te/001.webm", "duration_ms": 3200, "reference": "gst registration for my shop", "category": "company-registrations"}
 * `audio` is relative to the set file; `reference` is the English the
 * pipeline should produce (it transcribes to English); `category` is the
 * category a correct parse lands on (optional per line).
 *
 * Each clip goes through the app's own route twice, as a signed-in buyer:
 * `transcript_only` (the STT the mic uses → WER against the reference) and the
 * full parse (→ category). Shared `summariseVoiceEval` aggregates; the pass
 * bar is shared `voiceEvalPasses` (≥ 50 queries, WER ≤ 20 %, category ≥ 85 %).
 * With `--record` (needs SUPABASE_SERVICE_ROLE_KEY for that environment) the
 * result lands in agent_settings.voice_language_evals[lang] — pass or fail, so a
 * failing re-run switches a language back off. The route's rate limits apply:
 * `--delay-ms` spaces the calls.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import {
  VOICE_EVAL_MAX_WER,
  VOICE_EVAL_MIN_CATEGORY_ACCURACY,
  VOICE_EVAL_MIN_QUERIES,
  summariseVoiceEval,
  voiceBaseLanguage,
  voiceEvalPasses,
  voiceLanguageEvalsSchema,
} from '@amclub/shared'

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const lang = voiceBaseLanguage(arg('lang'))
const setPath = arg('set')
const token = arg('token') ?? process.env['VOICE_EVAL_TOKEN']
const base = (arg('base') ?? process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000').replace(/\/$/, '')
const delayMs = Number(arg('delay-ms') ?? 1500)
const record = process.argv.includes('--record')
if (!lang || !setPath || !token) {
  console.error('usage: voice:eval -- --lang <en|hi|te|ta|kn|mr|bn|gu|ml> --set <file.jsonl> --token <buyer access token> [--base <url>] [--delay-ms 1500] [--record]')
  process.exit(2)
}

type Line = { audio: string; duration_ms: number; reference: string; category?: string }
const lines = readFileSync(setPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as Line)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function call(line: Line, transcriptOnly: boolean): Promise<Record<string, unknown>> {
  const bytes = readFileSync(join(dirname(setPath!), line.audio))
  const fd = new FormData()
  fd.append('audio', new Blob([bytes], { type: line.audio.endsWith('.wav') ? 'audio/wav' : line.audio.endsWith('.mp3') ? 'audio/mpeg' : 'audio/webm' }), line.audio)
  fd.append('duration_ms', String(line.duration_ms))
  if (transcriptOnly) fd.append('transcript_only', 'true')
  const res = await fetch(`${base}/api/v1/rfq/voice-parse`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new Error(`${line.audio}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  return body
}

async function main() {
  const cases: Parameters<typeof summariseVoiceEval>[0] = []
  let stub = false
  for (const line of lines) {
    const t = await call(line, true)
    stub ||= t['stub'] === true
    await sleep(delayMs)
    const p = line.category ? await call(line, false) : null
    if (p) await sleep(delayMs)
    const parse = (p?.['parse'] ?? null) as { category_slug?: string | null } | null
    cases.push({ reference: line.reference, hypothesis: String(t['transcript_english'] ?? ''), expectedCategory: line.category ?? null, gotCategory: parse?.category_slug ?? null })
    process.stdout.write('.')
  }
  const result = summariseVoiceEval(cases, new Date(), setPath)
  const passed = voiceEvalPasses(result)
  console.log(`\n${lang}: n ${result.n} (need ≥ ${VOICE_EVAL_MIN_QUERIES}) · WER ${(result.wer * 100).toFixed(1)} % (≤ ${VOICE_EVAL_MAX_WER * 100} %) · category ${(result.categoryAccuracy * 100).toFixed(1)} % (≥ ${VOICE_EVAL_MIN_CATEGORY_ACCURACY * 100} %) → ${passed ? 'PASS' : 'FAIL'}`)
  if (stub) {
    console.error('The STT answered from its keyless stub — nothing measured; not recorded.')
    process.exit(1)
  }
  if (record) {
    const url = process.env['NEXT_PUBLIC_SUPABASE_URL']
    const key = process.env['SUPABASE_SERVICE_ROLE_KEY']
    if (!url || !key) throw new Error('--record needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY')
    const admin = createClient(url, key, { auth: { persistSession: false } })
    const { data } = await admin.from('agent_settings').select('value').eq('key', 'voice_language_evals').maybeSingle()
    const current = voiceLanguageEvalsSchema.safeParse(data?.value ?? {})
    const next = { ...(current.success ? current.data : {}), [lang!]: result }
    const { error } = await admin.from('agent_settings').upsert({ key: 'voice_language_evals', value: next, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    if (error) throw new Error(error.message)
    console.log(`recorded agent_settings.voice_language_evals.${lang} (${passed ? 'the language may now be listed' : 'the language stays off'})`)
  }
  process.exit(passed ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
