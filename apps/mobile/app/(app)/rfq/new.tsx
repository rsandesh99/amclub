import { ScrollView, Text, View, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useEffect } from 'react'
import { router } from 'expo-router'
import { useI18n } from '@/lib/i18n'
import { supabase } from '@/lib/supabase'
import { createRfq } from '@/lib/api'

/* eslint-disable @typescript-eslint/no-explicit-any */
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

  useEffect(() => {
    supabase.from('categories').select('slug, name_i18n, rfq_template').eq('is_active', true).order('sort_order').then(({ data }) => setCats(data ?? []))
  }, [])

  const category = cats.find((c) => c.slug === slug)
  const fields: any[] = category?.rfq_template?.fields ?? []

  async function submit() {
    setError('')
    if (!slug || title.trim().length < 10) { setError(t('rfq.required')); return }
    for (const f of fields) if (f.required && !details[f.name]?.trim()) { setError((locale === 'hi' ? f.label_hi : f.label_en) + ': ' + t('rfq.required')); return }
    setLoading(true)
    const res = await createRfq({
      category_slug: slug, title: title.trim(), details,
      ...(bmin ? { budget_min_paise: Math.round(Number(bmin) * 100) } : {}),
      ...(bmax ? { budget_max_paise: Math.round(Number(bmax) * 100) } : {}),
    })
    setLoading(false)
    if (res.status === 403 && res.data?.error === 'profile_incomplete') { setError(t('rfq.profile_incomplete')); return }
    if (!res.ok) { setError(t('rfq.err_create')); return }
    router.replace(`/rfq/${res.data.rfqId}` as never)
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="border-b border-border bg-surface px-4 py-3">
        <Text className="text-lg font-bold text-foreground">{t('rfq.new_title')}</Text>
      </View>
      <ScrollView contentContainerClassName="px-4 py-4 gap-4">
        <Text className="text-sm font-medium text-foreground">{t('rfq.pick_category')}</Text>
        <View className="flex-row flex-wrap gap-2">
          {cats.map((c) => (
            <TouchableOpacity key={c.slug} onPress={() => { setSlug(c.slug); setDetails({}) }}
              className={`rounded-full border px-3 py-1.5 ${slug === c.slug ? 'border-primary bg-primary' : 'border-border'}`}>
              <Text className={`text-xs font-medium ${slug === c.slug ? 'text-white' : 'text-foreground'}`}>{c.name_i18n?.[locale] ?? c.name_i18n?.en}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {category && (
          <>
            <Field label={t('rfq.title_label')} value={title} onChange={setTitle} />
            {fields.map((f) => (
              <Field key={f.name} label={(locale === 'hi' ? f.label_hi : f.label_en) + (f.required ? ' *' : '') + (f.options ? ` (${f.options.join(' / ')})` : '')}
                value={details[f.name] ?? ''} onChange={(v) => setDetails((d) => ({ ...d, [f.name]: v }))} multiline={f.type === 'textarea'} />
            ))}
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
/* eslint-enable @typescript-eslint/no-explicit-any */
