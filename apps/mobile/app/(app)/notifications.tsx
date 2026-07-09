import { ScrollView, Text, View, TouchableOpacity, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useEffect } from 'react'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { fetchNotifications, markNotificationRead, type NotificationItem } from '@/lib/api'
import { ErrorState } from '@/components/ErrorState'

export default function NotificationsScreen() {
  const { t, locale } = useI18n()
  const [items, setItems] = useState<NotificationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  function load() {
    setLoading(true)
    // .then keeps setState off the effect's synchronous path (react-hooks/set-state-in-effect).
    fetchNotifications().then((d) => {
      setFailed(!d.ok)
      setItems(d.notifications)
      setLoading(false)
    })
  }

  // Deferred so load()'s setState stays off the effect's synchronous path
  // (react-hooks/set-state-in-effect); load is also the retry handler.
  useEffect(() => { void Promise.resolve().then(load) }, [])

  async function open(n: NotificationItem) {
    if (!n.read_at) {
      await markNotificationRead({ id: n.id })
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)))
    }
    if (n.link) router.push(mobileLink(n.link) as never)
  }

  async function markAll() {
    await markNotificationRead({ all: true })
    setItems((prev) => prev.map((x) => ({ ...x, read_at: new Date().toISOString() })))
  }

  const unread = items.filter((n) => !n.read_at).length

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center gap-2 border-b border-gray-200 bg-surface px-4 py-3">
        <TouchableOpacity onPress={() => router.back()}><Ionicons name="arrow-back" size={22} color="#1A1D1A" /></TouchableOpacity>
        <Text className="flex-1 text-lg font-bold text-foreground">{t('notifications.title')}</Text>
        {unread > 0 && (
          <TouchableOpacity onPress={markAll}><Text className="text-sm text-trust">{t('notifications.mark_all_read')}</Text></TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View className="flex-1 items-center justify-center"><ActivityIndicator size="large" color="#1B4D3E" /></View>
      ) : failed ? (
        <ErrorState onRetry={load} />
      ) : items.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-2 px-8">
          <Text className="text-4xl">🔔</Text>
          <Text className="text-center text-sm text-foreground-secondary">{t('notifications.empty')}</Text>
        </View>
      ) : (
        <ScrollView contentContainerClassName="px-4 py-3 gap-2">
          {items.map((n) => (
            <TouchableOpacity
              key={n.id}
              onPress={() => open(n)}
              className={`flex-row gap-3 rounded-xl border p-4 ${n.read_at ? 'border-gray-200 bg-surface' : 'border-primary/30 bg-primary/5'}`}
            >
              {!n.read_at && <View className="mt-1.5 h-2 w-2 rounded-full bg-primary" />}
              <View className="flex-1">
                <Text className="text-sm font-semibold text-foreground">{n.title_i18n?.[locale] ?? n.title_i18n?.en}</Text>
                <Text className="text-sm text-foreground-secondary">{n.body_i18n?.[locale] ?? n.body_i18n?.en}</Text>
                <Text className="mt-1 text-xs text-foreground-secondary">{new Date(n.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</Text>
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}

/** Map web app-relative links to the mobile route equivalents. */
function mobileLink(link: string): string {
  if (link.startsWith('/app/orders/')) return `/orders/${link.split('/').pop()}`
  if (link.startsWith('/partner/orders/')) return `/orders/${link.split('/').pop()}`
  if (link.startsWith('/app/rfq/')) return `/rfq/${link.split('/').pop()}`
  if (link.startsWith('/partner/rfqs')) return '/partner-rfqs'
  if (link.startsWith('/partner/earnings')) return '/partner'
  return '/'
}
