import { useEffect, useState } from 'react'
import { Text, TouchableOpacity, View } from 'react-native'
import { router } from 'expo-router'
import { HOME_ACTION_MAX, type ActionItem, type BuyAgain } from '@amclub/shared'
import { useI18n } from '@/lib/i18n'
import { fetchBuyAgainShelf, fetchMyActions } from '@/lib/api'
import { formatINR } from '@/lib/format'
import { track } from '@/lib/analytics'

/** Web deep links (§4.2) → the matching expo-router path: drop the /app prefix and any #anchor. */
function toMobile(href: string): string {
  const path = href.replace(/#.*$/, '')
  return path.startsWith('/app/') ? path.slice(4) : path
}

function deadline(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale === 'en' ? 'en-IN' : `${locale}-IN`, { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })
}

/**
 * PRD Experience v3 E9 on mobile (flag `home`, delivered as /profile/me.homeV3Enabled):
 * "Needs your action" from the SAME /api/v1/me/actions payload the web home
 * reads (order rows are the server's nextAction), then "Buy again" at the
 * server's prices. Renders nothing when both are empty.
 */
export function HomeV3Block() {
  const { t, locale } = useI18n()
  const [items, setItems] = useState<ActionItem[]>([])
  const [again, setAgain] = useState<BuyAgain[]>([])

  useEffect(() => {
    void fetchMyActions().then((a) => {
      const list = a?.buyer?.items ?? []
      setItems(list)
      track('home_viewed', { actions: list.length })
    })
    void fetchBuyAgainShelf().then(setAgain)
  }, [])

  const label = (it: ActionItem): string => {
    if (it.kind === 'order_action' && it.action) return t(`home_v3.action_${it.action}`)
    if (it.kind === 'quote_expiring') return t('home_v3.quote_expiring', { provider: it.providerName, when: it.dueAt ? deadline(it.dueAt, locale) : '' })
    if (it.kind === 'quotes_waiting') return t('home_v3.quotes_waiting', { count: it.count ?? 0, title: it.title })
    if (it.kind === 'clarification_question') return t('home_v3.clarification_question', { title: it.title })
    return it.title
  }
  const sub = (it: ActionItem): string | null => {
    if (it.kind === 'order_action' || it.kind === 'quote_expiring') return it.title
    if (it.kind === 'quotes_waiting' && it.fromPaise != null) return t('home_v3.quotes_from', { price: formatINR(it.fromPaise) })
    return null
  }
  const packages = again.filter((a): a is Extract<BuyAgain, { kind: 'package' }> => a.kind === 'package')

  if (items.length === 0 && packages.length === 0) return null
  return (
    <View className="gap-5" testID="home-v3">
      {items.length > 0 && (
        <View className="gap-2">
          <Text className="text-xs font-semibold uppercase text-foreground-secondary">{t('home_v3.needs_your_action')} · {items.length}</Text>
          <View className="overflow-hidden rounded-xl border border-gray-200 bg-surface">
            {items.slice(0, HOME_ACTION_MAX).map((it, i) => (
              <TouchableOpacity
                key={`${it.kind}-${it.objectId}`}
                onPress={() => { track('home_action_clicked', { kind: it.kind === 'order_action' && it.action ? it.action : it.kind }); router.push(toMobile(it.href) as never) }}
                className={`flex-row items-center gap-3 px-4 py-3 ${i > 0 ? 'border-t border-gray-100' : ''}`}
              >
                <View className="h-2 w-2 rounded-full bg-primary" />
                <View className="flex-1">
                  <Text className="text-sm font-medium text-foreground" numberOfLines={1}>{label(it)}</Text>
                  {sub(it) ? <Text className="text-xs text-foreground-secondary" numberOfLines={1}>{sub(it)}</Text> : null}
                </View>
                {it.dueAt && it.kind !== 'quote_expiring' ? <Text className="text-xs text-foreground-secondary">{t('home_v3.due', { when: deadline(it.dueAt, locale) })}</Text> : null}
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}
      {packages.length > 0 && (
        <View className="gap-2">
          <Text className="text-xs font-semibold uppercase text-foreground-secondary">{t('home_v3.buy_again')}</Text>
          <View className="overflow-hidden rounded-xl border border-gray-200 bg-surface">
            {packages.map((p, i) => (
              <TouchableOpacity
                key={p.orderId}
                onPress={() => { track('buy_again_clicked', { price_changed: p.priceChanged }); router.push(toMobile(p.href) as never) }}
                className={`flex-row items-center gap-3 px-4 py-3 ${i > 0 ? 'border-t border-gray-100' : ''}`}
              >
                <View className="flex-1">
                  <Text className="text-sm font-medium text-foreground" numberOfLines={1}>{p.title}</Text>
                  <Text className="text-xs text-foreground-secondary">
                    {p.priceChanged
                      ? t('home_v3.price_then_now', { then: formatINR(p.displayThen.taxablePaise), now: formatINR(p.displayNow.taxablePaise) })
                      : t('home_v3.price_now', { now: formatINR(p.displayNow.taxablePaise) })}
                  </Text>
                </View>
                <View className="rounded-lg bg-primary px-3 py-1.5"><Text className="text-xs font-semibold text-white">{t('home_v3.buy')}</Text></View>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}
    </View>
  )
}
