import 'server-only'
import { VendorHttpError } from './types'
import type { Transcriber, TranscriptionResult, VoiceAudio } from './types'

/**
 * Sarvam AI speech-to-text-translate (Phase 8b). One REST call transcribes
 * Indic (incl. code-mixed) speech AND translates it to English:
 * POST https://api.sarvam.ai/speech-to-text with model=saaras:v3 mode=translate.
 * Auth header: api-subscription-key. Response: { transcript, language_code }.
 *
 * STUB when SARVAM_API_KEY is unset — logs "would transcribe", makes NO paid
 * call, and returns a fixed sample transcript so the whole flow stays
 * exercisable keyless (flagged stub:true all the way to the client).
 */

const SARVAM_URL = 'https://api.sarvam.ai/speech-to-text'
const MODEL = 'saaras:v3'

const STUB_TRANSCRIPT =
  'I run a small garments shop in Guntur and I need help with GST registration and monthly GST filing.'

class SarvamTranscriber implements Transcriber {
  constructor(private readonly apiKey: string) {}

  async transcribeToEnglish(audio: VoiceAudio): Promise<TranscriptionResult> {
    const form = new FormData()
    form.append('file', new Blob([audio.bytes], { type: audio.mimeType }), audio.filename)
    form.append('model', MODEL)
    form.append('mode', 'translate')

    const res = await fetch(SARVAM_URL, {
      method: 'POST',
      headers: { 'api-subscription-key': this.apiKey },
      body: form,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new VendorHttpError('sarvam', res.status, body)
    }
    const d = (await res.json()) as {
      request_id?: string
      transcript?: string
      language_code?: string | null
    }
    return {
      transcript: (d.transcript ?? '').trim(),
      languageCode: d.language_code ?? 'unknown',
      vendor: `sarvam:${MODEL}`,
      stub: false,
      requestId: d.request_id ?? null,
    }
  }
}

class StubTranscriber implements Transcriber {
  async transcribeToEnglish(audio: VoiceAudio): Promise<TranscriptionResult> {
    console.warn(
      `[voice:stt STUB] would transcribe → ${audio.filename} (${audio.mimeType}, ${audio.bytes.byteLength} bytes) via ${MODEL} (no SARVAM_API_KEY)`,
    )
    // VOICE_STUB_TRANSCRIPT: verify rigs steer the keyless stub (never read when a key is set).
    return { transcript: process.env['VOICE_STUB_TRANSCRIPT'] || STUB_TRANSCRIPT, languageCode: process.env['VOICE_STUB_LANGUAGE'] || 'te-IN', vendor: 'stub', stub: true }
  }
}

export function getTranscriber(): Transcriber {
  const key = process.env['SARVAM_API_KEY']
  return key ? new SarvamTranscriber(key) : new StubTranscriber()
}

/** Vendor tag for telemetry when the call itself failed (no result object). */
export function transcriberVendorTag(): string {
  return process.env['SARVAM_API_KEY'] ? `sarvam:${MODEL}` : 'stub'
}
