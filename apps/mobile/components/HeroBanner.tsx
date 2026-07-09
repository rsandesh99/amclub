/**
 * MOBILE_PARITY §3 — CMS hero banner, RN-native rendering of the same
 * `GET /api/v1/cms/banners?slot=hero` content web shows (headline / subline /
 * CTA / discount). The "discount must be backable" rule is enforced server-
 * side; like web, the figure renders only when > 0. Decorative brand glow
 * approximated with positioned translucent circles (no gradient dep).
 */
import { useEffect, useState } from 'react'
import { Linking, Text, TouchableOpacity, View } from 'react-native'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { API_URL } from '@/lib/api'
import { colors } from '@/lib/theme'

interface I18nText { en: string; hi?: string }
interface HeroContent {
  headline: I18nText | null
  subline: I18nText | null
  ctaLabel: I18nText | null
  ctaHref: string | null
  discountPct: number | null
}

/** Web CTA paths → mobile routes. */
function mobileHref(href: string): string {
  if (href === '/services' || href === '/app/search') return '/search'
  if (href.startsWith('/services/')) return `/category/${href.split('/')[2]}`
  if (href.startsWith('/app/rfq')) return '/rfq/new'
  return '/search'
}

export function HeroBanner() {
  const { t, locale } = useI18n()
  const [hero, setHero] = useState<HeroContent | null>(null)

  useEffect(() => {
    let mounted = true
    fetch(`${API_URL}/api/v1/cms/banners?slot=hero&locale=${locale}`)
      .then((r) => (r.ok ? r.json() : { banners: [] }))
      .then((d) => {
        if (!mounted) return
        const b = (d.banners ?? []).find((x: { variant: string }) => x.variant === 'hero')
        setHero(b ?? null)
      })
      .catch(() => {}) // hero is promotional — a failed fetch just renders nothing
    return () => { mounted = false }
  }, [locale])

  if (!hero?.headline) return null
  const text = (t: I18nText | null) => (t ? (locale === 'hi' ? (t.hi ?? t.en) : t.en) : '')
  const showDiscount = typeof hero.discountPct === 'number' && hero.discountPct > 0

  function onCta() {
    const href = hero?.ctaHref ?? '/services'
    if (/^https?:\/\//.test(href)) void Linking.openURL(href)
    else router.push(mobileHref(href) as never)
  }

  return (
    <View className="overflow-hidden rounded-2xl bg-primary p-5">
      {/* decorative brand glow */}
      <View pointerEvents="none" className="absolute -right-10 -top-14 h-40 w-40 rounded-full bg-accent/20" />
      <View pointerEvents="none" className="absolute -bottom-16 left-10 h-40 w-40 rounded-full bg-white/5" />

      {showDiscount && (
        <View className="mb-2.5 flex-row">
          <View className="flex-row items-center gap-1 rounded-full bg-accent px-2.5 py-1">
            <Ionicons name="sparkles" size={12} color={colors.foreground} />
            <Text className="text-[11px] font-bold uppercase tracking-wide text-accent-foreground">
              {t('msme_home.hero_eyebrow', { pct: hero.discountPct! })}
            </Text>
          </View>
        </View>
      )}
      <Text className="text-xl font-bold leading-7 text-white">{text(hero.headline)}</Text>
      {hero.subline ? <Text className="mt-1.5 text-sm leading-5 text-white/85">{text(hero.subline)}</Text> : null}
      {hero.ctaLabel ? (
        <TouchableOpacity onPress={onCta} className="mt-4 flex-row items-center gap-1.5 self-start rounded-xl bg-accent px-4 py-2.5">
          <Text className="text-sm font-semibold text-accent-foreground">{text(hero.ctaLabel)}</Text>
          <Ionicons name="arrow-forward" size={14} color={colors.foreground} />
        </TouchableOpacity>
      ) : null}
    </View>
  )
}
