'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Mic, Square, RotateCcw, Loader2, Sparkles } from 'lucide-react'
import type { VoiceParseResponse } from '@amclub/shared'
import { startWavRecording, type WavRecorderHandle } from '@/lib/voice/wav-recorder'

/**
 * Phase 8b — mic capture for Voice RFQ (web). Web-Audio WAV capture → review
 * (playback + re-record) → POST /api/v1/rfq/voice-parse. WAV (not
 * MediaRecorder WebM) because Sarvam's REST API rejects WebM and WebM blobs
 * carry Chromium's infinite-duration metadata bug (2026-07-08 prod incident).
 * Never submits an RFQ; the parent receives the parse and pre-fills the
 * normal form. Every failure (mic denied, too long, rate-limited, vendor
 * quota/outage) resolves to an inline message — the manual form below stays
 * usable throughout.
 */

// Sarvam's REST tier hard-rejects clips >30s ("use the batch API") — proven
// with a real 47s clip against prod, 2026-07-08. Batch API is the upgrade
// path if 30s proves too short in the field.
export const MAX_RECORD_MS = 30_000

export interface VoiceVendorTag {
  stt: string
  parser: string
}

interface VoiceRfqRecorderProps {
  onParsed: (res: VoiceParseResponse & { vendor: VoiceVendorTag }, durationMs: number) => void
  /** Parse LLM failed but we have the transcript — prefill text-only. */
  onTranscriptOnly: (transcript: string, durationMs: number) => void
  track: (event: string, props?: Record<string, unknown>) => void
}

type Phase = 'idle' | 'recording' | 'review' | 'uploading'

