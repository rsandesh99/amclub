import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import type { VoiceParseResponse } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { getTranscriber, getParser } from '@/lib/voice'
import { VendorHttpError, classifyVendorFailure } from '@/lib/voice/types'
import { transcriberVendorTag } from '@/lib/voice/sarvam'
import { parserVendorTag } from '@/lib/voice/parser'
import {
  estimateParseCostPaise,
  estimateSttCostPaise,
  logAiInvocation,
} from '@/lib/voice/invocations'

/**
 * Phase 8b — voice → structured RFQ prefill. Auth required and tightly
 * rate-limited: every call is a PAID Sarvam STT call + one LLM call. This
 * endpoint only TRANSCRIBES AND PARSES — it never creates an RFQ; the client
 * shows the result as an editable form and submits via the normal /api/v1/rfq.
 *
 * multipart/form-data: `audio` (file, ≤3MB, ≤60s) + `duration_ms` (client-
 * measured; the byte cap backstops a lying client — 60s of voice-grade
 * compressed audio is far under 3MB).
 */

export const maxDuration = 60

const MAX_AUDIO_BYTES = 3 * 1024 * 1024
const MAX_DURATION_MS = 60_000
const ALLOWED_MIME = /^audio\/(webm|ogg|opus|mp4|m4a|x-m4a|aac|mpeg|mp3|wav|x-wav|3gpp)(;.*)?$/i

export async function POST(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Paid-API guard: per-user burst + hourly budget.
  const burst = await enforce(limiters.voiceParse, `vp:${userId}`)
  if (!burst.ok) return tooManyRequests(burst.retryAfter)
  const hourly = await enforce(limiters.voiceParseHourly, `vph:${userId}`)
  if (!hourly.ok) return tooManyRequests(hourly.retryAfter)

  // Reject oversized bodies before buffering the form.
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > MAX_AUDIO_BYTES + 64 * 1024) {
    return NextResponse.json({ error: 'audio_too_large' }, { status: 413 })
  }

  const form = await request.formData().catch(() => null)
  const audio = form?.get('audio')
  if (!form || !(audio instanceof File)) {
    return NextResponse.json({ error: 'audio_required' }, { status: 422 })
  }
  if (audio.size === 0) return NextResponse.json({ error: 'audio_required' }, { status: 422 })
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: 'audio_too_large' }, { status: 413 })
  }
  if (audio.type && !ALLOWED_MIME.test(audio.type)) {
    return NextResponse.json({ error: 'audio_format_unsupported' }, { status: 422 })
  }
  const durationMs = Number(form.get('duration_ms'))
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_DURATION_MS) {
    return NextResponse.json({ error: 'audio_too_long', max_ms: MAX_DURATION_MS }, { status: 422 })
  }

  // Every model call writes an ai_invocations row (cost/latency/status —
  // §Phase 8b v1.1). Service-role client; the table has RLS with no policies.
  const admin = await createAdminClient()

  let transcript: string
  let languageCode: string
  let sttVendor: string
  let sttStub: boolean
  const sttStart = Date.now()
  try {
    const t = await getTranscriber().transcribeToEnglish({
      bytes: await audio.arrayBuffer(),
      mimeType: audio.type || 'audio/webm',
      filename: audio.name || 'recording.webm',
    })
    ;({ transcript, languageCode, vendor: sttVendor, stub: sttStub } = t)
    await logAiInvocation(admin, {
      userId,
      step: 'stt',
      vendor: sttVendor,
      status: sttStub ? 'stub' : 'ok',
      latencyMs: Date.now() - sttStart,
      costEstPaise: estimateSttCostPaise(durationMs, sttStub),
      inputBytes: audio.size,
      outputChars: transcript.length,
      requestId: t.requestId,
      meta: { duration_ms: durationMs, language_code: languageCode, mime: audio.type },
    })
  } catch (e) {
    console.error('[voice-parse stt]', e)
    await logAiInvocation(admin, {
      userId,
      step: 'stt',
      vendor: transcriberVendorTag(),
      status: 'error',
      latencyMs: Date.now() - sttStart,
      costEstPaise: null,
      inputBytes: audio.size,
      error: e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500),
      // Full vendor response — the 500-char error slice truncated the Sarvam
      // allowed-format list during the 2026-07-08 diagnosis. Never lose it.
      ...(e instanceof VendorHttpError
        ? { meta: { vendor_status: e.status, vendor_body: e.body.slice(0, 4000), mime: audio.type } }
        : { meta: { mime: audio.type } }),
    })
    // `cause` lets the client show honest copy: quota vs busy vs plain failure.
    return NextResponse.json(
      { error: 'transcription_failed', cause: classifyVendorFailure(e) },
      { status: 502 },
    )
  }
  if (!transcript) return NextResponse.json({ error: 'transcription_empty' }, { status: 422 })

  const parseStart = Date.now()
  try {
    const pr = await getParser().parse(transcript, languageCode)
    await logAiInvocation(admin, {
      userId,
      step: 'parse',
      vendor: pr.vendor,
      status: pr.stub ? 'stub' : 'ok',
      latencyMs: Date.now() - parseStart,
      costEstPaise: estimateParseCostPaise(pr.usage, pr.stub),
      inputBytes: transcript.length,
      outputChars: JSON.stringify(pr.parse).length,
      requestId: pr.requestId,
      ...(pr.usage ? { meta: { usage: pr.usage } } : {}),
    })
    const body: VoiceParseResponse & { vendor: { stt: string; parser: string } } = {
      transcript_english: transcript,
      parse: pr.parse,
      stub: sttStub || pr.stub,
      // Echoed back so the client can persist it inside rfqs.voice_meta.
      vendor: { stt: sttVendor, parser: pr.vendor },
    }
    return NextResponse.json(body)
  } catch (e) {
    console.error('[voice-parse llm]', e)
    await logAiInvocation(admin, {
      userId,
      step: 'parse',
      vendor: parserVendorTag(),
      status: 'error',
      latencyMs: Date.now() - parseStart,
      costEstPaise: null,
      inputBytes: transcript.length,
      error: e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500),
      ...(e instanceof VendorHttpError
        ? { meta: { vendor_status: e.status, vendor_body: e.body.slice(0, 4000) } }
        : {}),
    })
    // The transcript is still useful — let the client fall back to manual
    // entry with the text pre-filled rather than dead-ending.
    return NextResponse.json(
      { error: 'parse_failed', cause: classifyVendorFailure(e), transcript_english: transcript },
      { status: 502 },
    )
  }
}
