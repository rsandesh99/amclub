import type { VoiceParse } from '@amclub/shared'

/**
 * Voice RFQ vendor interfaces (Phase 8b). Both vendors run server-only and
 * degrade to visible, free stubs when their key is unset — same contract as
 * the notification channels registry.
 */

export interface VoiceAudio {
  bytes: ArrayBuffer
  mimeType: string
  filename: string
}

export interface TranscriptionResult {
  /** English text (Sarvam saaras:v3 mode=translate — transcribe + translate in one call). */
  transcript: string
  /** BCP-47 source language from the vendor, e.g. 'te-IN'; 'unknown' if undetected. */
  languageCode: string
  /** Vendor tag persisted in voice_meta, e.g. 'sarvam:saaras:v3' | 'stub'. */
  vendor: string
  stub: boolean
  /** Vendor-side request id (ai_invocations.request_id). */
  requestId?: string | null | undefined
}

export interface Transcriber {
  transcribeToEnglish(audio: VoiceAudio): Promise<TranscriptionResult>
}

export interface ParseResult {
  parse: VoiceParse
  /** Vendor tag persisted in voice_meta, e.g. 'openrouter:<model>' | 'stub'. */
  vendor: string
  stub: boolean
  /** Vendor-side request id (ai_invocations.request_id). */
  requestId?: string | null | undefined
  /** Raw vendor usage (tokens + cost when returned) — ai_invocations.meta. */
  usage?: Record<string, unknown> | undefined
}

export interface RequirementParser {
  parse(englishText: string, originalLanguage: string): Promise<ParseResult>
}
