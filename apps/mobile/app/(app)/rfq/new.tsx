import { ScrollView, Text, View, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useEffect } from 'react'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { supabase } from '@/lib/supabase'
import { createRfq } from '@/lib/api'
import { track } from '@/lib/analytics'
import { VoiceRfqRecorder } from '@/components/VoiceRfqRecorder'

export default function NewRfqScreen() {
  const { t, locale } = useI18n()
  const [cats, setCats] = useState<any[]>([])
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [details, setDetails] = useState<Record<string, string>>({})
  const [bmin, setBmin] = useState('')
  const [bmax, setBmax] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Phase 8b — voice_meta carried to the normal RFQ submit (never auto-sent).
  const [voice, setVoice] = useState<any>(null)

  useEffect(() => {
    supabase.from('categories').select('slug, name_i18n, rfq_template').eq('is_active', true).order('sort_order').then(({ data }) => setCats(data ?? []))
  }, [])

  const category = cats.find((c) => c.slug === slug)
  const fields: any[] = category?.rfq_template?.fields ?? []

  function markEdited(field: string) {
    setVoice((v: any) => {
      if (!v || v.edited_fields.includes(field)) return v
      track('voice_rfq_edited', { surface: 'rfq_form', field, locale })
      return { ...v, edited_fields: [...v.edited_fields, field] }
    })
  }

  function applyParse(data: any, durationMs: number) {
    const p = data.parse
    if (p.category_slug) setSlug(p.category_slug)
    if (p.description_english?.length >= 10) setTitle(p.description_english.slice(0, 120))
    setDetails((d) => ({ ...d, additional_details: p.description_english }))
    setVoice({
      transcript_english: String(data.transcript_english).slice(0, 4000),
      parse: p,
      duration_ms: Math.min(Math.max(durationMs, 1), 60000),
      edited_fields: [],
      vendor: data.vendor,
      stub: data.stub,
    })
  }

  function applyTranscriptOnly(transcript: string, durationMs: number) {
    setDetails((d) => ({ ...d, additional_details: transcript }))
    setVoice({
      transcript_english: transcript.slice(0, 4000),
      parse: {
        category_slug: null, specialization: null, state: null,
        description_english: transcript.slice(0, 2000),
        original_language: 'unknown', uncertain: true,
      },
      duration_ms: Math.min(Math.max(durationMs, 1), 60000),
      edited_fields: [],
      vendor: { stt: 'unknown', parser: 'failed' },
    })
  }

  async function submit() {
    setError('')
    if (!slug || title.trim().length < 10) { setError(t('rfq.required')); return }
    for (const f of fields) if (f.required && !details[f.name]?.trim()) { setError((locale === 'hi' ? f.label_hi : f.label_en) + ': ' + t('rfq.required')); return }
    setLoading(true)
    const voiceMeta = voice
      ? {
          transcript_english: voice.transcript_english,
          parse: voice.parse,
          duration_ms: voice.duration_ms,
          edited_fields: voice.edited_fields,
          vendor: voice.vendor,
        }
      : undefined
    const res = await createRfq({
      category_slug: slug, title: title.trim(), details,
      ...(bmin ? { budget_min_paise: Math.round(Number(bmin) * 100) } : {}),
      ...(bmax ? { budget_max_paise: Math.round(Number(bmax) * 100) } : {}),
      ...(voiceMeta ? { voice_meta: voiceMeta } : {}),
    })
    setLoading(false)
    if (res.status === 403 && res.data?.error === 'profile_incomplete') { setError(t('rfq.profile_incomplete')); return }
    if (!res.ok) { setError(t('rfq.err_create')); return }
    if (voiceMeta) {
      track('voice_rfq_submitted', {
        surface: 'rfq_form',
        original_language: voiceMeta.parse.original_language,
        uncertain: voiceMeta.parse.uncertain,
        edit_count: voiceMeta.edited_fields.length,
        locale,
      })
    }
    router.replace(`/rfq/${res.data.rfqId}` as never)
  }

  const voiceCategoryName = voice?.parse?.category_slug
    ? (() => {
        const c = cats.find((x) => x.slug === voice.parse.category_slug)
        return c ? (c.name_i18n?.[locale] ?? c.name_i18n?.en) : voice.parse.category_slug
      })()
    : null

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="border-b border-border bg-surface px-4 py-3">
        <Text className="text-lg font-bold text-foreground">{t('rfq.new_title')}</Text>
      </View>
      <ScrollView contentContainerClassName="px-4 py-4 gap-4">
        <VoiceRfqRecorder onParsed={applyParse} onTranscriptOnly={applyTranscriptOnly} />

        {voice ? (
          <View className={`rounded-xl border p-3.5 ${voice.parse.uncertain ? 'border-warning bg-warning/10' : 'border-primary/40 bg-primary/5'}`}>
            <Text className="text-sm text-foreground">
              <Text className="font-semibold">{t('voice.heard_label')} </Text>
              <Text className="italic">“{voice.transcript_english}”</Text>
            </Text>
            {!voice.parse.uncertain && voiceCategoryName ? (
              <View className="mt-2 flex-row flex-wrap items-center gap-2">
                <Text className="text-sm font-semibold text-foreground">{t('voice.think_label')}</Text>
                <View className="rounded-full bg-primary/10 px-3 py-1">
                  <Text className="text-xs font-semibold text-primary">{voiceCategoryName}</Text>
                </View>
                {voice.parse.state ? (
                  <View className="rounded-full bg-border/60 px-3 py-1">
                    <Text className="text-xs font-medium text-foreground">{voice.parse.state}</Text>
                  </View>
                ) : null}
              </View>
            ) : (
              <View className="mt-2 flex-row items-center gap-1.5">
                <Ionicons name="mic-outline" size={14} color="#B45309" />
                <Text className="flex-1 text-xs font-medium text-warning">{t('voice.uncertain_note')}</Text>
              </View>
            )}
            <Text className="mt-2 text-xs text-foreground-secondary">
              {t('voice.check_note')}{voice.stub ? ' ' + t('voice.stub_note') : ''}
            </Text>
          </View>
        ) : null}

        <Text className="text-sm font-medium text-foreground">{t('rfq.pick_category')}</Text>
        <View className="flex-row flex-wrap gap-2">
          {cats.map((c) => (
            <TouchableOpacity key={c.slug} onPress={() => { markEdited('category'); setSlug(c.slug); setDetails(voice ? details : {}) }}
              className={`rounded-full border px-3 py-1.5 ${slug === c.slug ? 'border-primary bg-primary' : 'border-border'}`}>
              <Text className={`text-xs font-medium ${slug === c.slug ? 'text-white' : 'text-foreground'}`}>{c.name_i18n?.[locale] ?? c.name_i18n?.en}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {category && (
          <>
            <Field label={t('rfq.title_label')} value={title} onChange={(v) => { markEdited('title'); setTitle(v) }} />
            {fields.map((f) => (
              <Field key={f.name} label={(locale === 'hi' ? f.label_hi : f.label_en) + (f.required ? ' *' : '') + (f.options ? ` (${f.options.join(' / ')})` : '')}
                value={details[f.name] ?? ''} onChange={(v) => setDetails((d) => ({ ...d, [f.name]: v }))} multiline={f.type === 'textarea'} />
            ))}
            <Field label={t('rfq.details_label')} value={details['additional_details'] ?? ''}
              onChange={(v) => { markEdited('description'); setDetails((d) => ({ ...d, additional_details: v })) }} multiline />
            <View className="flex-row gap-3">
              <View className="flex-1"><Field label={t('rfq.budget_min')} value={bmin} onChange={setBmin} numeric /></View>
              <View className="flex-1"><Field label={t('rfq.budget_max')} value={bmax} onChange={setBmax} numeric /></View>
            </View>
            {error ? <Text className="text-sm text-danger">{error}</Text> : null}
            <TouchableOpacity onPress={submit} disabled={loading} className="mt-2 items-center rounded-xl bg-primary py-3">
              {loading ? <ActivityIndicator color="#fff" /> : <Text className="font-semibold text-white">{t('rfq.submit')}</Text>}
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

function Field({ label, value, onChange, multiline, numeric }: { label: string; value: string; onChange: (v: string) => void; multiline?: boolean; numeric?: boolean }) {
  return (
    <View className="gap-1.5">
      <Text className="text-xs font-medium text-foreground-secondary">{label}</Text>
      <TextInput value={value} onChangeText={onChange} multiline={multiline} keyboardType={numeric ? 'numeric' : 'default'}
        className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground" style={multiline ? { minHeight: 72 } : undefined} />
    </View>
  )
}
