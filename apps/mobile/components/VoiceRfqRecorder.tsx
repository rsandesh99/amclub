import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, ActivityIndicator, Animated, Platform, Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import {
  AudioModule,
  AudioQuality,
  IOSOutputFormat,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioRecorder,
  type RecordingOptions,
} from 'expo-audio'
import { useI18n } from '@/lib/i18n'
import { track } from '@/lib/analytics'
import { voiceParse, type VoiceParsePriorPayload } from '@/lib/api'
import { colors } from '@/lib/theme'

/**
 * Phase 8b — mic capture for Voice RFQ (mobile, expo-audio; expo-av was
 * removed in Expo SDK 55). Record (≤60s) → playback + re-record → POST
 * /api/v1/rfq/voice-parse. Never submits an RFQ — the parent pre-fills the
 * normal form. All failures resolve to an inline message; the manual form
 * below stays usable.
 */

// Sarvam's REST tier hard-rejects clips >30s (verified against prod 2026-07-08).
const MAX_RECORD_MS = 30_000

// Sarvam rejects audio/m4a (the expo-audio preset default) but accepts
// audio/aac and audio/wav — full allowed list captured in ai_invocations on
// 2026-07-08. Android records AAC-ADTS; iOS records 16-bit PCM WAV.
const MIME = Platform.OS === 'ios' ? 'audio/wav' : 'audio/aac'
const RECORDING_OPTIONS: RecordingOptions = {
  extension: Platform.OS === 'ios' ? '.wav' : '.aac',
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 128_000,
  android: {
    outputFormat: 'aac_adts',
    audioEncoder: 'aac',
  },
  ios: {
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.HIGH,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {}, // native app — web capture handled by apps/web's WAV recorder
}

type Phase = 'idle' | 'recording' | 'review' | 'uploading'

interface VoiceRfqRecorderProps {
  onParsed: (data: any, durationMs: number) => void
  onTranscriptOnly: (transcript: string, durationMs: number) => void
  /** S1.8 — round two of the one clarifying question (posted as `prior`). */
  prior?: VoiceParsePriorPayload | null
}

export function VoiceRfqRecorder({ onParsed, onTranscriptOnly, prior = null }: VoiceRfqRecorderProps) {
  const { t } = useI18n()
  const recorder = useAudioRecorder(RECORDING_OPTIONS)
  const player = useAudioPlayer()

  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [error, setError] = useState('')

  const startedAtRef = useRef(0)
  const durationRef = useRef(0)
  const uriRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Live-recording pulse ring (spec parity with web); disabled under the OS
  // reduce-motion setting, matching web's motion-safe: gating.
  const pulse = useRef(new Animated.Value(0)).current
  const reduceMotionRef = useRef(false)

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { reduceMotionRef.current = v })
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  useEffect(() => {
    if (phase !== 'recording' || reduceMotionRef.current) {
      pulse.setValue(0)
      return undefined
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [phase, pulse])

  async function start() {
    setError('')
    const perm = await AudioModule.requestRecordingPermissionsAsync()
    if (!perm.granted) {
      setError(t('voice.err_mic_denied') + ' ' + t('voice.type_instead'))
      track('voice_rfq_failed', { surface: 'rfq_form', reason: 'mic_denied' })
      return
    }
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
      await recorder.prepareToRecordAsync()
      recorder.record()
    } catch {
      setError(t('voice.err_unsupported') + ' ' + t('voice.type_instead'))
      return
    }
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
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    try {
      await recorder.stop()
    } catch {}
    durationRef.current = Math.min(Date.now() - startedAtRef.current, MAX_RECORD_MS)
    uriRef.current = recorder.uri
    if (uriRef.current) {
      player.replace(uriRef.current)
      setPhase('review')
    } else {
      setError(t('voice.err_transcribe') + ' ' + t('voice.type_instead'))
      setPhase('idle')
    }
  }

  function play() {
    player.seekTo(0)
    player.play()
  }

  async function send() {
    const uri = uriRef.current
    if (!uri) return
    setPhase('uploading')
    setError('')
    const res = await voiceParse(uri, MIME, durationRef.current, prior)
    if (res.ok) {
      track('voice_rfq_transcribed', {
        surface: 'rfq_form',
        original_language: res.data.parse?.original_language,
        duration_ms: Math.round(durationRef.current),
      })
      track('voice_rfq_parsed', {
        surface: 'rfq_form',
        original_language: res.data.parse?.original_language,
        uncertain: res.data.parse?.uncertain,
        stub: res.data.stub,
      })
      onParsed(res.data, Math.round(durationRef.current))
      setPhase('idle')
      return
    }
    if (res.status === 429) setError(t('voice.err_rate_limited'))
    else if (res.data?.error === 'audio_too_long') setError(t('voice.err_too_long'))
    else if (res.data?.error === 'audio_too_large') setError(t('voice.err_too_large'))
    else if (res.data?.error === 'transcription_empty') setError(t('voice.err_no_speech'))
    else if (res.data?.error === 'parse_failed' && res.data?.transcript_english) {
      onTranscriptOnly(res.data.transcript_english, Math.round(durationRef.current))
      setPhase('idle')
      track('voice_rfq_failed', { surface: 'rfq_form', reason: 'parse_failed_transcript_kept', cause: res.data?.cause })
      return
    } else if (res.data?.cause === 'quota') setError(t('voice.err_quota'))
    else if (res.data?.cause === 'busy') setError(t('voice.err_busy'))
    else if (res.data?.error === 'transcription_failed') setError(t('voice.err_stt'))
    else setError(t('voice.err_transcribe'))
    track('voice_rfq_failed', { surface: 'rfq_form', reason: res.data?.error ?? `http_${res.status}`, cause: res.data?.cause })
    setPhase('review')
  }

  const seconds = Math.floor(elapsedMs / 1000)
  const remaining = Math.max(0, Math.ceil((MAX_RECORD_MS - elapsedMs) / 1000))

  return (
    <View className="rounded-xl border border-border bg-surface p-4">
      <View className="flex-row items-center gap-2">
        <Ionicons name="sparkles" size={16} color={colors.primary} />
        <Text className="text-sm font-semibold text-foreground">{t('voice.intro_title')}</Text>
      </View>
      <Text className="mt-1 text-xs leading-4 text-foreground-secondary">{t('voice.intro_sub')}</Text>
      {/* DPDP consent + no-retention fact (§Phase 8b v1.1) — shown before any recording. */}
      <Text className="mt-1 text-[11px] leading-4 text-foreground-secondary opacity-80">{t('voice.consent_note')}</Text>

      <View className="mt-3 flex-row flex-wrap items-center gap-3">
        {phase === 'idle' && (
          <TouchableOpacity
            onPress={() => void start()}
            className="flex-row items-center gap-2 rounded-xl bg-primary px-4 py-2.5"
          >
            <Ionicons name="mic" size={18} color={colors.white} />
            <Text className="font-semibold text-white">{t('voice.record_cta')}</Text>
          </TouchableOpacity>
        )}

        {phase === 'recording' && (
          <>
            <View className="h-14 w-14 items-center justify-center">
              {/* pulse ring behind the stop button */}
              <Animated.View
                pointerEvents="none"
                className="absolute h-14 w-14 rounded-full bg-danger/30"
                style={{
                  transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] }) }],
                  opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
                }}
              />
              <TouchableOpacity
                onPress={() => void stop()}
                accessibilityLabel={t('voice.stop_cta')}
                className="h-14 w-14 items-center justify-center rounded-full bg-danger"
              >
                <Ionicons name="square" size={20} color={colors.white} />
              </TouchableOpacity>
            </View>
            <View>
              <Text className="text-sm font-semibold text-foreground">
                {t('voice.recording')} · 0:{String(seconds).padStart(2, '0')}
              </Text>
              <Text className="text-xs text-foreground-secondary">
                {t('voice.seconds_left', { s: remaining })}
              </Text>
            </View>
          </>
        )}

        {phase === 'review' && (
          <View className="w-full gap-2.5">
            <View className="flex-row flex-wrap gap-2.5">
              <TouchableOpacity
                onPress={play}
                className="flex-row items-center gap-1.5 rounded-xl border border-border bg-surface px-4 py-2.5"
              >
                <Ionicons name="play" size={16} color={colors.primary} />
                <Text className="font-medium text-foreground">0:{String(Math.round(durationRef.current / 1000)).padStart(2, '0')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => void send()}
                className="rounded-xl bg-primary px-4 py-2.5"
              >
                <Text className="font-semibold text-white">{t('voice.use_recording')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => void start()}
                className="flex-row items-center gap-1.5 rounded-xl border border-border bg-surface px-4 py-2.5"
              >
                <Ionicons name="refresh" size={16} color={colors.primary} />
                <Text className="font-medium text-foreground">{t('voice.re_record')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {phase === 'uploading' && (
          <View className="flex-row items-center gap-2">
            <ActivityIndicator color={colors.primary} />
            <Text className="text-sm text-foreground-secondary">{t('voice.processing')}</Text>
          </View>
        )}
      </View>

      {error ? <Text className="mt-2.5 text-xs text-danger">{error}</Text> : null}
    </View>
  )
}
