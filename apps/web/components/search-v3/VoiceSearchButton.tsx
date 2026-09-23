'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Mic, Square, Loader2 } from 'lucide-react'
import { usePathname, useRouter } from '@/i18n/navigation'
import { useAnalytics } from '@/components/providers/posthog'
import { startWavRecording, type WavRecorderHandle } from '@/lib/voice/wav-recorder'
import { cn } from '@/lib/utils'

const MAX_MS = 15_000

/**
 * Experience v3 E2b FR-2.5 (N5) — speak a search. The Phase 8b pipeline in
 * mode=query: speech → an English query + the detected language (+ the
 * category / service the parser mapped). The same consent note as the voice
 * requirement; no audio is kept. Signed out → sign in, then back here.
 */
export function VoiceSearchButton({ action }: { action: string }) {
  const t = useTranslations('voice')
  const tv = useTranslations('filters_v3')
  const router = useRouter()
  const pathname = usePathname()
  const analytics = useAnalytics()
  const [phase, setPhase] = useState<'idle' | 'recording' | 'working'>('idle')
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<WavRecorderHandle | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
    stream.current?.getTracks().forEach((tr) => tr.stop())
  }, [])

  async function start() {
    setError(null)
    if (typeof AudioContext === 'undefined' || !navigator.mediaDevices?.getUserMedia) return setError(t('err_unsupported'))
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true })
      rec.current = await startWavRecording(stream.current)
    } catch {
      stream.current?.getTracks().forEach((tr) => tr.stop())
      analytics.capture('search_voice_used', { device: 'web', ok: false, lang: null })
      return setError(t('err_mic_denied'))
    }
    setPhase('recording')
    timer.current = setTimeout(() => void stop(), MAX_MS)
  }

  async function stop() {
    if (timer.current) clearTimeout(timer.current)
    const r = rec.current
    rec.current = null
    stream.current?.getTracks().forEach((tr) => tr.stop())
    if (!r) return
    setPhase('working')
    try {
      const { blob, durationMs } = await r.stop()
      const fd = new FormData()
      fd.append('audio', blob, 'search.wav')
      fd.append('duration_ms', String(Math.max(1, Math.min(durationMs, MAX_MS))))
      fd.append('mode', 'query')
      const res = await fetch('/api/v1/rfq/voice-parse', { method: 'POST', body: fd })
      if (res.status === 401) {
        router.push(`/login?next=${encodeURIComponent(pathname)}` as '/login')
        return
      }
      const d = (await res.json().catch(() => ({}))) as { query?: string; original_language?: string; category_slug?: string | null; service_slug?: string | null; error?: string }
      if (!res.ok || !d.query) {
        analytics.capture('search_voice_used', { device: 'web', ok: false, lang: null })
        setError(res.status === 429 ? t('err_rate_limited') : d.error === 'transcription_empty' ? t('err_no_speech') : t('err_transcribe'))
        setPhase('idle')
        return
      }
      analytics.capture('search_voice_used', { device: 'web', ok: true, lang: d.original_language ?? null })
      const qs = new URLSearchParams({ query: d.query })
      if (d.category_slug) qs.set('category', d.category_slug)
      if (d.category_slug && d.service_slug) qs.set('service', d.service_slug)
      qs.set('voice', '1')
      router.push(`${action}?${qs.toString()}` as '/services')
    } catch {
      setError(t('err_transcribe'))
      setPhase('idle')
    }
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => (phase === 'recording' ? void stop() : phase === 'idle' ? void start() : undefined)}
        aria-label={phase === 'recording' ? t('stop_cta') : tv('voice_search')}
        aria-pressed={phase === 'recording'}
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-full transition-colors',
          phase === 'recording' ? 'bg-danger text-white' : 'text-foreground-secondary hover:bg-sunken hover:text-foreground',
        )}
        data-testid="voice-search"
      >
        {phase === 'working' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : phase === 'recording' ? <Square className="h-3.5 w-3.5" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
      </button>
      {(phase === 'recording' || error) && (
        <div role="status" className="material absolute right-0 top-11 z-20 w-64 rounded-card border border-border p-3 text-xs shadow-card">
          {error ?? (
            <>
              <p className="font-medium text-foreground">{tv('voice_listening')}</p>
              <p className="mt-1 text-foreground-secondary">{t('consent_note')}</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
