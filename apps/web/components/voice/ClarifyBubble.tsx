'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Play, Mic, Keyboard, SkipForward } from 'lucide-react'
import type { ClarifyQuestion, VoiceParsePrior, VoiceParseResponse } from '@amclub/shared'
import { VoiceRfqRecorder, type VoiceVendorTag } from '@/components/voice/VoiceRfqRecorder'

/**
 * S1.8 — the ONE clarifying question. Shown once, after a round-one voice
 * parse whose reply carried `clarify`. The buyer plays it (when audio came
 * back), answers by voice (the same recorder posting `prior`), types instead
 * (`answer_text`, no STT), or skips (the first parse stands). Exactly one
 * round: the round-two reply never carries another question, and this bubble
 * unmounts once answered or skipped.
 */

export type ClarifyPayload = ClarifyQuestion & { audio_data_url: string | null; extraction_id: string }

export interface ClarifyBubbleProps {
  clarify: ClarifyPayload
  /** The first round (transcript + parse); the question is taken from `clarify`. */
  prior: Omit<VoiceParsePrior, 'question' | 'answer_text'>
  onAnswered: (res: VoiceParseResponse & { vendor: VoiceVendorTag }, by: 'voice' | 'text', answerTranscript: string) => void
  onSkip: () => void
  track: (event: string, props?: Record<string, unknown>) => void
}

export function ClarifyBubble({ clarify, prior, onAnswered, onSkip, track }: ClarifyBubbleProps) {
  const tv = useTranslations('voice')
  const [mode, setMode] = useState<'idle' | 'voice' | 'text'>('idle')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const priorPayload: VoiceParsePrior = { transcript_english: prior.transcript_english, parse: prior.parse, question: { question: clarify.question, gap: clarify.gap, locale: clarify.locale } }

  useEffect(() => {
    track('voice_rfq_clarify_shown', { gap: clarify.gap, tts: clarify.audio_data_url !== null, locale: clarify.locale })
    // Shown once per question id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clarify.extraction_id])

  async function sendText() {
    const answer = text.trim()
    if (answer.length < 2) return
    setSending(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('prior', JSON.stringify({ ...priorPayload, answer_text: answer }))
      form.append('answer_text', answer)
      const res = await fetch('/api/v1/rfq/voice-parse', { method: 'POST', body: form })
      const d = (await res.json().catch(() => ({}))) as VoiceParseResponse & { vendor: VoiceVendorTag; error?: string }
      if (!res.ok) {
        setError(res.status === 429 ? tv('err_rate_limited') : tv('err_transcribe'))
        return
      }
      track('voice_rfq_clarify_answered', { by: 'text', gap: clarify.gap })
      onAnswered(d, 'text', answer)
    } catch {
      setError(tv('err_transcribe'))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="rounded-card border border-primary/30 bg-primary-soft/40 p-4" role="group" aria-label={tv('clarify_title')}>
      <p className="text-xs font-semibold uppercase tracking-wide text-primary">{tv('clarify_title')}</p>
      <p className="mt-1 text-base text-foreground" lang={clarify.locale}>{clarify.question}</p>
      {clarify.audio_data_url ? (
        <div className="mt-2 flex items-center gap-2">
          <audio ref={audioRef} src={clarify.audio_data_url} preload="none" />
          <button type="button" onClick={() => void audioRef.current?.play()} className="inline-flex min-h-11 items-center gap-1.5 rounded-button border border-border bg-surface px-3 text-sm">
            <Play className="h-4 w-4" aria-hidden />
            {tv('clarify_play')}
          </button>
        </div>
      ) : (
        <p className="mt-1 text-xs text-foreground-secondary">{tv('clarify_audio_unavailable')}</p>
      )}

      {mode === 'idle' && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => setMode('voice')} className="inline-flex min-h-11 items-center gap-1.5 rounded-button bg-primary px-4 text-sm font-semibold text-white">
            <Mic className="h-4 w-4" aria-hidden />
            {tv('clarify_answer_voice')}
          </button>
          <button type="button" onClick={() => setMode('text')} className="inline-flex min-h-11 items-center gap-1.5 rounded-button border border-border bg-surface px-4 text-sm">
            <Keyboard className="h-4 w-4" aria-hidden />
            {tv('clarify_type_instead')}
          </button>
          <button type="button" onClick={() => { track('voice_rfq_clarify_answered', { by: 'skipped', gap: clarify.gap }); onSkip() }} className="inline-flex min-h-11 items-center gap-1.5 rounded-button px-3 text-sm text-foreground-secondary underline underline-offset-2">
            <SkipForward className="h-4 w-4" aria-hidden />
            {tv('clarify_skip')}
          </button>
        </div>
      )}

      {mode === 'voice' && (
        <div className="mt-3">
          <VoiceRfqRecorder
            compact
            prior={priorPayload}
            track={track}
            onParsed={(res, _durationMs) => { track('voice_rfq_clarify_answered', { by: 'voice', gap: clarify.gap }); onAnswered(res, 'voice', res.transcript_english) }}
            onTranscriptOnly={(transcript) => { setMode('text'); setText(transcript) }}
          />
          <button type="button" onClick={() => setMode('idle')} className="mt-2 text-xs text-foreground-secondary underline underline-offset-2">{tv('re_record')}</button>
        </div>
      )}

      {mode === 'text' && (
        <div className="mt-3 flex flex-col gap-2">
          <input
            type="text"
            value={text}
            maxLength={1000}
            onChange={(e) => setText(e.target.value)}
            placeholder={tv('clarify_type_placeholder')}
            className="min-h-11 rounded-button border border-border bg-surface px-3 text-sm"
            aria-label={tv('clarify_type_placeholder')}
          />
          <div className="flex gap-2">
            <button type="button" disabled={sending || text.trim().length < 2} onClick={() => void sendText()} className="min-h-11 rounded-button bg-primary px-4 text-sm font-semibold text-white disabled:opacity-60">
              {sending ? tv('processing') : tv('clarify_send')}
            </button>
            <button type="button" onClick={() => setMode('idle')} className="min-h-11 px-3 text-sm text-foreground-secondary underline underline-offset-2">{tv('clarify_skip_back')}</button>
          </div>
          {error && <p className="text-xs text-danger" role="alert">{error}</p>}
        </div>
      )}
    </div>
  )
}
