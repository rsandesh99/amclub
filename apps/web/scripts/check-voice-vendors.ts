/**
 * Voice-vendor smoke check (2026-07-08 incident follow-up) — "are Sarvam and
 * OpenRouter actually working with the configured keys?" as a one-command
 * answer, like check-otp-sms.ts is for SMS.
 *
 *   npx tsx scripts/check-voice-vendors.ts            # 2s clip + tiny parse
 *   npx tsx scripts/check-voice-vendors.ts --long     # also probe a 35s clip
 *                                                     # (REST-tier length limit)
 *
 * Reads SARVAM_API_KEY / OPENROUTER_API_KEY / VOICE_PARSE_MODEL from the
 * environment or .env.local. Keys live in Vercel? Run `vercel env pull` first,
 * or paste them inline:  SARVAM_API_KEY=... npx tsx scripts/check-voice-vendors.ts
 *
 * The Sarvam clip is generated silence (16 kHz mono WAV) — it proves auth,
 * endpoint, content-type, and length acceptance; expect an EMPTY transcript.
 * Costs: one STT call ≤35s + one ~20-token LLM call.
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })

const SARVAM_KEY = process.env['SARVAM_API_KEY']
const OPENROUTER_KEY = process.env['OPENROUTER_API_KEY']
const MODEL = process.env['VOICE_PARSE_MODEL'] || 'google/gemini-2.5-flash-lite'
const LONG = process.argv.includes('--long')

/** Minimal 16 kHz mono 16-bit PCM WAV of silence. */
function silenceWav(seconds: number): Buffer {
  const rate = 16_000
  const samples = rate * seconds
  const buf = Buffer.alloc(44 + samples * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + samples * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(samples * 2, 40)
  return buf
}

async function checkSarvam(seconds: number): Promise<boolean> {
  const label = `Sarvam STT (${seconds}s wav)`
  if (!SARVAM_KEY) {
    console.log(`⊘ ${label}: SKIPPED — SARVAM_API_KEY not set (vercel env pull, or paste inline)`)
    return false
  }
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(silenceWav(seconds))], { type: 'audio/wav' }), 'check.wav')
  form.append('model', 'saaras:v3')
  form.append('mode', 'translate')
  const started = Date.now()
  try {
    const res = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST',
      headers: { 'api-subscription-key': SARVAM_KEY },
      body: form,
    })
    const body = await res.text()
    if (res.ok) {
      const d = JSON.parse(body) as { transcript?: string; request_id?: string }
      console.log(
        `✓ ${label}: 200 in ${Date.now() - started}ms — transcript "${d.transcript ?? ''}" (silence ⇒ empty is correct), request_id=${d.request_id}`,
      )
      return true
    }
    console.log(`✗ ${label}: HTTP ${res.status} in ${Date.now() - started}ms`)
    console.log(`  body: ${body.slice(0, 600)}`)
    if (res.status === 401 || res.status === 403) console.log('  → key invalid/inactive?')
    if (res.status === 402 || res.status === 429) console.log('  → credits/quota exhausted?')
    return false
  } catch (e) {
    console.log(`✗ ${label}: network — ${(e as Error).message}`)
    return false
  }
}

async function checkOpenRouter(): Promise<boolean> {
  const label = `OpenRouter parse (${MODEL})`
  if (!OPENROUTER_KEY) {
    console.log(`⊘ ${label}: SKIPPED — OPENROUTER_API_KEY not set`)
    return false
  }
  const started = Date.now()
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 20,
        usage: { include: true },
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: 'Return exactly this JSON: {"ok": true}' }],
      }),
    })
    const body = await res.text()
    if (res.ok) {
      const d = JSON.parse(body) as { choices?: { message?: { content?: string } }[]; usage?: { cost?: number } }
      console.log(
        `✓ ${label}: 200 in ${Date.now() - started}ms — content ${JSON.stringify(d.choices?.[0]?.message?.content)} cost=$${d.usage?.cost ?? '?'}`,
      )
      return true
    }
    console.log(`✗ ${label}: HTTP ${res.status} in ${Date.now() - started}ms`)
    console.log(`  body: ${body.slice(0, 600)}`)
    if (res.status === 402) console.log('  → INSUFFICIENT PREPAID CREDITS — top up at openrouter.ai/credits')
    if (res.status === 429) console.log('  → rate/quota limited — retry shortly')
    if (res.status === 404) console.log(`  → model id "${MODEL}" not found — check VOICE_PARSE_MODEL`)
    return false
  } catch (e) {
    console.log(`✗ ${label}: network — ${(e as Error).message}`)
    return false
  }
}

async function main() {
  console.log(`\nVoice-vendor smoke check${LONG ? ' (+35s length probe)' : ''}\n`)
  const results = [await checkSarvam(2)]
  if (LONG) results.push(await checkSarvam(35))
  results.push(await checkOpenRouter())
  const ok = results.every(Boolean)
  console.log(ok ? '\nAll checked vendors OK.\n' : '\nAt least one vendor failed or was skipped — see above.\n')
  process.exit(ok ? 0 : 1)
}

main()