export function VoiceRfqRecorder({ onParsed, onTranscriptOnly, track }: VoiceRfqRecorderProps) {
  const t = useTranslations('voice')

  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const recorderRef = useRef<WavRecorderHandle | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const stoppingRef = useRef(false)
  const blobRef = useRef<Blob | null>(null)
  const durationRef = useRef(0)
  const startedAtRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      streamRef.current?.getTracks().forEach((tr) => tr.stop())
      if (audioUrl) URL.revokeObjectURL(audioUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function start() {
    setError(null)
    if (typeof AudioContext === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError(t('err_unsupported'))
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setError(t('err_mic_denied'))
      track('voice_rfq_failed', { surface: 'rfq_form', reason: 'mic_denied' })
      return
    }
    try {
      recorderRef.current = await startWavRecording(stream)
    } catch {
      stream.getTracks().forEach((tr) => tr.stop())
      setError(t('err_unsupported'))
      return
    }
    streamRef.current = stream
    stoppingRef.current = false
    startedAtRef.current = Date.now()
    setElapsedMs(0)
    setPhase('recording')
    track('voice_rfq_started', { surface: 'rfq_form' })
    timerRef.current = setInterval(() => {
      const ms = Date.now() - startedAtRef.current
      setElapsedMs(ms)
      if (ms >= MAX_RECORD_MS) void stop()
    }, 200)
  }

  async function stop() {
    if (stoppingRef.current) return
    stoppingRef.current = true
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    const rec = recorderRef.current
    recorderRef.current = null
    streamRef.current?.getTracks().forEach((tr) => tr.stop())
    streamRef.current = null
    if (!rec) return
    try {
      // Duration comes from the ENCODED SAMPLE COUNT (and the wall-clock timer
      // caps recording) — never from blob metadata, so the Chromium
      // infinite-duration bug cannot reach the server-side 60s check.
      const { blob, durationMs } = await rec.stop()
      blobRef.current = blob
      durationRef.current = Math.min(durationMs, MAX_RECORD_MS)
      setAudioUrl((old) => {
        if (old) URL.revokeObjectURL(old)
        return URL.createObjectURL(blob)
      })
      setPhase('review')
    } catch {
      setError(t('err_unsupported'))
      setPhase('idle')
    }
  }

  function reRecord() {
    blobRef.current = null
    setAudioUrl((old) => {
      if (old) URL.revokeObjectURL(old)
      return null
    })
    void start()
  }

  async function send() {
    const blob = blobRef.current
    if (!blob) return
    setPhase('uploading')
    setError(null)
    try {
      const form = new FormData()
      form.append('audio', blob, 'recording.wav')
      form.append('duration_ms', String(Math.round(durationRef.current)))
      const res = await fetch('/api/v1/rfq/voice-parse', { method: 'POST', body: form })
      const d = await res.json().catch(() => ({}))

      if (res.ok) {
        track('voice_rfq_transcribed', {
          surface: 'rfq_form',
          original_language: d.parse?.original_language,
          duration_ms: Math.round(durationRef.current),
        })
        track('voice_rfq_parsed', {
          surface: 'rfq_form',
          original_language: d.parse?.original_language,
          uncertain: d.parse?.uncertain,
          stub: d.stub,
        })
        onParsed(d, Math.round(durationRef.current))
        setPhase('idle')
        return
      }

      if (res.status === 429) setError(t('err_rate_limited'))
      else if (d.error === 'audio_too_long') setError(t('err_too_long'))
      else if (d.error === 'audio_too_large') setError(t('err_too_large'))
      else if (d.error === 'transcription_empty') setError(t('err_no_speech'))
      else if (d.error === 'parse_failed' && d.transcript_english) {
        // Transcript survived — hand it over so the form is still pre-filled.
        onTranscriptOnly(d.transcript_english, Math.round(durationRef.current))
        setPhase('idle')
        track('voice_rfq_failed', {
          surface: 'rfq_form',
          reason: 'parse_failed_transcript_kept',
          cause: d.cause,
        })
        return
      } else if (d.cause === 'quota') setError(t('err_quota'))
      else if (d.cause === 'busy') setError(t('err_busy'))
      else if (d.error === 'transcription_failed') setError(t('err_stt'))
      else setError(t('err_transcribe'))
      track('voice_rfq_failed', {
        surface: 'rfq_form',
        reason: d.error ?? `http_${res.status}`,
        cause: d.cause,
      })
      setPhase('review')
    } catch {
      setError(t('err_transcribe'))
      track('voice_rfq_failed', { surface: 'rfq_form', reason: 'network' })
      setPhase('review')
    }
  }

  const seconds = Math.floor(elapsedMs / 1000)
  const remaining = Math.max(0, Math.ceil((MAX_RECORD_MS - elapsedMs) / 1000))

  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Sparkles className="h-4 w-4 text-primary" aria-hidden />
        {t('intro_title')}
      </div>
      <p className="mt-1 text-[13px] leading-[1.45] text-foreground-secondary">{t('intro_sub')}</p>
      {/* DPDP consent + no-retention fact (§Phase 8b v1.1) — shown before any recording. */}
      <p className="mt-1 text-[11.5px] leading-[1.45] text-foreground-secondary/80">{t('consent_note')}</p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {phase === 'idle' && (
          <button
            type="button"
            onClick={() => void start()}
            className="inline-flex min-h-11 items-center gap-2 rounded-button bg-primary px-5 py-2.5 text-base font-semibold text-white transition-colors hover:bg-primary-strong motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            <Mic className="h-5 w-5" aria-hidden />
            {t('record_cta')}
          </button>
        )}

        {phase === 'recording' && (
          <>
            <button
              type="button"
              onClick={() => void stop()}
              aria-label={t('stop_cta')}
              className="relative inline-flex h-14 w-14 items-center justify-center rounded-full bg-danger text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2"
            >
              <span
                className="absolute inset-0 rounded-full bg-danger/40 motion-safe:animate-ping"
                aria-hidden
              />
              <Square className="relative h-5 w-5 fill-current" aria-hidden />
            </button>
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-foreground" aria-live="polite">
                {t('recording')} · 0:{String(seconds).padStart(2, '0')}
              </span>
              <span className="text-xs text-foreground-secondary">
                {t('seconds_left', { s: remaining })}
              </span>
            </div>
          </>
        )}

        {phase === 'review' && audioUrl && (
          <div className="flex w-full flex-col gap-2.5">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption -- voice memo, no caption source */}
            <audio
              controls
              src={audioUrl}
              className="w-full"
              onLoadedMetadata={(e) => {
                // Defensive: WAV headers carry a real duration, but if a
                // browser still reports Infinity (Chromium blob bug), force it
                // to compute one by seeking past the end and snapping back.
                const el = e.currentTarget
                if (el.duration === Infinity) {
                  el.currentTime = 1e101
                  el.ontimeupdate = () => {
                    el.ontimeupdate = null
                    el.currentTime = 0
                  }
                }
              }}
            />
            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                onClick={() => void send()}
                className="inline-flex min-h-11 items-center gap-2 rounded-button bg-primary px-5 py-2.5 text-base font-semibold text-white transition-colors hover:bg-primary-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                {t('use_recording')}
              </button>
              <button
                type="button"
                onClick={reRecord}
                className="inline-flex min-h-11 items-center gap-2 rounded-button border border-border bg-surface px-4 py-2.5 text-base font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <RotateCcw className="h-4 w-4" aria-hidden />
                {t('re_record')}
              </button>
            </div>
          </div>
        )}

        {phase === 'uploading' && (
          <span className="inline-flex items-center gap-2 text-sm text-foreground-secondary" aria-live="polite">
            <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
            {t('processing')}
          </span>
        )}
      </div>

      {error && (
        <p className="mt-2.5 text-[13px] text-danger" role="alert">
          {error} {t('type_instead')}
        </p>
      )}
    </div>
  )
}
