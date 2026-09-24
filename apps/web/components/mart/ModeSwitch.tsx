'use client'

import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { SegmentedControl } from '@/components/ui-v3/SegmentedControl'
import { useAnalytics } from '@/components/providers/posthog'

type Mode = 'services' | 'goods'

/**
 * E16 N39 — the Services | Goods switch beside the search field. Rendered ONLY
 * when the server says MART_ENABLED (the caller checks; this component never
 * reads the flag). Switching keeps the query: services go to `servicesPath`
 * (/services or /app/search), goods to /mart/search.
 */
export function ModeSwitch({ mode, query, servicesPath = '/services' }: { mode: Mode; query?: string | undefined; servicesPath?: '/services' | '/app/search' }) {
  const t = useTranslations('mart')
  const router = useRouter()
  const analytics = useAnalytics()
  const q = query?.trim() ? `?query=${encodeURIComponent(query.trim())}` : ''
  return (
    <div data-testid="mode-switch">
      <SegmentedControl<Mode>
        ariaLabel={t('mode_label')}
        size="sm"
        className="w-full max-w-xs"
        value={mode}
        options={[
          { value: 'services', label: t('mode_services') },
          { value: 'goods', label: t('mode_goods') },
        ]}
        onChange={(next) => {
          if (next === mode) return
          analytics.capture('search_mode_switched', { to: next, has_query: q !== '' })
          router.push(`${next === 'goods' ? '/mart/search' : servicesPath}${q}` as '/services')
        }}
      />
    </div>
  )
}
