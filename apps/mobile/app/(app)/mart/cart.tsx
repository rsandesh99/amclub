/**
 * AMC Mart — cart + goods checkout. One seller per checkout session; the
 * client sends product ids + quantities + delivery, and renders the server's
 * amounts (taxable / GST / total / after-ITC) before the single Pay action.
 * Mirrors checkout/[packageId].tsx: simulated gateway → simulatePay →
 * /orders/{id}; real Razorpay note otherwise.
 */
import { useState } from 'react'
import { Alert, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { INDIAN_STATES } from '@amclub/shared'
import { useI18n } from '@/lib/i18n'
import { createGoodsCheckout, simulatePay, type GoodsCheckoutResponse, type GoodsDelivery } from '@/lib/api'
import { groupBySeller, useMartCart, type MartCartLine } from '@/lib/mart-cart'
import { formatINR, formatINRExact } from '@/lib/format'
import { colors } from '@/lib/theme'
import { Select } from '@/components/ui/Select'
import { confirmHaptic } from '@/lib/haptics'

type FormErrors = Partial<Record<keyof GoodsDelivery, string>>

const PHONE_RE = /^[6-9]\d{9}$/
const PIN_RE = /^\d{6}$/

export default function MartCartScreen() {
  const { t } = useI18n()
  const lines = useMartCart((s) => s.lines)
  const setQty = useMartCart((s) => s.setQty)
  const remove = useMartCart((s) => s.remove)
  const removeMany = useMartCart((s) => s.removeMany)

  const groups = groupBySeller(lines)
  const [sellerPick, setSellerPick] = useState<string | null>(null)
  const active = groups.find((g) => g.sellerId === sellerPick) ?? groups[0] ?? null
  const activeLines: MartCartLine[] = active?.lines ?? []

  const [form, setForm] = useState<GoodsDelivery>({
    contact_name: '',
    contact_phone: '',
    address: '',
    city: '',
    state: '',
    pincode: '',
    pickup: false,
  })
  const [errors, setErrors] = useState<FormErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const [session, setSession] = useState<GoodsCheckoutResponse | null>(null)
  const [paying, setPaying] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  function update<K extends keyof GoodsDelivery>(key: K, value: GoodsDelivery[K]) {
    setForm((f) => ({ ...f, [key]: value }))
    setErrors((e) => ({ ...e, [key]: undefined }))
    setSession(null)
  }

  // Any cart edit invalidates a priced session — the server re-prices on the next checkout.
  function changeQty(line: MartCartLine, next: number) {
    setQty(line.productId, Math.max(line.minOrderQty, next))
    setSession(null)
  }
  function removeLine(productId: string) {
    remove(productId)
    setSession(null)
  }

  function validate(): boolean {
    const e: FormErrors = {}
    if (form.contact_name.trim().length < 2) e.contact_name = t('mart.err_contact_name')
    if (!PHONE_RE.test(form.contact_phone)) e.contact_phone = t('errors.invalid_phone')
    if (form.address.trim().length < 5) e.address = t('mart.err_address')
    if (form.city.trim().length < 2) e.city = t('mart.err_city')
    if (!form.state) e.state = t('mart.err_state')
    if (!PIN_RE.test(form.pincode)) e.pincode = t('mart.err_pincode')
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function checkout() {
    if (!active || activeLines.length === 0) return
    if (!validate()) return
    setSubmitting(true)
    setServerError(null)
    confirmHaptic()
    const r = await createGoodsCheckout({
      items: activeLines.map((l) => ({ product_id: l.productId, qty: l.qty })),
      delivery: {
        contact_name: form.contact_name.trim(),
        contact_phone: form.contact_phone,
        address: form.address.trim(),
        city: form.city.trim(),
        state: form.state,
        pincode: form.pincode,
        pickup: form.pickup,
      },
    })
    setSubmitting(false)
    if (r.ok) {
      setSession(r.data)
      return
    }
    setServerError(mapCheckoutError(r.status, r.errorCode, t))
  }

  async function pay() {
    if (!session) return
    setPaying(true)
    try {
      if (session.simulated) {
        const sim = await simulatePay(session.checkoutSessionId)
        if (!sim.ok) throw new Error(t('errors.payment_failed'))
        removeMany(activeLines.map((l) => l.productId))
        router.replace(`/orders/${sim.data.orderId}` as never)
        return
      }
      // Real Razorpay on mobile is wired when keys are provisioned (WebView/native sheet).
      Alert.alert(t('mart.checkout_title'), t('checkout.real_pay_note'))
    } catch (e) {
      Alert.alert(t('common.error'), e instanceof Error ? e.message : t('errors.generic'))
    } finally {
      setPaying(false)
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center gap-2 border-b border-border bg-surface px-4 py-3">
        <TouchableOpacity
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          className="h-12 w-12 items-center justify-center"
        >
          <Ionicons name="arrow-back" size={22} color={colors.ink} />
        </TouchableOpacity>
        <View className="flex-1">
          <Text className="text-lg font-bold text-ink">{t('mart.cart_title')}</Text>
          {lines.length > 0 && (
            <Text className="text-xs text-foreground-secondary">{t('mart.cart_items', { count: lines.length })}</Text>
          )}
        </View>
      </View>

      {lines.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-2 px-8">
          <Ionicons name="cart-outline" size={40} color={colors.brass} />
          <Text className="text-center text-base font-semibold text-ink">{t('mart.cart_empty_title')}</Text>
          <Text className="text-center text-sm text-foreground-secondary">{t('mart.cart_empty_body')}</Text>
          <TouchableOpacity
            onPress={() => router.replace('/mart' as never)}
            accessibilityRole="button"
            className="mt-2 h-12 justify-center rounded-button bg-emerald px-5"
          >
            <Text className="text-sm font-semibold text-white">{t('mart.browse_cta')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerClassName="px-4 py-4 gap-5 pb-12" keyboardShouldPersistTaps="handled">
          {/* One seller per checkout */}
          {groups.length > 1 && (
            <View className="gap-2 rounded-card border border-gold/60 bg-ivory p-4">
              <Text className="text-sm text-ink">{t('mart.one_seller_note')}</Text>
              <View className="flex-row flex-wrap gap-2">
                {groups.map((g) => {
                  const on = g.sellerId === active?.sellerId
                  return (
                    <TouchableOpacity
                      key={g.sellerId}
                      onPress={() => { setSellerPick(g.sellerId); setSession(null) }}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      className={`min-h-10 justify-center rounded-chip border px-4 ${on ? 'border-emerald bg-emerald' : 'border-border bg-surface'}`}
                    >
                      <Text className={`text-xs font-medium ${on ? 'text-white' : 'text-ink'}`}>
                        {g.sellerName} · {g.lines.length}
                      </Text>
                    </TouchableOpacity>
                  )
                })}
              </View>
            </View>
          )}

          {active && (
            <View className="gap-3">
              <Text className="text-sm font-semibold text-emerald-ink">
                {t('mart.checking_out_seller', { seller: active.sellerName })}
              </Text>
              {activeLines.map((line) => (
                <View key={line.productId} className="gap-2 rounded-card border border-border border-t-2 border-t-brass bg-ivory p-3">
                  <View className="flex-row items-start gap-2">
                    <View className="flex-1">
                      <Text className="text-sm font-semibold text-ink" numberOfLines={2}>{line.name}</Text>
                      {line.listUnitPricePaise !== null && (
                        <Text className="text-xs text-foreground-secondary">
                          {t('mart.from_price')} {formatINRExact(line.listUnitPricePaise)} {t('mart.per_unit', { unit: line.unit })}
                        </Text>
                      )}
                    </View>
                    <TouchableOpacity
                      onPress={() => removeLine(line.productId)}
                      accessibilityRole="button"
                      accessibilityLabel={`${t('mart.remove')} ${line.name}`}
                      className="h-12 w-12 items-center justify-center"
                    >
                      <Ionicons name="trash-outline" size={20} color={colors.danger} />
                    </TouchableOpacity>
                  </View>
                  <View className="flex-row items-center justify-between">
                    <Text className="text-xs text-foreground-secondary">
                      {t('mart.min_order', { qty: line.minOrderQty, unit: line.unit })}
                    </Text>
                    <View className="flex-row items-center overflow-hidden rounded-button border border-border bg-surface">
                      <TouchableOpacity
                        onPress={() => changeQty(line, line.qty - 1)}
                        disabled={line.qty <= line.minOrderQty}
                        accessibilityRole="button"
                        accessibilityLabel={t('mart.decrease_qty')}
                        className="h-12 w-12 items-center justify-center"
                      >
                        <Ionicons name="remove" size={20} color={line.qty <= line.minOrderQty ? '#9CA3AF' : colors.emeraldInk} />
                      </TouchableOpacity>
                      <Text className="w-12 text-center text-base font-bold text-ink" accessibilityLabel={`${t('mart.qty')} ${line.qty}`}>
                        {line.qty}
                      </Text>
                      <TouchableOpacity
                        onPress={() => changeQty(line, line.qty + 1)}
                        accessibilityRole="button"
                        accessibilityLabel={t('mart.increase_qty')}
                        className="h-12 w-12 items-center justify-center"
                      >
                        <Ionicons name="add" size={20} color={colors.emeraldInk} />
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* Delivery */}
          <View className="gap-3">
            <View>
              <Text className="text-base font-bold text-ink">{t('mart.delivery_title')}</Text>
              <Text className="text-xs text-foreground-secondary">{t('mart.checkout_subtitle')}</Text>
            </View>
            <Field label={t('mart.contact_name')} error={errors.contact_name}>
              <TextInput
                className="h-12 rounded-button border border-border bg-surface px-3 text-sm text-ink"
                value={form.contact_name}
                onChangeText={(v) => update('contact_name', v)}
                autoCapitalize="words"
                accessibilityLabel={t('mart.contact_name')}
              />
            </Field>
            <Field label={t('mart.contact_phone')} error={errors.contact_phone}>
              <TextInput
                className="h-12 rounded-button border border-border bg-surface px-3 text-sm text-ink"
                value={form.contact_phone}
                onChangeText={(v) => update('contact_phone', v.replace(/[^0-9]/g, '').slice(0, 10))}
                keyboardType="phone-pad"
                maxLength={10}
                accessibilityLabel={t('mart.contact_phone')}
              />
            </Field>
            <Field label={t('mart.address')} error={errors.address}>
              <TextInput
                className="min-h-20 rounded-button border border-border bg-surface px-3 py-2 text-sm text-ink"
                value={form.address}
                onChangeText={(v) => update('address', v)}
                multiline
                textAlignVertical="top"
                accessibilityLabel={t('mart.address')}
              />
            </Field>
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Field label={t('mart.city')} error={errors.city}>
                  <TextInput
                    className="h-12 rounded-button border border-border bg-surface px-3 text-sm text-ink"
                    value={form.city}
                    onChangeText={(v) => update('city', v)}
                    autoCapitalize="words"
                    accessibilityLabel={t('mart.city')}
                  />
                </Field>
              </View>
              <View className="w-32">
                <Field label={t('mart.pincode')} error={errors.pincode}>
                  <TextInput
                    className="h-12 rounded-button border border-border bg-surface px-3 text-sm text-ink"
                    value={form.pincode}
                    onChangeText={(v) => update('pincode', v.replace(/[^0-9]/g, '').slice(0, 6))}
                    keyboardType="number-pad"
                    maxLength={6}
                    accessibilityLabel={t('mart.pincode')}
                  />
                </Field>
              </View>
            </View>
            <Field label={t('mart.state')} error={errors.state}>
              <Select
                value={form.state}
                placeholder={t('mart.select_state')}
                accessibilityLabel={t('mart.state')}
                options={INDIAN_STATES.map((s) => ({ value: s.value, label: s.label }))}
                onChange={(v) => update('state', v)}
              />
            </Field>
            <View className="flex-row items-center justify-between gap-3 rounded-card border border-border bg-ivory p-3">
              <View className="flex-1">
                <Text className="text-sm font-medium text-ink">{t('mart.pickup')}</Text>
                <Text className="text-xs text-foreground-secondary">{t('mart.pickup_hint')}</Text>
              </View>
              <Switch
                value={form.pickup}
                onValueChange={(v) => update('pickup', v)}
                trackColor={{ true: colors.emerald, false: colors.border }}
                accessibilityLabel={t('mart.pickup')}
              />
            </View>
          </View>

          {serverError && (
            <View className="rounded-card border border-red-300 bg-red-50 p-3">
              <Text className="text-sm text-red-800">{serverError}</Text>
            </View>
          )}

          {/* Step 1: price the cart on the server. Step 2: show its amounts, then the single gold Pay. */}
          {!session ? (
            <TouchableOpacity
              onPress={checkout}
              disabled={submitting || activeLines.length === 0}
              accessibilityRole="button"
              className={`h-12 items-center justify-center rounded-button ${submitting ? 'bg-emerald/60' : 'bg-emerald'}`}
            >
              <Text className="text-base font-semibold text-white">{submitting ? t('mart.pricing_cart') : t('mart.checkout_cta')}</Text>
            </TouchableOpacity>
          ) : (
            <View className="gap-3 rounded-card border border-border border-t-2 border-t-brass bg-ivory p-4">
              <Text className="text-base font-bold text-ink">{t('mart.review_title')}</Text>
              {session.sellerName ? (
                <Text className="text-xs text-foreground-secondary">{t('mart.seller_label')}: {session.sellerName}</Text>
              ) : null}
              {session.amounts && (
                <View className="gap-1 border-t border-border pt-3">
                  <Row label={t('mart.subtotal')} value={formatINRExact(session.amounts.taxablePaise)} />
                  <Row label={t('mart.gst')} value={formatINRExact(session.amounts.gstPaise)} />
                  <View className="mt-1 flex-row items-baseline justify-between border-t border-border pt-2">
                    <Text className="text-base font-bold text-ink">{t('mart.total')}</Text>
                    <Text className="text-xl font-bold text-brass">{formatINRExact(session.amounts.totalPaise)}</Text>
                  </View>
                  <Row label={t('mart.after_itc')} value={formatINRExact(session.amounts.afterItcPaise)} emphasis />
                </View>
              )}
              {typeof session.deliveryDays === 'number' && !form.pickup && (
                <Text className="text-xs text-foreground-secondary">{t('mart.delivery_days', { days: session.deliveryDays })}</Text>
              )}
              <Text className="text-xs text-foreground-secondary">{t('mart.secure_note')}</Text>
              <TouchableOpacity
                onPress={pay}
                disabled={paying}
                accessibilityRole="button"
                className={`h-12 items-center justify-center rounded-button ${paying ? 'bg-gold/60' : 'bg-gold'}`}
              >
                <Text className="text-base font-bold text-ink">
                  {paying ? t('common.loading') : t('mart.pay', { amount: formatINR(session.amountPaise) })}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setSession(null)} accessibilityRole="button" className="h-12 items-center justify-center">
                <Text className="text-sm font-medium text-emerald">{t('mart.edit_cart')}</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}

function mapCheckoutError(status: number, code: string | null, t: (k: string) => string): string {
  switch (code) {
    case 'product_unavailable':
      return t('mart.item_unavailable')
    case 'multiple_sellers':
      return t('mart.multiple_sellers')
    case 'below_min_qty':
      return t('mart.below_min_qty')
    case 'category_blocked':
      return t('mart.category_blocked')
    case 'no_tier':
      return t('mart.no_tier')
    default:
      break
  }
  if (status === 0) return t('errors.network')
  if (status === 403) return t('mart.profile_required')
  return t('mart.failed')
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <View className="gap-1">
      <Text className="text-xs font-medium text-ink">{label}</Text>
      {children}
      {error ? <Text className="text-xs text-danger">{error}</Text> : null}
    </View>
  )
}

function Row({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <View className="flex-row justify-between">
      <Text className={`text-sm ${emphasis ? 'font-medium text-emerald' : 'text-foreground-secondary'}`}>{label}</Text>
      <Text className={`text-sm ${emphasis ? 'font-semibold text-emerald' : 'text-ink'}`}>{value}</Text>
    </View>
  )
}
