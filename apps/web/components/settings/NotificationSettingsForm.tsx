'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { BellRing, Check, Moon, PauseCircle } from 'lucide-react'
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
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { SegmentedControl } from '@/components/ui-v3/SegmentedControl'
import { Skeleton } from '@/components/ui-v3/Feedback'
import { useAnalytics } from '@/components/providers/posthog'
import { loadNotificationSettings, saveNotificationSettings } from '@/lib/api/settings-client'
import { cn } from '@/lib/utils'
import { Switch } from './Switch'

type View = { kind: 'loading' } | { kind: 'not_ready' } | { kind: 'error' } | { kind: 'ready' }
type Field = 'channel' | 'quiet_hours' | 'pause' | 'digest'

/** The time choices offered, plus the stored value when it is not one of them. */
function choices(base: readonly string[], current: string | undefined): string[] {
  return current && !base.includes(current) ? [...base, current].sort() : [...base]
}

/**
 * Settings → Notifications (PRD_WHATSAPP W1; audit §5 items 12–15): the
 * channel per category (email, SMS, WhatsApp; app push "coming soon"),
 * essential categories that must keep one channel, quiet hours in IST (off by
 * default, 21:00–08:00 suggested), a pause, and for providers the morning
 * digest of new requests. Every change saves at once (optimistic, a toast); a
 * failure puts the last saved settings back.
 */
