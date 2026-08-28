import { ScrollView, Text, View, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useEffect, useCallback } from 'react'
import { useLocalSearchParams, router } from 'expo-router'
import { useI18n } from '@/lib/i18n'
import { fetchRfq, submitQuote } from '@/lib/api'
import { formatINR } from '@/lib/format'

 
export default function ProviderRfqScreen() {
  const { t } = useI18n()
  const { id } = useLocalSearchParams<{ id: string }>()
  const [rfq, setRfq] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [price, setPrice] = useState('')
  const [days, setDays] = useState('')
  const [scope, setScope] = useState('')
  // Phase 4b — optional terms (null = not stated → not sent)
  const [gst, setGst] = useState<boolean | null>(null)
  const [transport, setTransport] = useState<boolean | null>(null)
  const [validUntil, setValidUntil] = useState('')
  const [advance, setAdvance] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => { const d = await fetchRfq(id); setRfq(d?.rfq ?? null); setLoading(false) }, [id])
  // Deferred: keeps setState off the effect's synchronous path.
  useEffect(() => { void Promise.resolve().then(load) }, [load])

  async function submit() {
    setError('')
    const p = Math.round(Number(price) * 100), dd = Number(days)
    if (!p || p <= 0 || !dd || dd <= 0 || scope.trim().length < 20) { setError(t('rfq.required')); return }
    const adv = advance.trim() === '' ? undefined : Number(advance)
    if (adv !== undefined && (!Number.isInteger(adv) || adv < 0 || adv > 100)) { setError(t('rfq.term_advance') + ': 0–100'); return }
    if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) { setError(t('rfq.term_valid_until') + ': YYYY-MM-DD'); return }
    setBusy(true)
    const res = await submitQuote(id, {
      price_paise: p, delivery_days: dd, scope: scope.trim(),
      ...(gst !== null ? { gst_included: gst } : {}),
      ...(transport !== null ? { transport_included: transport } : {}),
      ...(validUntil ? { valid_until: validUntil } : {}),
      ...(adv !== undefined ? { advance_percent: adv } : {}),
    })
    setBusy(false)
    if (!res.ok) { setError(res.data?.error === 'already_quoted' ? t('rfq.already_quoted') : res.data?.error === 'rfq_closed' ? t('rfq.rfq_closed') : t('rfq.err_quote')); return }
    router.back()
  }

  if (loading) return <View className="flex-1 items-center justify-center bg-background"><ActivityIndicator size="large" color="#1B4D3E" /></View>
  if (!rfq) return null
  const details: [string, any][] = Object.entries(rfq.details ?? {}).filter(([, v]) => v != null && String(v).trim() !== '')

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="border-b border-border bg-surface px-4 py-3">
        <Text className="text-base font-bold text-foreground" numberOfLines={1}>{rfq.title}</Text>
      </View>
      <ScrollView contentContainerClassName="px-4 py-4 gap-4">
        <View className="rounded-xl border border-border bg-surface p-4 gap-1">
          {details.map(([k, v]) => (
            <Text key={k} className="text-sm text-foreground"><Text className="text-foreground-secondary capitalize">{k.replace(/_/g, ' ')}: </Text>{String(v)}</Text>
          ))}
        </View>

        {rfq.myQuote ? (
          <View className="rounded-xl border border-success/40 bg-success/5 p-4">
            <Text className="text-sm font-semibold text-success">{t('rfq.your_quote')}</Text>
            <Text className="mt-1 text-sm text-foreground">{formatINR(rfq.myQuote.pricePaise)} · {t('rfq.delivery_days', { days: rfq.myQuote.deliveryDays })}</Text>
            <Text className="mt-1 text-sm text-foreground-secondary">{rfq.myQuote.scope}</Text>
          </View>
        ) : rfq.canQuote ? (
          <View className="rounded-xl border border-border bg-surface p-4 gap-3">
            <Text className="text-sm font-semibold text-foreground">{t('rfq.quote_title')}</Text>
            <View className="flex-row gap-3">
              <View className="flex-1 gap-1"><Text className="text-xs text-foreground-secondary">{t('rfq.quote_price')}</Text><TextInput value={price} onChangeText={setPrice} keyboardType="numeric" className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" /></View>
              <View className="flex-1 gap-1"><Text className="text-xs text-foreground-secondary">{t('rfq.quote_days')}</Text><TextInput value={days} onChangeText={setDays} keyboardType="numeric" className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" /></View>
            </View>
            <View className="gap-1"><Text className="text-xs text-foreground-secondary">{t('rfq.quote_scope')}</Text><TextInput value={scope} onChangeText={setScope} multiline style={{ minHeight: 80 }} className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" /></View>
            {/* Phase 4b — optional terms; leaving them untouched submits exactly as before. */}
            <Text className="text-xs font-medium text-foreground">{t('rfq.terms_section')} <Text className="font-normal text-foreground-secondary">· {t('rfq.terms_optional_note')}</Text></Text>
            <TriRow label={t('rfq.term_gst_q')} value={gst} onChange={setGst} yes={t('rfq.term_yes')} no={t('rfq.term_no')} unset={t('rfq.term_not_stated_option')} />
            <TriRow label={t('rfq.term_transport_q')} value={transport} onChange={setTransport} yes={t('rfq.term_yes')} no={t('rfq.term_no')} unset={t('rfq.term_not_stated_option')} />
            <View className="flex-row gap-3">
              <View className="flex-1 gap-1"><Text className="text-xs text-foreground-secondary">{t('rfq.term_valid_until')}</Text><TextInput value={validUntil} onChangeText={setValidUntil} placeholder="YYYY-MM-DD" placeholderTextColor="#9CA3AF" className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" /></View>
              <View className="flex-1 gap-1"><Text className="text-xs text-foreground-secondary">{t('rfq.term_advance')}</Text><TextInput value={advance} onChangeText={setAdvance} keyboardType="numeric" placeholder="0–100" placeholderTextColor="#9CA3AF" className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" /></View>
            </View>
            {error ? <Text className="text-sm text-danger">{error}</Text> : null}
            <TouchableOpacity onPress={submit} disabled={busy} className="items-center rounded-lg bg-primary py-2.5">
              {busy ? <ActivityIndicator color="#fff" /> : <Text className="font-semibold text-white">{t('rfq.submit_quote')}</Text>}
            </TouchableOpacity>
          </View>
        ) : (
          <View className="rounded-xl border border-border bg-surface p-4"><Text className="text-center text-sm text-foreground-secondary">{t('rfq.rfq_closed')}</Text></View>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

/** Three-state chooser for an optional yes/no term: unset (not stated) / yes / no. */
function TriRow({ label, value, onChange, yes, no, unset }: { label: string; value: boolean | null; onChange: (v: boolean | null) => void; yes: string; no: string; unset: string }) {
  const opts: { v: boolean | null; l: string }[] = [{ v: null, l: unset }, { v: true, l: yes }, { v: false, l: no }]
  return (
    <View className="gap-1">
      <Text className="text-xs text-foreground-secondary">{label}</Text>
      <View className="flex-row gap-2">
        {opts.map((o) => (
          <TouchableOpacity key={String(o.v)} onPress={() => onChange(o.v)} className={`rounded-lg border px-3 py-1.5 ${value === o.v ? 'border-primary bg-primary/10' : 'border-border bg-background'}`}>
            <Text className={`text-xs ${value === o.v ? 'font-semibold text-primary' : 'text-foreground'}`}>{o.l}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  )
}
 
