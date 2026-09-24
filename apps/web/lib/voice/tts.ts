import 'server-only'
import { VendorHttpError } from './types'
import { OUTBOUND_TIMEOUT_MS } from '@/lib/outbound'

/**
 * S1.8 — text → speech for the ONE clarifying question (task class
 * text_to_speech, live tier). Sarvam bulbul when SARVAM_API_KEY is set; a
 * visible stub otherwise (no paid call, `audioBase64: null`, the client shows
 * the question as text). At most one synthesis per clip, only when
 * agent_settings.clarify_tts_enabled is true. Audio is returned inline as a
 * data URL (≤ 400 KB) and never stored.
 */

const SARVAM_TTS_URL = 'https://api.sarvam.ai/text-to-speech'
const MODEL = 'bulbul:v2'
const SPEAKER = 'anushka'

export interface SynthesisResult {
  /** Base64 audio (wav) or null in stub mode. */
  audioBase64: string | null
  mime: string
  vendor: string
  stub: boolean
  requestId?: string | null | undefined
}

export interface Synthesizer {
  synthesize(text: string, languageCode: string): Promise<SynthesisResult>
}

class SarvamSynthesizer implements Synthesizer {
  constructor(private readonly apiKey: string) {}

  async synthesize(text: string, languageCode: string): Promise<SynthesisResult> {
    const res = await fetch(SARVAM_TTS_URL, {
      method: 'POST',
      headers: { 'api-subscription-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 500), target_language_code: languageCode, speaker: SPEAKER, model: MODEL, speech_sample_rate: 16000 }),
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS.tts), // audit M37; the caller logs it and sends the question as text
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new VendorHttpError('sarvam-tts', res.status, body)
    }
    const d = (await res.json()) as { request_id?: string; audios?: string[] }
    const audio = d.audios?.[0] ?? null
    return { audioBase64: audio, mime: 'audio/wav', vendor: `sarvam:${MODEL}`, stub: false, requestId: d.request_id ?? null }
  }
}

class StubSynthesizer implements Synthesizer {
  async synthesize(text: string, languageCode: string): Promise<SynthesisResult> {
    console.warn(`[voice:tts STUB] would synthesise ${languageCode} via ${MODEL} → "${text.slice(0, 60)}…" (no SARVAM_API_KEY)`)
    return { audioBase64: null, mime: 'audio/wav', vendor: 'stub', stub: true }
  }
}

export function getSynthesizer(): Synthesizer {
  const key = process.env['SARVAM_API_KEY']
  if (!key) return new StubSynthesizer()
  return new SarvamSynthesizer(key)
}

export function synthesizerVendorTag(): string {
  return process.env['SARVAM_API_KEY'] ? `sarvam:${MODEL}` : 'stub'
}

/** BCP-47 code for the four question languages. */
export function ttsLanguageCode(locale: 'en' | 'hi' | 'te' | 'ta'): string {
  return `${locale}-IN`
}
