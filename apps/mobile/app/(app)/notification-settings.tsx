import { ActivityIndicator, ScrollView, Switch, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useCallback, useEffect, useRef, useState } from 'react'
import { router } from 'expo-router'
import {
  DEFAULT_QUIET_HOURS,
  NOTIFICATION_CATEGORIES,
  PAUSE_DAY_CHOICES,
  QUIET_HOURS_END_CHOICES,
  QUIET_HOURS_START_CHOICES,
  SWITCHABLE_CHANNELS,
  channelEnabled,
  essentialChannelMissing,
  isPaused,
  pauseUntilIso,
  withChannel,
  type NotificationCategory,
  type NotificationSettings,
  type SwitchableChannel,
} from '@amclub/shared'
import { useI18n } from '@/lib/i18n'
import { fetchMe, fetchNotificationSettings, saveNotificationSettings } from '@/lib/api'
import { track } from '@/lib/analytics'
import { ScreenHeader } from '@/components/ScreenHeader'

type Field = 'channel' | 'quiet_hours' | 'pause' | 'digest'
type Load = 'loading' | 'ready' | 'not_ready' | 'error'

function Chips({ values, value, onPick, label }: { values: readonly string[]; value: string; onPick: (v: string) => void; label: string }) {
  const list = values.includes(value) ? values : [...values, value].sort()
  return (
    <View className="flex-row flex-wrap gap-2" accessibilityRole="radiogroup" accessibilityLabel={label}>
      {list.map((v) => (
        <TouchableOpacity key={v} onPress={() => onPick(v)} accessibilityRole="radio" accessibilityState={{ selected: v === value }} className={`min-h-[44px] justify-center rounded-lg border px-3 ${v === value ? 'border-primary bg-primary/10' : 'border-gray-200 bg-surface'}`}>
          <Text className={`text-sm font-medium ${v === value ? 'text-primary' : 'text-foreground-secondary'}`}>{v}</Text>
        </TouchableOpacity>
      ))}
    </View>
  )
}

/**
 * Settings → Notifications on mobile (PRD_WHATSAPP W1; the web form's twin):
 * channel per category, essential categories that keep one channel, quiet
 * hours (off by default, 21:00–08:00 suggested), a pause, and for providers
 * the morning digest. Each change saves at once; a failure restores the last
 * saved settings.
 */
