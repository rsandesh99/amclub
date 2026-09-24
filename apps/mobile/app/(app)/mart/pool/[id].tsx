/**
 * AMC Mart M1 — pool detail: join / change / leave while open; pay when met.
 * Pay-on-close: joining moves no money. Every number is the server's.
 */
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Image, ScrollView, Share, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { fetchMartPool, joinMartPool, leaveMartPool, martPoolCheckout, simulatePay, fetchMartDeliveryDefaults, type MartPool, type MartPoolMember, type GoodsDelivery } from '@/lib/api'
import { formatINR, formatINRExact } from '@/lib/format'
import { colors } from '@/lib/theme'
import { ErrorState } from '@/components/ErrorState'
import { PoolProgressBar } from '../pools'

const istDate = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const EMPTY: GoodsDelivery = { contact_name: '', contact_phone: '', address: '', city: '', state: 'AP', pincode: '', pickup: false }

export default function MartPoolScreen() {
  const { t, locale } = useI18n()
  const { id } = useLocalSearchParams<{ id: string }>()
  const [pool, setPool] = useState<MartPool | null>(null)
  const [member, setMember] = useState<MartPoolMember | null>(null)
  const [shareText, setShareText] = useState('')
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [qty, setQty] = useState('10')
  const [form, setForm] = useState<GoodsDelivery>(EMPTY)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const r = await fetchMartPool(id, locale)
    setFailed(!r.ok)
    setPool(r.pool)
    setMember(r.member)
    setShareText(r.shareText)
    if (r.member) setQty(String(r.member.qty))
    const d = await fetchMartDeliveryDefaults()
    if (d) setForm({ ...EMPTY, ...d })
    setLoading(false)
  }, [id, locale])
  useEffect(() => { void Promise.resolve().then(load) }, [load])

  const errText = (code: string) => {
    const k = `mart.pool_err_${code}`
    const s = t(k)
    return s === k ? t('mart.failed') : s
  }

  async function join() {
    setBusy(true); setError('')
    const r = await joinMartPool(id, Number(qty), form)
    setBusy(false)
    if (!r.ok) { setError(errText(r.error ?? 'failed')); return }
    if (r.pool) setPool(r.pool)
    setMember(r.member)
    setEditing(false)
  }
  async function leave() {
    setBusy(true); setError('')
    const r = await leaveMartPool(id)
    setBusy(false)
    if (!r.ok) { setError(errText(r.error ?? 'failed')); return }
    if (r.pool) setPool(r.pool)
    setMember(null)
  }
  async function pay() {
    setBusy(true); setError('')
    const r = await martPoolCheckout(id)
    if (!r.ok) {
      setBusy(false)
      if (r.orderId) { router.push(`/orders/${r.orderId}` as never); return }
      setError(errText(r.error ?? 'failed')); return
    }
    const s = r.session!
    if (s.simulated) {
      const sim = await simulatePay(s.checkoutSessionId)
      setBusy(false)
      if (sim.ok && sim.data?.orderId) router.push(`/orders/${sim.data.orderId}` as never)
      else setError(t('mart.failed'))
      return
    }
    setBusy(false)
    Alert.alert(t('mart.pool_pay_title'), t('checkout.real_pay_note'))
  }

  if (loading) return <SafeAreaView className="flex-1 items-center justify-center bg-background"><ActivityIndicator size="large" color={colors.emerald} /></SafeAreaView>

  const live = pool?.status === 'open'
  const qtyN = Number(qty)
  const formValid = qtyN >= 1 && form.contact_name.trim().length >= 2 && /^(?:\+91)?[6-9]\d{9}$/.test(form.contact_phone) && form.address.trim().length >= 5 && form.city.trim().length >= 2 && /^\d{6}$/.test(form.pincode)
  const saving = pool?.list_price_paise && pool.list_price_paise > pool.unit_price_paise ? Math.round(((pool.list_price_paise - pool.unit_price_paise) / pool.list_price_paise) * 100) : 0

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center gap-2 border-b border-border bg-surface px-4 py-3">
        <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('common.back')} className="h-12 w-12 items-center justify-center">
          <Ionicons name="arrow-back" size={22} color={colors.ink} />
        </TouchableOpacity>
        <Text className="flex-1 text-base font-bold text-ink" numberOfLines={1}>{pool?.title ?? t('mart.pools_title')}</Text>
        {shareText ? (
          <TouchableOpacity onPress={() => void Share.share({ message: shareText })} accessibilityRole="button" accessibilityLabel={t('mart.pool_share')} className="h-12 w-12 items-center justify-center">
            <Ionicons name="share-social-outline" size={22} color={colors.emeraldInk} />
          </TouchableOpacity>
        ) : null}
      </View>
      {failed ? (
        <ErrorState onRetry={load} />
      ) : !pool ? (
        <View className="flex-1 items-center justify-center px-8"><Text className="text-center text-base text-ink">{t('mart.pool_err_pool_closed')}</Text></View>
      ) : (
        <ScrollView contentContainerClassName="px-4 py-4 gap-4 pb-24">
          {/* The card: emerald, one gold numeral */}
          <View className="rounded-card bg-emerald-ink p-4">
            <View className="flex-row gap-3">
              <View className="h-24 w-24 overflow-hidden rounded-lg bg-white/10">
                {pool.imageUrl ? <Image source={{ uri: pool.imageUrl }} className="h-24 w-24" resizeMode="cover" accessibilityIgnoresInvertColors /> : null}
              </View>
              <View className="flex-1">
                <Text className="self-start rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-semibold text-ivory">{t(`mart.pool_status_${pool.status}`)}</Text>
                <Text className="mt-1 text-xl font-bold leading-tight text-ivory">{pool.title}</Text>
                {pool.seller && <Text className="mt-1 text-xs text-ivory/80">{t('mart.sold_by')} {pool.seller.displayName}{pool.seller.city ? ` · ${pool.seller.city}` : ''}</Text>}
              </View>
            </View>
            <View className="mt-3 flex-row flex-wrap items-baseline gap-x-2">
              <Text className="text-3xl font-bold text-gold">{formatINRExact(pool.unit_price_paise)}</Text>
              <Text className="text-xs text-ivory/80">{t('mart.pool_per_unit', { unit: pool.unit })}</Text>
              {saving > 0 && <Text className="text-xs font-semibold text-ivory">{t('mart.pool_save', { pct: saving })}</Text>}
            </View>
            <View className="mt-3"><PoolProgressBar pool={pool} /></View>
            <Text className="mt-2 text-xs text-ivory/85">{t('mart.pool_members', { count: pool.member_count })} · {t('mart.pool_closes', { date: istDate(pool.closes_at) })}</Text>
          </View>

          {member?.payment_state === 'blocked' && live && (
            <View className="flex-row flex-wrap items-center justify-between gap-2 rounded-card border border-brass bg-ivory p-3">
              <View className="flex-1">
                <Text className="text-base font-semibold text-emerald-ink">✓ {t('mart.pool_joined', { qty: member.qty, unit: pool.unit })}</Text>
                {member.amounts ? <Text className="mt-1 text-xs text-foreground-secondary">{t('mart.pool_commit_total', { amount: formatINRExact(member.amounts.totalPaise) })}</Text> : null}
              </View>
              <View className="flex-row gap-2">
                <TouchableOpacity onPress={() => setEditing((e) => !e)} className="h-10 justify-center rounded-lg border border-emerald px-3"><Text className="text-xs font-semibold text-emerald">{t('mart.pool_change')}</Text></TouchableOpacity>
                <TouchableOpacity onPress={leave} disabled={busy} className="h-10 justify-center px-3"><Text className="text-xs font-semibold text-foreground-secondary">{t('mart.pool_leave')}</Text></TouchableOpacity>
              </View>
            </View>
          )}
          {member?.payment_state === 'blocked' && pool.status === 'closed_met' && (
            <View className="rounded-card border border-brass bg-ivory p-4">
              <Text className="text-base font-semibold text-emerald-ink">{t('mart.pool_met_line')}</Text>
              {member.pay_by && <Text className="mt-1 text-xs text-foreground-secondary">{t('mart.pool_pay_by', { date: istDate(member.pay_by) })}</Text>}
              <TouchableOpacity onPress={pay} disabled={busy} accessibilityRole="button" className="mt-3 h-12 items-center justify-center rounded-button bg-gold">
                <Text className="text-base font-semibold text-emerald-ink">{busy ? '…' : member.amounts ? t('mart.pool_pay_now', { amount: formatINR(member.amounts.totalPaise) }) : t('mart.pool_pay_title')}</Text>
              </TouchableOpacity>
            </View>
          )}
          {member?.payment_state === 'captured' && (
            <TouchableOpacity onPress={() => member.order_id && router.push(`/orders/${member.order_id}` as never)} className="rounded-card border border-brass bg-ivory p-3">
              <Text className="text-base font-semibold text-emerald-ink">✓ {t('mart.pool_paid')}</Text>
            </TouchableOpacity>
          )}
          {member?.payment_state === 'failed' && <Text className="text-sm text-danger">{t('mart.pool_lapsed')}</Text>}

          {live && (!member || member.payment_state === 'released' || editing) && (
            <View className="gap-3 rounded-card border border-border bg-ivory p-4">
              <Text className="text-sm font-semibold text-emerald-ink">{t('mart.pool_join_qty', { unit: pool.unit })}</Text>
              <TextInput className="h-12 rounded-lg border border-border bg-white px-3 text-base text-ink" keyboardType="number-pad" value={qty} onChangeText={(v) => setQty(v.replace(/\D/g, ''))} />
              {/* Audit L4 — the server's per-unit price with GST; the member's total arrives with the join. */}
              {qtyN >= 1 && pool.unitDisplay ? <Text className="text-xs text-foreground-secondary">{qtyN} × {formatINRExact(pool.unitDisplay.unit_incl_gst_paise)} <Text className="font-semibold text-emerald-ink">{t('mart.incl_gst')}</Text></Text> : null}
              <Text className="text-sm font-semibold text-emerald-ink">{t('mart.delivery_title')}</Text>
              {([['contact_name', 'default'], ['contact_phone', 'phone-pad'], ['address', 'default'], ['city', 'default'], ['pincode', 'number-pad']] as const).map(([k, kb]) => (
                <TextInput key={k} className="h-12 rounded-lg border border-border bg-white px-3 text-base text-ink" placeholder={t(`mart.${k}`)} placeholderTextColor="#9CA3AF" keyboardType={kb} value={String(form[k])} onChangeText={(v) => setForm((f) => ({ ...f, [k]: v }))} />
              ))}
              <Text className="text-[11px] text-foreground-secondary">{t('mart.pool_note')}</Text>
              {error ? <Text className="text-sm text-danger">{error}</Text> : null}
              <TouchableOpacity onPress={join} disabled={busy || !formValid} accessibilityRole="button" className={`h-12 items-center justify-center rounded-button ${formValid ? 'bg-emerald' : 'bg-muted'}`}>
                <Text className={`text-base font-semibold ${formValid ? 'text-white' : 'text-foreground-secondary'}`}>{member?.payment_state === 'blocked' ? t('mart.pool_change') : t('mart.pool_join')}</Text>
              </TouchableOpacity>
            </View>
          )}
          {error && !editing && member ? <Text className="text-sm text-danger">{error}</Text> : null}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}
