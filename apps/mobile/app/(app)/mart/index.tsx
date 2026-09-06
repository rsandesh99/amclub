/**
 * AMC Mart — browse (goods mode, dark build). Category chips + search over
 * GET /api/v1/mart/products; every price on screen is the server's paise.
 */
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { pickLocale } from '@amclub/shared'
import { useI18n } from '@/lib/i18n'
import { fetchMartCategories, searchMartProducts, type MartCategory, type MartProduct } from '@/lib/api'
import { useMartCart } from '@/lib/mart-cart'
import { colors } from '@/lib/theme'
import { ErrorState } from '@/components/ErrorState'
import { MartProductCard } from '@/components/mart/ProductCard'

const PAGE = 24

export default function MartBrowseScreen() {
  const { t, locale } = useI18n()
  const cartCount = useMartCart((s) => s.lines.length)
  const [categories, setCategories] = useState<MartCategory[]>([])
  const [category, setCategory] = useState('')
  const [q, setQ] = useState('')
  const [products, setProducts] = useState<MartProduct[]>([])
  const [total, setTotal] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)

  const run = useCallback(async (query: string, cat: string) => {
    setLoading(true)
    const r = await searchMartProducts({ ...(query ? { query } : {}), ...(cat ? { category: cat } : {}), limit: PAGE })
    setFailed(!r.ok)
    setProducts(r.products)
    setTotal(r.total)
    setNextOffset(r.nextOffset)
    setLoading(false)
  }, [])

  async function loadMore() {
    if (nextOffset === null || loadingMore) return
    setLoadingMore(true)
    const r = await searchMartProducts({
      ...(q.trim() ? { query: q.trim() } : {}),
      ...(category ? { category } : {}),
      limit: PAGE,
      offset: nextOffset,
    })
    if (r.ok) {
      setProducts((prev) => [...prev, ...r.products])
      setNextOffset(r.nextOffset)
    }
    setLoadingMore(false)
  }

  // Deferred so setState stays off the effect's synchronous path
  // (react-hooks/set-state-in-effect); run is also the submit handler.
  useEffect(() => {
    void Promise.resolve().then(async () => {
      const c = await fetchMartCategories()
      if (c.ok) setCategories(c.categories)
      await run('', '')
    })
  }, [run])

  function pickCategory(slug: string) {
    setCategory(slug)
    void run(q.trim(), slug)
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="gap-3 border-b border-border bg-surface px-4 py-3">
        <View className="flex-row items-center justify-between">
          <View className="flex-1">
            <Text className="text-xl font-bold text-emerald-ink">{t('mart.title')}</Text>
            <Text className="text-xs text-foreground-secondary" numberOfLines={2}>{t('mart.subtitle')}</Text>
          </View>
          <TouchableOpacity
            onPress={() => router.push('/mart/pools' as never)}
            accessibilityRole="button"
            accessibilityLabel={t('mart.pools_title')}
            className="mr-2 h-12 w-12 items-center justify-center rounded-button border border-border bg-ivory"
          >
            <Ionicons name="people-outline" size={22} color={colors.emeraldInk} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.push('/mart/cart' as never)}
            accessibilityRole="button"
            accessibilityLabel={t('mart.view_cart')}
            className="relative h-12 w-12 items-center justify-center rounded-button border border-border bg-ivory"
          >
            <Ionicons name="cart-outline" size={22} color={colors.emeraldInk} />
            {cartCount > 0 && (
              <View className="absolute -right-1 -top-1 h-5 min-w-5 items-center justify-center rounded-full bg-gold px-1">
                <Text className="text-[11px] font-bold text-ink">{cartCount > 9 ? '9+' : cartCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>

        {/* Search */}
        <View className="flex-row items-center gap-2 rounded-xl border border-border bg-ivory px-3 py-1.5">
          <Ionicons name="search-outline" size={18} color={colors.foregroundSecondary} />
          <TextInput
            className="flex-1 text-sm text-ink"
            placeholder={t('mart.search_placeholder')}
            placeholderTextColor="#9CA3AF"
            value={q}
            onChangeText={setQ}
            onSubmitEditing={() => run(q.trim(), category)}
            returnKeyType="search"
            accessibilityLabel={t('mart.search_placeholder')}
          />
          <TouchableOpacity
            onPress={() => run(q.trim(), category)}
            accessibilityRole="button"
            className="min-h-10 justify-center rounded-lg bg-emerald px-3"
          >
            <Text className="text-xs font-semibold text-white">{t('mart.search_btn')}</Text>
          </TouchableOpacity>
        </View>

        {/* Category chips — BIS-blocked categories are shown greyed and inert. */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2">
          <Chip label={t('mart.all_categories')} active={category === ''} onPress={() => pickCategory('')} />
          {categories.map((c) => (
            <Chip
              key={c.slug}
              label={pickLocale(c.nameI18n, locale)}
              active={category === c.slug}
              disabled={c.bisBlocked}
              hint={c.bisBlocked ? t('mart.blocked_category') : undefined}
              onPress={() => pickCategory(c.slug)}
            />
          ))}
        </ScrollView>
      </View>

      {loading ? (
        <View className="gap-3 px-4 py-4">
          {[0, 1, 2, 3].map((i) => <SkeletonCard key={i} />)}
        </View>
      ) : failed ? (
        <ErrorState onRetry={() => run(q.trim(), category)} />
      ) : products.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-2 px-8">
          <Ionicons name="storefront-outline" size={40} color={colors.brass} />
          <Text className="text-center text-base font-semibold text-ink">{t('mart.no_products_title')}</Text>
          <Text className="text-center text-sm text-foreground-secondary">{t('mart.no_products_body')}</Text>
        </View>
      ) : (
        <ScrollView contentContainerClassName="px-4 py-4 gap-3 pb-10">
          <Text className="text-xs text-foreground-secondary">{t('mart.results_count', { count: total })}</Text>
          {products.map((p) => <MartProductCard key={p.id} product={p} />)}
          {nextOffset !== null && (
            <TouchableOpacity
              onPress={loadMore}
              disabled={loadingMore}
              accessibilityRole="button"
              className="mt-1 h-12 items-center justify-center rounded-button border border-emerald bg-surface"
            >
              {loadingMore ? (
                <ActivityIndicator color={colors.emerald} />
              ) : (
                <Text className="text-sm font-semibold text-emerald">{t('mart.load_more')}</Text>
              )}
            </TouchableOpacity>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}

function Chip({
  label,
  active,
  disabled,
  hint,
  onPress,
}: {
  label: string
  active: boolean
  disabled?: boolean
  hint?: string
  onPress: () => void
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled: !!disabled }}
      accessibilityLabel={hint ? `${label} — ${hint}` : label}
      className={`min-h-10 justify-center rounded-chip border px-4 ${
        disabled ? 'border-border bg-muted' : active ? 'border-emerald bg-emerald' : 'border-border bg-ivory'
      }`}
    >
      <Text className={`text-xs font-medium ${disabled ? 'text-gray-400' : active ? 'text-white' : 'text-ink'}`}>{label}</Text>
    </TouchableOpacity>
  )
}

function SkeletonCard() {
  return (
    <View className="flex-row gap-3 rounded-card border border-border border-t-2 border-t-brass bg-ivory p-3">
      <View className="h-20 w-20 rounded-lg bg-muted" />
      <View className="flex-1 gap-2 py-1">
        <View className="h-4 w-4/5 rounded bg-muted" />
        <View className="h-3 w-3/5 rounded bg-muted" />
        <View className="mt-2 h-5 w-2/5 rounded bg-muted" />
        <View className="h-3 w-1/2 rounded bg-muted" />
      </View>
    </View>
  )
}