export default function NotificationSettingsScreen() {
  const { t, locale } = useI18n()
  const [load, setLoad] = useState<Load>('loading')
  const [settings, setSettings] = useState<NotificationSettings | null>(null)
  const [essential, setEssential] = useState<NotificationCategory[]>([])
  const [isProvider, setIsProvider] = useState(false)
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const saved = useRef<NotificationSettings | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const seq = useRef(0)

  const fetchAll = useCallback(async () => {
    setLoad('loading')
    const [r, me] = await Promise.all([fetchNotificationSettings(), fetchMe()])
    setIsProvider(me?.hasProviderProfile === true)
    if (r.kind !== 'ready') { setLoad(r.kind); return }
    saved.current = r.data.settings
    setSettings(r.data.settings)
    setEssential(r.data.essentialCategories)
    setLoad('ready')
  }, [])
  useEffect(() => { void Promise.resolve().then(fetchAll) }, [fetchAll])

  function commit(next: NotificationSettings, field: Field) {
    setSettings(next)
    setNote(null)
    const mine = ++seq.current
    queue.current = queue.current.then(async () => {
      const r = await saveNotificationSettings(next)
      if (r.ok) {
        saved.current = next
        track('notification_settings_saved', { field, platform: 'android' })
        if (mine === seq.current) setNote({ tone: 'ok', text: t('notification_settings.saved') })
        return
      }
      if (mine !== seq.current) return
      setSettings(saved.current)
      if (r.status === 422 && r.error === 'essential_needs_channel') setNote({ tone: 'error', text: t('notification_settings.essential_note') })
      else if (r.status === 503) setLoad('not_ready')
      else setNote({ tone: 'error', text: t('notification_settings.save_failed') })
    })
  }

  function setChannel(category: NotificationCategory, channel: SwitchableChannel, on: boolean) {
    if (!settings) return
    const prefs = withChannel(settings.preferences, category, channel, on)
    if (!on && essentialChannelMissing(prefs, essential.includes(category) ? [category] : [])) {
      setNote({ tone: 'error', text: t('notification_settings.essential_blocked', { category: t(`notification_settings.cat_${category}`) }) })
      return
    }
    commit({ ...settings, preferences: prefs }, 'channel')
  }

  const pausedLabel = (iso: string) =>
    new Date(iso).toLocaleString(locale === 'en' ? 'en-IN' : `${locale}-IN`, { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <ScreenHeader title={t('notification_settings.title')} />
      <ScrollView contentContainerClassName="gap-4 px-4 py-4" testID="notification-settings">
        <Text className="text-sm text-foreground-secondary">{t('notification_settings.subtitle')}</Text>
        {load === 'loading' && <View className="items-center py-8"><ActivityIndicator size="large" color="#1B4D3E" /></View>}
        {load === 'not_ready' && <View className="rounded-xl bg-primary/10 p-4" testID="notif-not-ready"><Text className="text-sm text-foreground">{t('notification_settings.not_ready')}</Text></View>}
        {load === 'error' && (
          <View className="flex-row items-center gap-3 rounded-xl border border-gray-200 bg-surface p-4">
            <Text className="flex-1 text-sm text-foreground-secondary">{t('notification_settings.load_failed')}</Text>
            <TouchableOpacity onPress={() => void fetchAll()} className="rounded-lg border border-primary px-3 py-2" accessibilityRole="button"><Text className="text-sm font-medium text-primary">{t('common.retry')}</Text></TouchableOpacity>
          </View>
        )}

        {load === 'ready' && settings && (
          <>
            {note && <Text className={`text-sm ${note.tone === 'ok' ? 'text-success' : 'text-danger'}`} accessibilityLiveRegion="polite">{note.text}</Text>}
            <Text className="text-base font-semibold text-foreground">{t('notification_settings.channels_title')}</Text>
            {NOTIFICATION_CATEGORIES.map((category) => {
              const isEssential = essential.includes(category)
              return (
                <View key={category} className="gap-2 rounded-xl border border-gray-200 bg-surface p-4" testID={`notif-cat-${category}`}>
                  <View className="flex-row flex-wrap items-center gap-2">
                    <Text className="text-sm font-semibold text-foreground">{t(`notification_settings.cat_${category}`)}</Text>
                    {isEssential && <View className="rounded-full bg-primary/10 px-2 py-0.5"><Text className="text-[11px] font-semibold text-primary">{t('notification_settings.essential_badge')}</Text></View>}
                  </View>
                  <Text className="text-xs text-foreground-secondary">{t(`notification_settings.cat_${category}_desc`)}</Text>
                  {SWITCHABLE_CHANNELS.map((channel) => (
                    <View key={channel} className="min-h-[44px] flex-row items-center justify-between">
                      <Text className="text-sm text-foreground">{t(`notification_settings.channel_${channel}`)}</Text>
                      <Switch
                        value={channelEnabled(settings.preferences, category, channel)}
                        onValueChange={(on) => setChannel(category, channel, on)}
                        accessibilityLabel={`${t(`notification_settings.cat_${category}`)} · ${t(`notification_settings.channel_${channel}`)}`}
                        trackColor={{ true: '#1B4D3E', false: '#D1D5DB' }}
                        testID={`notif-${category}-${channel}`}
                      />
                    </View>
                  ))}
                  <View className="min-h-[44px] flex-row items-center justify-between opacity-60">
                    <Text className="text-sm text-foreground">{t('notification_settings.channel_push')}</Text>
                    <Text className="text-xs text-foreground-secondary">{t('notification_settings.push_soon')}</Text>
                  </View>
                  {isEssential && <Text className="text-xs text-foreground-secondary">{t('notification_settings.essential_note')}</Text>}
                </View>
              )
            })}
            <TouchableOpacity onPress={() => router.push('/whatsapp-settings' as never)} accessibilityRole="link" className="min-h-[44px] justify-center">
              <Text className="text-xs text-foreground-secondary">{t('notification_settings.whatsapp_needs_optin')} <Text className="font-medium text-primary">{t('notification_settings.whatsapp_manage')}</Text></Text>
            </TouchableOpacity>

            <View className="gap-3 rounded-xl border border-gray-200 bg-surface p-4">
              <View className="flex-row items-start gap-3">
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-foreground">{t('notification_settings.quiet_title')}</Text>
                  <Text className="mt-0.5 text-xs text-foreground-secondary">{t('notification_settings.quiet_body')}</Text>
                </View>
                <Switch
                  value={!!settings.quietHours}
                  onValueChange={(on) => commit({ ...settings, quietHours: on ? { ...DEFAULT_QUIET_HOURS } : null }, 'quiet_hours')}
                  accessibilityLabel={t('notification_settings.quiet_title')}
                  trackColor={{ true: '#1B4D3E', false: '#D1D5DB' }}
                  testID="notif-quiet"
                />
              </View>
              {settings.quietHours && (
                <>
                  <Text className="text-sm font-medium text-foreground">{t('notification_settings.quiet_summary', { start: settings.quietHours.start, end: settings.quietHours.end })}</Text>
                  <Text className="text-xs text-foreground-secondary">{t('notification_settings.quiet_from')}</Text>
                  <Chips values={QUIET_HOURS_START_CHOICES} value={settings.quietHours.start} label={t('notification_settings.quiet_from')} onPick={(v) => commit({ ...settings, quietHours: { ...settings.quietHours!, start: v } }, 'quiet_hours')} />
                  <Text className="text-xs text-foreground-secondary">{t('notification_settings.quiet_to')}</Text>
                  <Chips values={QUIET_HOURS_END_CHOICES} value={settings.quietHours.end} label={t('notification_settings.quiet_to')} onPick={(v) => commit({ ...settings, quietHours: { ...settings.quietHours!, end: v } }, 'quiet_hours')} />
                </>
              )}
            </View>

            <View className="gap-3 rounded-xl border border-gray-200 bg-surface p-4">
              <Text className="text-sm font-semibold text-foreground">{t('notification_settings.pause_title')}</Text>
              <Text className="text-xs text-foreground-secondary">{t('notification_settings.pause_body')}</Text>
              {settings.pausedUntil && isPaused(settings.pausedUntil, new Date()) ? (
                <View className="flex-row flex-wrap items-center gap-3" testID="notif-paused">
                  <Text className="text-sm font-medium text-foreground">{t('notification_settings.paused_until', { date: pausedLabel(settings.pausedUntil) })}</Text>
                  <TouchableOpacity onPress={() => commit({ ...settings, pausedUntil: null }, 'pause')} className="min-h-[44px] justify-center rounded-lg border border-primary px-3" accessibilityRole="button">
                    <Text className="text-sm font-medium text-primary">{t('notification_settings.resume')}</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View className="flex-row flex-wrap gap-2">
                  {PAUSE_DAY_CHOICES.map((days) => (
                    <TouchableOpacity key={days} onPress={() => commit({ ...settings, pausedUntil: pauseUntilIso(days, new Date()) }, 'pause')} className="min-h-[44px] justify-center rounded-lg border border-gray-200 bg-surface px-3" accessibilityRole="button" testID={`notif-pause-${days}`}>
                      <Text className="text-sm font-medium text-foreground">{t(days === 1 ? 'notification_settings.pause_day' : 'notification_settings.pause_days', { days })}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            {isProvider && (
              <View className="flex-row items-start gap-3 rounded-xl border border-gray-200 bg-surface p-4">
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-foreground">{t('notification_settings.digest_title')}</Text>
                  <Text className="mt-0.5 text-xs text-foreground-secondary">{t('notification_settings.digest_body')}</Text>
                </View>
                <Switch
                  value={settings.digestLeads}
                  onValueChange={(on) => commit({ ...settings, digestLeads: on }, 'digest')}
                  accessibilityLabel={t('notification_settings.digest_title')}
                  trackColor={{ true: '#1B4D3E', false: '#D1D5DB' }}
                  testID="notif-digest"
                />
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}
