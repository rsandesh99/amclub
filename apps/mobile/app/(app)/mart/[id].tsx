/**
 * AMC Mart — product detail. Bulk-price table rows are the server's tier
 * displays (unit / incl. GST / after ITC) rendered verbatim.
 */
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Image, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { fetchMartProduct, type MartProduct } from '@/lib/api'
import { useMartCart } from '@/lib/mart-cart'
import { formatINRExact } from '@/lib/format'
import { colors } from '@/lib/theme'
import { ErrorState } from '@/components/ErrorState'

export default function MartProductScreen() {
  const { t } = useI18n()
  const { id } = useLocalSearchParams<{ id: string }>()
  const addToCart = useMartCart((s) => s.add)
  const cartCount = useMartCart((s) => s.lines.length)
  const [product, setProduct] = useState<MartProduct | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [qty, setQty] = useState(1)
  const [qtyText, setQtyText] = useState('1')
  const [added, setAdded] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await fetchMartProduct(id)
    setFailed(!r.ok)
    setProduct(r.product)
    if (r.product) {
      setQty(r.product.minOrderQty)
      setQtyText(String(r.product.minOrderQty))
    }
    setLoading(false)
  }, [id])

  useEffect(() => {
    void Promise.resolve().then(load)
  }, [load])

  const min = product?.minOrderQty ?? 1

  function commitQty(next: number) {
    const v = Math.max(min, Math.round(Number.isFinite(next) ? next : min))
    setQty(v)
    setQtyText(String(v))
    setAdded(false)
  }

  function add() {
    if (!product || !product.list) return
    addToCart(
      {
        productId: product.id,
        name: product.name,
        unit: product.unit,
        minOrderQty: product.minOrderQty,
        sellerId: product.seller.id,
        sellerName: product.seller.displayName,
        listUnitPricePaise: product.list.unit_price_paise,
      },
      qty,
    )
    setAdded(true)
  }

  if (loading) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" color={colors.emerald} />
      </SafeAreaView>
    )
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
        <Text className="flex-1 text-base font-bold text-ink" numberOfLines={1}>{product?.name ?? t('mart.title')}</Text>
        <TouchableOpacity
          onPress={() => router.push('/mart/cart' as never)}
          accessibilityRole="button"
          accessibilityLabel={t('mart.view_cart')}
          className="relative h-12 w-12 items-center justify-center"
        >
          <Ionicons name="cart-outline" size={22} color={colors.emeraldInk} />
          {cartCount > 0 && (
            <View className="absolute right-1 top-1 h-5 min-w-5 items-center justify-center rounded-full bg-gold px-1">
              <Text className="text-[11px] font-bold text-ink">{cartCount > 9 ? '9+' : cartCount}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {failed ? (
        <ErrorState onRetry={load} />
      ) : !product ? (
        <View className="flex-1 items-center justify-center gap-2 px-8">
          <Ionicons name="cube-outline" size={40} color={colors.brass} />
          <Text className="text-center text-base font-semibold text-ink">{t('mart.unavailable_title')}</Text>
          <Text className="text-center text-sm text-foreground-secondary">{t('mart.unavailable_body')}</Text>
          <TouchableOpacity
            onPress={() => router.replace('/mart' as never)}
            accessibilityRole="button"
            className="mt-2 h-12 justify-center rounded-button bg-emerald px-5"
          >
            <Text className="text-sm font-semibold text-white">{t('mart.browse_cta')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <ScrollView contentContainerClassName="px-4 py-4 gap-5 pb-36">
            {product.imageUrls.length > 0 && (
              <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2">
                {product.imageUrls.map((uri) => (
                  <Image
                    key={uri}
                    source={{ uri }}
                    className="h-56 w-80 rounded-card bg-muted"
                    resizeMode="cover"
                    accessibilityIgnoresInvertColors
                  />
                ))}
              </ScrollView>
            )}

            <View className="gap-1">
              <Text className="text-xl font-bold text-ink">{product.name}</Text>
              <Text className="text-sm text-foreground-secondary">
                {t('mart.sold_by')} <Text className="font-medium text-emerald">{product.seller.displayName}</Text>
                {[product.seller.city, product.seller.state].filter(Boolean).length > 0
                  ? ` · ${[product.seller.city, product.seller.state].filter(Boolean).join(', ')}`
                  : ''}
              </Text>
              <View className="mt-1 flex-row flex-wrap gap-2">
                <Tag>{`${t('mart.hsn')} ${product.hsnCode}`}</Tag>
                <Tag>{t('mart.gst_rate', { rate: product.gstRateBps / 100 })}</Tag>
                <Tag>{t('mart.min_order', { qty: product.minOrderQty, unit: product.unit })}</Tag>
              </View>
            </View>

            {/* Price hero — ivory card, brass rule, one large numeral. */}
            <View className="rounded-card border border-border border-t-2 border-t-brass bg-ivory p-4">
              {product.list ? (
                <>
                  <View className="flex-row items-baseline gap-1">
                    <Text className="text-xs text-foreground-secondary">{t('mart.from_price')}</Text>
                    <Text className="text-2xl font-bold text-emerald-ink">{formatINRExact(product.list.unit_price_paise)}</Text>
                    <Text className="text-sm text-foreground-secondary">{t('mart.per_unit', { unit: product.unit })}</Text>
                  </View>
                  <Text className="mt-0.5 text-xs text-foreground-secondary">
                    {formatINRExact(product.list.unit_incl_gst_paise)} {t('mart.incl_gst')}
                  </Text>
                  <View className="mt-3 border-t border-border pt-3">
                    <Text className="text-xs text-foreground-secondary">{t('mart.itc_label')}</Text>
                    <Text className="text-lg font-bold text-emerald">{formatINRExact(product.list.unit_after_itc_paise)}</Text>
                    <Text className="mt-1 text-xs text-foreground-secondary">{t('mart.itc_hint')}</Text>
                  </View>
                </>
              ) : (
                <Text className="text-sm text-foreground-secondary">{t('mart.unpriced')}</Text>
              )}
            </View>

            {/* Bulk pricing table */}
            {product.tiers.length > 0 && (
              <View className="gap-2">
                <Text className="text-base font-bold text-ink">{t('mart.tiers_title')}</Text>
                <View className="overflow-hidden rounded-card border border-border bg-ivory">
                  <View className="flex-row border-b border-border bg-muted px-3 py-2">
                    <Text className="w-1/4 text-xs font-semibold text-foreground-secondary">{t('mart.tier_qty')}</Text>
                    <Text className="w-1/4 text-right text-xs font-semibold text-foreground-secondary">
                      {t('mart.tier_unit_price', { unit: product.unit })}
                    </Text>
                    <Text className="w-1/4 text-right text-xs font-semibold text-foreground-secondary">{t('mart.tier_incl_gst')}</Text>
                    <Text className="w-1/4 text-right text-xs font-semibold text-foreground-secondary">{t('mart.tier_after_itc')}</Text>
                  </View>
                  {product.tiers.map((tier, i) => (
                    <View key={tier.min_qty} className={`flex-row px-3 py-2.5 ${i > 0 ? 'border-t border-border' : ''}`}>
                      <Text className="w-1/4 text-sm font-semibold text-ink">{tier.min_qty}+</Text>
                      <Text className="w-1/4 text-right text-sm text-ink">{formatINRExact(tier.unit_price_paise)}</Text>
                      <Text className="w-1/4 text-right text-sm text-ink">{formatINRExact(tier.unit_incl_gst_paise)}</Text>
                      <Text className="w-1/4 text-right text-sm font-medium text-emerald">{formatINRExact(tier.unit_after_itc_paise)}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {product.description ? (
              <View className="gap-1">
                <Text className="text-base font-bold text-ink">{t('mart.description')}</Text>
                <Text className="text-sm text-foreground">{product.description}</Text>
              </View>
            ) : null}
          </ScrollView>

          {/* Sticky: quantity stepper + the screen's one gold action. */}
          <View className="absolute inset-x-0 bottom-0 gap-3 border-t border-border bg-surface px-4 py-3">
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-medium text-ink">{t('mart.qty')}</Text>
              <View className="flex-row items-center overflow-hidden rounded-button border border-border bg-ivory">
                <TouchableOpacity
                  onPress={() => commitQty(qty - 1)}
                  disabled={qty <= min}
                  accessibilityRole="button"
                  accessibilityLabel={t('mart.decrease_qty')}
                  className="h-12 w-12 items-center justify-center"
                >
                  <Ionicons name="remove" size={22} color={qty <= min ? '#9CA3AF' : colors.emeraldInk} />
                </TouchableOpacity>
                <TextInput
                  className="h-12 w-16 text-center text-lg font-bold text-ink"
                  keyboardType="number-pad"
                  value={qtyText}
                  onChangeText={(v) => setQtyText(v.replace(/[^0-9]/g, ''))}
                  onBlur={() => commitQty(Number(qtyText))}
                  onSubmitEditing={() => commitQty(Number(qtyText))}
                  accessibilityLabel={t('mart.qty')}
                />
                <TouchableOpacity
                  onPress={() => commitQty(qty + 1)}
                  accessibilityRole="button"
                  accessibilityLabel={t('mart.increase_qty')}
                  className="h-12 w-12 items-center justify-center"
                >
                  <Ionicons name="add" size={22} color={colors.emeraldInk} />
                </TouchableOpacity>
              </View>
            </View>
            {added ? (
              <TouchableOpacity
                onPress={() => router.push('/mart/cart' as never)}
                accessibilityRole="button"
                className="h-12 flex-row items-center justify-center gap-2 rounded-button border-2 border-gold bg-ivory"
              >
                <Ionicons name="checkmark-circle" size={22} color={colors.gold} />
                <Text className="text-base font-semibold text-ink">{t('mart.added')} · {t('mart.view_cart')}</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                onPress={add}
                disabled={!product.list}
                accessibilityRole="button"
                className={`h-12 items-center justify-center rounded-button ${product.list ? 'bg-gold' : 'bg-muted'}`}
              >
                <Text className={`text-base font-bold ${product.list ? 'text-ink' : 'text-gray-400'}`}>{t('mart.add_to_cart')}</Text>
              </TouchableOpacity>
            )}
          </View>
        </>
      )}
    </SafeAreaView>
  )
}

function Tag({ children }: { children: string }) {
  return (
    <View className="rounded-chip border border-border bg-ivory px-2.5 py-1">
      <Text className="text-xs font-medium text-ink">{children}</Text>
    </View>
  )
}
