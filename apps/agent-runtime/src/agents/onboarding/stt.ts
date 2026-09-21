import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Voice answers (S1.6) use the EXISTING web STT route,
 * `POST /api/v1/rfq/voice-parse` with `transcript_only=true`, called by
 * scripted code under the provider's delegated token (Bearer is accepted by
 * getAuthedSupabase). It is not a model-proposed tool. The route rate-limits
 * (3/min, 15/h) and logs `ai_invocations` itself. Moving Sarvam into
 * agent-core is S1.8; until then no TTS exists (questions are text).
 *
 * `duration_ms` is a nominal declared value: WhatsApp does not report voice
 * note length, and the route's byte cap (≤ 3 MB) backstops it (FOLLOWUPS S1.6).
 */

export const STT_NOMINAL_DURATION_MS = 20_000
const MAX_BYTES = 3 * 1024 * 1024

export interface TranscribeArgs {
  admin: SupabaseClient
  bucket: string
  mediaRef: string
  mime: string | null
  apiUrl: string
  token: string
  fetchImpl?: typeof fetch
}

export type TranscribeResult = { ok: true; text: string; vendor: string; stub: boolean } | { ok: false; reason: string }

export async function transcribeVoiceNote(args: TranscribeArgs): Promise<TranscribeResult> {
  const f = args.fetchImpl ?? fetch
  const { data, error } = await args.admin.storage.from(args.bucket).download(args.mediaRef)
  if (error || !data) return { ok: false, reason: `media_download_failed:${error?.message ?? 'empty'}` }
  const bytes = await data.arrayBuffer()
  if (bytes.byteLength === 0) return { ok: false, reason: 'media_empty' }
  if (bytes.byteLength > MAX_BYTES) return { ok: false, reason: 'media_too_large' }
  const mime = (args.mime ?? 'audio/ogg').split(';')[0]!.trim()
  const ext = mime.includes('mpeg') || mime.includes('mp3') ? 'mp3' : mime.includes('wav') ? 'wav' : mime.includes('aac') || mime.includes('m4a') || mime.includes('mp4') ? 'm4a' : 'ogg'
  const form = new FormData()
  form.append('audio', new Blob([bytes], { type: mime }), `voice-note.${ext}`)
  form.append('duration_ms', String(STT_NOMINAL_DURATION_MS))
  form.append('transcript_only', 'true')
  let res: Response
  try {
    res = await f(`${args.apiUrl}/api/v1/rfq/voice-parse`, { method: 'POST', headers: { Authorization: `Bearer ${args.token}` }, body: form })
  } catch (e) {
    return { ok: false, reason: `network:${(e as Error).message}` }
  }
  const body = (await res.json().catch(() => null)) as { transcript_english?: string; original_language?: string; stub?: boolean; error?: string } | null
  if (!res.ok || !body?.transcript_english) return { ok: false, reason: `http_${res.status}:${body?.error ?? ''}` }
  return { ok: true, text: body.transcript_english, vendor: body.stub ? 'stub' : 'sarvam', stub: body.stub === true }
}
