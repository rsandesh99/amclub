'use client'

import { useCallback, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useAnalytics } from '@/components/providers/posthog'
import type { VoiceParseResponse } from '@amclub/shared'
import { VoiceRfqRecorder } from '@/components/voice/VoiceRfqRecorder'

/**
 * Catalog dictation (FRONTEND.md §7 "photos + voice"): wraps the Voice-RFQ
 * recorder in transcript-only mode — one paid STT call, no LLM parse — and
 * hands the English text to the caller, which appends it to a text box.
 * Every path that yields text (transcript-only reply, a full parse, or a
 * parse failure that kept the transcript) ends in `onText`. S1.1 reuses it in
 * the quote composer with `surface="quote_composer"` (analytics only; the STT
 * path is unchanged — never a second one).
 */
export function VoiceDictation({ onText, surface = 'mart_catalog' }: { onText: (text: string) => void; surface?: 'mart_catalog' | 'quote_composer' | 'rfq_quality' }) {
  const t = useTranslations('mart')
  const locale = useLocale()
  const posthog = useAnalytics()
  const [done, setDone] = useState(false)

  const track = useCallback(
    (event: string, props?: Record<string, unknown>) =>
      posthog.capture(event, { locale, device: 'web', ...props, surface }),
    [posthog, locale, surface],
  )

  const deliver = useCallback(
    (text: string, durationMs: number, stub: boolean) => {
      const clean = text.trim()
      if (!clean) return
      onText(clean)
      setDone(true)
      track('mart_catalog_dictated', { chars: clean.length, duration_ms: durationMs, stub })
    },
    [onText, track],
  )

  return (
    <div className="space-y-2">
      <VoiceRfqRecorder
        transcriptOnly
        track={track}
        onTranscriptOnly={(transcript, durationMs) => deliver(transcript, durationMs, false)}
        onParsed={(res: VoiceParseResponse, durationMs) =>
          deliver(res.transcript_english || res.parse.description_english, durationMs, res.stub)
        }
      />
      {done && (
        <p className="text-xs font-medium text-emerald" role="status" aria-live="polite">
          ✓ {t('dictate_done')}
        </p>
      )}
    </div>
  )
}