export function NotificationSettingsForm({ persona, whatsappHref }: { persona: 'buyer' | 'provider'; whatsappHref: string }) {
  const t = useTranslations('notification_settings')
  const tCommon = useTranslations('common')
  const format = useFormatter()
  const { toast } = useToast()
  const analytics = useAnalytics()
  const ids = useId()
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [settings, setSettings] = useState<NotificationSettings | null>(null)
  const [essential, setEssential] = useState<NotificationCategory[]>([])
  const [blocked, setBlocked] = useState<NotificationCategory | null>(null)
  const saved = useRef<NotificationSettings | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const seq = useRef(0)

  const load = useCallback(async () => {
    setView({ kind: 'loading' })
    const r = await loadNotificationSettings()
    if (r.kind !== 'ready') { setView(r); return }
    saved.current = r.data.settings
    setSettings(r.data.settings)
    setEssential(r.data.essentialCategories)
    setView({ kind: 'ready' })
  }, [])
  useEffect(() => { void load() }, [load])

  function commit(next: NotificationSettings, field: Field) {
    setSettings(next)
    const mine = ++seq.current
    // One PUT at a time, each with the settings as they were when it was queued. Only the newest change reports back:
    // an older save that fails while a newer one is queued is superseded by it (the newer one carries every change).
    queue.current = queue.current.then(async () => {
      const res = await saveNotificationSettings(next)
      if (res.ok) {
        saved.current = next
        analytics.capture('notification_settings_saved', { field, persona, device: 'web' })
        if (mine === seq.current) toast(t('saved'), 'success')
        return
      }
      if (mine !== seq.current) return
      setSettings(saved.current)
      if (res.status === 422 && res.error === 'essential_needs_channel') toast(t('essential_note'), 'error')
      else if (res.status === 503 || res.status === 404) setView({ kind: 'not_ready' })
      else toast(t('save_failed'), 'error')
    })
  }

  function setChannel(category: NotificationCategory, channel: SwitchableChannel, on: boolean) {
    if (!settings) return
    const prefs = withChannel(settings.preferences, category, channel, on)
    if (!on && essentialChannelMissing(prefs, essential.includes(category) ? [category] : [])) {
      setBlocked(category)
      return
    }
    setBlocked(null)
    commit({ ...settings, preferences: prefs }, 'channel')
  }

  if (view.kind === 'loading') {
    return (
      <div className="space-y-3" aria-label={t('loading')} data-testid="notification-settings" data-state="loading">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
      </div>
    )
  }
  if (view.kind === 'not_ready') {
    return <p className="rounded-card bg-primary-soft px-4 py-3 text-sm" role="status" data-testid="notification-settings" data-state="not_ready">{t('not_ready')}</p>
  }
  if (view.kind === 'error' || !settings) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface p-4 text-sm" data-testid="notification-settings" data-state="error">
        <p className="text-foreground-secondary">{t('load_failed')}</p>
        <Button size="sm" variant="outline" onClick={() => void load()}>{tCommon('retry')}</Button>
      </div>
    )
  }

  const quiet = settings.quietHours
  const paused = isPaused(settings.pausedUntil, new Date())

  return (
    <div className="space-y-6" data-testid="notification-settings" data-state="ready">
      <section aria-labelledby={`${ids}-channels`} className="space-y-3">
        <h2 id={`${ids}-channels`} className="flex items-center gap-2 text-base font-semibold">
          <BellRing className="h-5 w-5 text-primary" aria-hidden />
          {t('channels_title')}
        </h2>
        <p className="text-sm text-foreground-secondary">{t('channels_body')}</p>
        <ul className="space-y-3">
          {NOTIFICATION_CATEGORIES.map((category) => {
            const isEssential = essential.includes(category)
            const catLabel = t(`cat_${category}`)
            return (
              <li key={category} className="rounded-card border border-border bg-surface p-4" data-testid={`notif-cat-${category}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 id={`${ids}-${category}`} className="text-sm font-semibold">{catLabel}</h3>
                  {isEssential && <span className="rounded-chip bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">{t('essential_badge')}</span>}
                </div>
                <p className="mt-0.5 text-xs text-foreground-secondary">{t(`cat_${category}_desc`)}</p>
                <div role="group" aria-labelledby={`${ids}-${category}`} className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {SWITCHABLE_CHANNELS.map((channel) => {
                    const on = channelEnabled(settings.preferences, category, channel)
                    return (
                      <button
                        key={channel}
                        type="button"
                        role="switch"
                        aria-checked={on}
                        onClick={() => setChannel(category, channel, !on)}
                        data-testid={`notif-${category}-${channel}`}
                        className={cn(
                          'flex min-h-11 items-center justify-between gap-2 rounded-button border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                          on ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-surface text-foreground-secondary hover:border-primary/40',
                        )}
                      >
                        <span>{t(`channel_${channel}`)}</span>
                        <span aria-hidden className={cn('flex h-5 w-5 items-center justify-center rounded-full border', on ? 'border-primary bg-primary text-white' : 'border-border')}>
                          {on && <Check className="h-3.5 w-3.5" />}
                        </span>
                      </button>
                    )
                  })}
                  <span className="flex min-h-11 items-center justify-between gap-2 rounded-button border border-dashed border-border px-3 text-sm text-foreground-secondary" aria-disabled="true">
                    <span>{t('channel_push')}</span>
                    <span className="text-[11px]">{t('push_soon')}</span>
                  </span>
                </div>
                {isEssential && <p className="mt-2 text-xs text-foreground-secondary">{t('essential_note')}</p>}
                {blocked === category && <p className="mt-2 text-xs font-medium text-danger" role="alert">{t('essential_blocked', { category: catLabel })}</p>}
              </li>
            )
          })}
        </ul>
        <p className="text-xs text-foreground-secondary">
          {t('whatsapp_needs_optin')}{' '}
          <Link href={whatsappHref as '/app'} className="font-medium text-primary underline-offset-2 hover:underline">{t('whatsapp_manage')}</Link>
        </p>
      </section>

      <section aria-labelledby={`${ids}-quiet`} className="rounded-card border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <Moon className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 id={`${ids}-quiet`} className="text-sm font-semibold">{t('quiet_title')}</h2>
            <p id={`${ids}-quiet-d`} className="mt-0.5 text-xs text-foreground-secondary">{t('quiet_body')}</p>
          </div>
          <Switch
            checked={!!quiet}
            onChange={(on) => commit({ ...settings, quietHours: on ? { ...DEFAULT_QUIET_HOURS } : null }, 'quiet_hours')}
            labelledBy={`${ids}-quiet`}
            describedBy={`${ids}-quiet-d`}
            testId="notif-quiet"
          />
        </div>
        {quiet && (
          <div className="mt-3 space-y-3" data-testid="notif-quiet-window">
            <p className="text-sm font-medium">{t('quiet_summary', { start: quiet.start, end: quiet.end })}</p>
            <div>
              <p id={`${ids}-from`} className="mb-1 text-xs text-foreground-secondary">{t('quiet_from')}</p>
              <SegmentedControl
                size="sm"
                ariaLabelledBy={`${ids}-from`}
                value={quiet.start}
                options={choices(QUIET_HOURS_START_CHOICES, quiet.start).map((v) => ({ value: v, label: v }))}
                onChange={(v) => commit({ ...settings, quietHours: { ...quiet, start: v } }, 'quiet_hours')}
              />
            </div>
            <div>
              <p id={`${ids}-to`} className="mb-1 text-xs text-foreground-secondary">{t('quiet_to')}</p>
              <SegmentedControl
                size="sm"
                ariaLabelledBy={`${ids}-to`}
                value={quiet.end}
                options={choices(QUIET_HOURS_END_CHOICES, quiet.end).map((v) => ({ value: v, label: v }))}
                onChange={(v) => commit({ ...settings, quietHours: { ...quiet, end: v } }, 'quiet_hours')}
              />
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby={`${ids}-pause`} className="rounded-card border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <PauseCircle className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 id={`${ids}-pause`} className="text-sm font-semibold">{t('pause_title')}</h2>
            <p className="mt-0.5 text-xs text-foreground-secondary">{t('pause_body')}</p>
          </div>
        </div>
        {paused && settings.pausedUntil ? (
          <div className="mt-3 flex flex-wrap items-center gap-3" data-testid="notif-paused">
            <p className="text-sm font-medium">
              {t('paused_until', { date: format.dateTime(new Date(settings.pausedUntil), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) })}
            </p>
            <Button size="sm" variant="outline" onClick={() => commit({ ...settings, pausedUntil: null }, 'pause')}>{t('resume')}</Button>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-labelledby={`${ids}-pause`}>
            {PAUSE_DAY_CHOICES.map((days) => (
              <Button key={days} size="sm" variant="outline" onClick={() => commit({ ...settings, pausedUntil: pauseUntilIso(days, new Date()) }, 'pause')} data-testid={`notif-pause-${days}`}>
                {t('pause_for', { days })}
              </Button>
            ))}
          </div>
        )}
      </section>

      {persona === 'provider' && (
        <section className="flex items-start gap-3 rounded-card border border-border bg-surface p-4">
          <div className="min-w-0 flex-1">
            <h2 id={`${ids}-digest`} className="text-sm font-semibold">{t('digest_title')}</h2>
            <p id={`${ids}-digest-d`} className="mt-0.5 text-xs text-foreground-secondary">{t('digest_body')}</p>
          </div>
          <Switch
            checked={settings.digestLeads}
            onChange={(on) => commit({ ...settings, digestLeads: on }, 'digest')}
            labelledBy={`${ids}-digest`}
            describedBy={`${ids}-digest-d`}
            testId="notif-digest"
          />
        </section>
      )}
    </div>
  )
}
