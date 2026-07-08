import type { VoiceParse } from '@amclub/shared'

/**
 * A vendor HTTP failure with the status and FULL response body preserved —
 * ai_invocations must capture what the vendor actually said (the 2026-07-08
 * Sarvam diagnosis lost the tail of the allowed-format list to a 500-char
 * error slice; never again).
 */
export class VendorHttpError extends Error {
  constructor(
    vendor: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`${vendor} ${status}: ${body.slice(0, 200)}`)
    this.name = 'VendorHttpError'
  }
}

/** User-facing failure cause, classified from the vendor status. */
export type VendorFailureCause = 'quota' | 'busy' | 'error'

export function classifyVendorFailure(e: unknown): VendorFailureCause {
  if (e instanceof VendorHttpError) {
    if (e.status === 402 || e.status === 403) return 'quota'
    if (e.status === 429 || e.status >= 500) return 'busy'
  }
  return 'error'
}

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
