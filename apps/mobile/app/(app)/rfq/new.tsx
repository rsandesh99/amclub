import { ScrollView, Text, View, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useEffect } from 'react'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { supabase } from '@/lib/supabase'
import { createRfq, fetchMartCategories, fetchMartDeliveryDefaults, type MartCategory, type GoodsDelivery } from '@/lib/api'
import { track } from '@/lib/analytics'
import { VoiceRfqRecorder } from '@/components/VoiceRfqRecorder'
import { QualityQuestionsBlock } from '@/components/QualityQuestionsBlock'
import { colors } from '@/lib/theme'
import { rfqFieldLabel, pickLocale, PRODUCT_UNITS } from '@amclub/shared'

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
  // S1.5 — set when the create reply is DEFERRED (questions before sending); replaces the form.
  const [quality, setQuality] = useState<{ rfqId: string; report: any; deadlineAt: string | null; modelUsed: boolean } | null>(null)
  // AMC Mart M2 — goods mode exists only when /api/v1/mart/categories answers (flag on).
  const [martCats, setMartCats] = useState<MartCategory[]>([])
  const [mode, setMode] = useState<'service' | 'goods'>('service')
  const [gCat, setGCat] = useState('')
  const [gItem, setGItem] = useState('')
  const [gQty, setGQty] = useState('')
  const [gUnit, setGUnit] = useState<string>('pcs')
  const [gSpec, setGSpec] = useState<{ k: string; v: string }[]>([{ k: '', v: '' }])
  const [gTarget, setGTarget] = useState('')
  const [gDetails, setGDetails] = useState('')
  const [deliv, setDeliv] = useState<GoodsDelivery>({ contact_name: '', contact_phone: '', address: '', city: '', state: 'AP', pincode: '', pickup: false })

  useEffect(() => {
    supabase.from('categories').select('slug, name_i18n, rfq_template').eq('is_active', true).order('sort_order').then(({ data }) => setCats(data ?? []))
    fetchMartCategories().then((r) => {
      if (!r.ok) return
      setMartCats(r.categories.filter((c) => !c.bisBlocked))
      fetchMartDeliveryDefaults().then((d) => { if (d) setDeliv({ contact_name: d.contact_name, contact_phone: d.contact_phone, address: d.address, city: d.city, state: d.state || 'AP', pincode: d.pincode, pickup: d.pickup }) })
    })
  }, [])

  async function submitGoods() {
    setError('')
    const qtyNum = Number(gQty)
    if (!gCat) { setError(t('rfq.goods_category_label') + ': ' + t('rfq.required')); return }
    if (gItem.trim().length < 3) { setError(t('rfq.goods_err_item')); return }
    if (!Number.isInteger(qtyNum) || qtyNum <= 0) { setError(t('rfq.goods_err_qty')); return }
    const spec = gSpec.map((r) => ({ k: r.k.trim(), v: r.v.trim() })).filter((r) => r.k && r.v)
    if (!deliv.contact_name.trim() || !deliv.contact_phone.trim() || !deliv.city.trim() || !/^\d{6}$/.test(deliv.pincode) || (!deliv.pickup && deliv.address.trim().length < 5)) { setError(t('rfq.goods_err_delivery')); return }
    const targetPaise = gTarget.trim() ? Math.round(Number(gTarget) * 100) : 0
    setLoading(true)
    const res = await createRfq({
      kind: 'goods',
      mart_category_slug: gCat,
      title: `${gItem.trim()} × ${qtyNum} ${gUnit}`.slice(0, 200),
      details: gDetails.trim() ? { additional_details: gDetails.trim() } : {},
      goods_spec: {
        item: gItem.trim(), qty: qtyNum, unit: gUnit, spec,
        ...(targetPaise > 0 ? { target_unit_price_paise: targetPaise } : {}),
        delivery: { ...deliv, address: deliv.pickup && deliv.address.trim().length < 5 ? `Pickup — ${deliv.city}` : deliv.address.trim() },
      },
    })
    setLoading(false)
    if (res.status === 403 && res.data?.error === 'profile_incomplete') { setError(t('rfq.profile_incomplete')); return }
    if (!res.ok) { setError(t('rfq.err_create')); return }
    track('mart_goods_rfq_created', { surface: 'rfq_form', category: gCat, qty: qtyNum, unit: gUnit, spec_lines: spec.length, locale })
    router.replace(`/rfq/${res.data.rfqId}` as never)
  }

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
    for (const f of fields) if (f.required && !details[f.name]?.trim()) { setError(rfqFieldLabel(f, locale) + ': ' + t('rfq.required')); return }
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
    // S1.5 — DEFERRED: the RFQ exists but is held for answers; show the questions instead of navigating.
    if (res.data?.deferred && Array.isArray(res.data?.quality?.missing) && res.data.quality.missing.length > 0) {
      setQuality({ rfqId: res.data.rfqId, report: res.data.quality, deadlineAt: res.data.deadline_at ?? null, modelUsed: res.data.quality_meta?.model_used !== false })
      return
    }
    router.replace(`/rfq/${res.data.rfqId}` as never)
  }

  const voiceCategoryName = voice?.parse?.category_slug
    ? (() => {
        const c = cats.find((x) => x.slug === voice.parse.category_slug)
        return c ? pickLocale(c.name_i18n, locale) : voice.parse.category_slug
      })()
    : null

  // S1.5 — the request exists but is held for the buyer's answers: the card replaces the form.
  if (quality) {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top']}>
        <View className="border-b border-border bg-surface px-4 py-3">
          <Text className="text-lg font-bold text-foreground">{t('rfq.quality_title')}</Text>
          <Text className="text-xs text-foreground-secondary" numberOfLines={1}>{title.trim()}</Text>
        </View>
        <ScrollView contentContainerClassName="px-4 py-4 gap-4">
          <QualityQuestionsBlock rfqId={quality.rfqId} report={quality.report} deadlineAt={quality.deadlineAt} modelUsed={quality.modelUsed} onSent={(id) => router.replace(`/rfq/${id}` as never)} />
        </ScrollView>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="border-b border-border bg-surface px-4 py-3">
        <Text className="text-lg font-bold text-foreground">{t('rfq.new_title')}</Text>
      </View>
      <ScrollView contentContainerClassName="px-4 py-4 gap-4">
        {martCats.length > 0 && (
          <View className="flex-row gap-2">
            {(['service', 'goods'] as const).map((m) => (
              <TouchableOpacity key={m} onPress={() => setMode(m)} className={`flex-1 items-center rounded-xl border py-2 ${mode === m ? 'border-primary bg-primary/10' : 'border-border bg-surface'}`}>
                <Text className={`text-sm ${mode === m ? 'font-semibold text-primary' : 'text-foreground'}`}>{m === 'goods' ? t('rfq.goods_new_title') : t('rfq.new_title')}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {mode === 'goods' ? (
          <>
            <Text className="text-sm font-medium text-foreground">{t('rfq.goods_category_label')}</Text>
            <View className="flex-row flex-wrap gap-2">
              {martCats.map((c) => (
                <TouchableOpacity key={c.slug} onPress={() => setGCat(c.slug)} className={`rounded-full border px-3 py-1.5 ${gCat === c.slug ? 'border-primary bg-primary' : 'border-border'}`}>
                  <Text className={`text-xs font-medium ${gCat === c.slug ? 'text-white' : 'text-foreground'}`}>{pickLocale(c.nameI18n, locale)}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Field label={t('rfq.goods_item_label')} value={gItem} onChange={setGItem} />
            <View className="flex-row gap-3">
              <View className="flex-1"><Field label={t('rfq.goods_qty_label')} value={gQty} onChange={setGQty} numeric /></View>
              <View className="flex-1 gap-1.5">
                <Text className="text-xs font-medium text-foreground-secondary">{t('rfq.goods_unit_label')}</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-1.5">
                  {PRODUCT_UNITS.map((u) => (
                    <TouchableOpacity key={u} onPress={() => setGUnit(u)} className={`rounded-lg border px-2.5 py-2 ${gUnit === u ? 'border-primary bg-primary/10' : 'border-border'}`}>
                      <Text className={`text-xs ${gUnit === u ? 'font-semibold text-primary' : 'text-foreground'}`}>{u}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            </View>
            <Text className="text-xs font-medium text-foreground-secondary">{t('rfq.goods_spec_label')}</Text>
            {gSpec.map((r, i) => (
              <View key={i} className="flex-row gap-2">
                <TextInput value={r.k} onChangeText={(v) => setGSpec((rs) => rs.map((x, j) => (j === i ? { ...x, k: v } : x)))} placeholder="Grade" placeholderTextColor="#9CA3AF" className="flex-1 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground" />
                <TextInput value={r.v} onChangeText={(v) => setGSpec((rs) => rs.map((x, j) => (j === i ? { ...x, v } : x)))} placeholder="8.8" placeholderTextColor="#9CA3AF" className="flex-[2] rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground" />
              </View>
            ))}
            {gSpec.length < 12 && (
              <TouchableOpacity onPress={() => setGSpec((rs) => [...rs, { k: '', v: '' }])}><Text className="text-xs font-medium text-primary">+ {t('rfq.goods_spec_add')}</Text></TouchableOpacity>
            )}
            <Field label={t('rfq.goods_target_label')} value={gTarget} onChange={setGTarget} numeric />
            <Field label={t('rfq.details_label')} value={gDetails} onChange={setGDetails} multiline />

            <Text className="text-sm font-medium text-foreground">{t('rfq.goods_deliver_to')}</Text>
            <Field label={t('mart.contact_name')} value={deliv.contact_name} onChange={(v) => setDeliv((d) => ({ ...d, contact_name: v }))} />
            <Field label={t('mart.contact_phone')} value={deliv.contact_phone} onChange={(v) => setDeliv((d) => ({ ...d, contact_phone: v }))} numeric />
            <Field label={t('mart.address')} value={deliv.address} onChange={(v) => setDeliv((d) => ({ ...d, address: v }))} />
            <View className="flex-row gap-3">
              <View className="flex-1"><Field label={t('mart.city')} value={deliv.city} onChange={(v) => setDeliv((d) => ({ ...d, city: v }))} /></View>
              <View className="w-20"><Field label={t('mart.state')} value={deliv.state} onChange={(v) => setDeliv((d) => ({ ...d, state: v.toUpperCase().slice(0, 2) }))} /></View>
              <View className="w-28"><Field label={t('mart.pincode')} value={deliv.pincode} onChange={(v) => setDeliv((d) => ({ ...d, pincode: v }))} numeric /></View>
            </View>
            <TouchableOpacity onPress={() => setDeliv((d) => ({ ...d, pickup: !d.pickup }))} className="flex-row items-center gap-2">
              <Ionicons name={deliv.pickup ? 'checkbox' : 'square-outline'} size={20} color={colors.primary} />
              <Text className="text-sm text-foreground">{t('mart.pickup')}</Text>
            </TouchableOpacity>
            {error ? <Text className="text-sm text-danger">{error}</Text> : null}
            <TouchableOpacity onPress={submitGoods} disabled={loading} className="mt-2 items-center rounded-xl bg-primary py-3">
              {loading ? <ActivityIndicator color="#fff" /> : <Text className="font-semibold text-white">{t('rfq.goods_submit')}</Text>}
            </TouchableOpacity>
          </>
        ) : (
        <>
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
                <Ionicons name="mic-outline" size={14} color={colors.warning} />
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
              <Text className={`text-xs font-medium ${slug === c.slug ? 'text-white' : 'text-foreground'}`}>{pickLocale(c.name_i18n, locale)}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {category && (
          <>
            <Field label={t('rfq.title_label')} value={title} onChange={(v) => { markEdited('title'); setTitle(v) }} />
            {fields.map((f) => (
              <Field key={f.name} label={rfqFieldLabel(f, locale) + (f.required ? ' *' : '') + (f.options ? ` (${f.options.join(' / ')})` : '')}
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
