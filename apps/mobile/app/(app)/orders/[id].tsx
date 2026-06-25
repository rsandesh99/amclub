import { ScrollView, Text, View, ActivityIndicator, TouchableOpacity, Alert } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useEffect, useCallback } from 'react'
import { useLocalSearchParams, router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { fetchOrder, transitionOrder } from '@/lib/api'
import { formatINR } from '@/lib/format'

/* eslint-disable @typescript-eslint/no-explicit-any */
function actionsFor(role: string, status: string) {
  if (role === 'provider') {
    if (status === 'placed') return [{ action: 'accept', label: 'Accept order' }]
    if (status === 'requirements_submitted') return [{ action: 'start', label: 'Start work' }]
    if (status === 'in_progress') return [{ action: 'deliver', label: 'Mark delivered' }]
    if (status === 'revision_requested') return [{ action: 'resume', label: 'Resume work' }]
  } else {
    if (status === 'accepted') return [{ action: 'submit_requirements', label: 'Submit requirements' }]
    if (status === 'delivered') return [{ action: 'accept_delivery', label: 'Accept delivery' }, { action: 'request_revision', label: 'Request revision' }]
    if (status === 'placed' || status === 'accepted') return [{ action: 'cancel', label: 'Cancel order' }]
  }
  return []
}

export default function OrderScreen() {
  const { t } = useI18n()
  const { id } = useLocalSearchParams<{ id: string }>()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const d = await fetchOrder(id)
    setData(d)
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  async function act(action: string) {
    setBusy(true)
    const { ok, data: res } = await transitionOrder(id, action)
    setBusy(false)
    if (!ok) { Alert.alert('Error', res.error ?? 'Action failed'); return }
    load()
  }

  if (loading) return <SafeAreaView className="flex-1 items-center justify-center bg-background"><ActivityIndicator size="large" color="#1B4D3E" /></SafeAreaView>
  if (!data?.order) return <SafeAreaView className="flex-1 items-center justify-center bg-background"><Text className="text-foreground-secondary">Not found</Text></SafeAreaView>

  const o = data.order
  const actions = actionsFor(data.viewerRole, o.status)

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center gap-2 border-b border-gray-200 bg-surface px-4 py-3">
        <TouchableOpacity onPress={() => router.back()}><Ionicons name="arrow-back" size={22} color="#1A1D1A" /></TouchableOpacity>
        <Text className="flex-1 text-lg font-bold text-foreground" numberOfLines={1}>{o.title}</Text>
      </View>

      <ScrollView contentContainerClassName="px-4 py-4 gap-4">
        <View className="rounded-xl border border-gray-200 bg-surface p-4">
          <Text className="text-xs text-foreground-secondary">{o.order_number}</Text>
          <View className="mt-1 flex-row items-center justify-between">
            <Text className="text-base font-bold text-foreground">{formatINR(Number(o.total_paise))}</Text>
            <View className="rounded-full bg-primary/10 px-3 py-1"><Text className="text-xs font-semibold text-primary">{t(`orders.status_${o.status}` as 'orders.status_placed')}</Text></View>
          </View>
        </View>

        {actions.length > 0 && (
          <View className="rounded-xl border border-gray-200 bg-surface p-4 gap-2">
            <Text className="text-sm font-semibold text-foreground">{t('orders.actions')}</Text>
            {actions.map((a) => (
              <TouchableOpacity key={a.action} onPress={() => act(a.action)} disabled={busy} className={`items-center rounded-lg py-3 ${busy ? 'bg-primary/60' : 'bg-primary'}`}>
                <Text className="text-sm font-semibold text-white">{a.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View className="rounded-xl border border-gray-200 bg-surface p-4">
          <Text className="mb-2 text-sm font-semibold text-foreground">{t('orders.timeline')}</Text>
          {(data.events ?? []).map((e: any) => (
            <View key={e.id} className="mb-2 flex-row gap-2">
              <View className="mt-1.5 h-2 w-2 rounded-full bg-primary" />
              <View>
                <Text className="text-sm capitalize text-foreground">{String(e.event).replace(/_/g, ' ')}</Text>
                <Text className="text-xs text-foreground-secondary">{new Date(e.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */
