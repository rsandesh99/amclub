import { useEffect, useRef, useState } from 'react'
import { Text, TouchableOpacity, View } from 'react-native'
import { benchmarkLine, benchmarkViewSchema } from '@amclub/shared'
import { track } from '@/lib/analytics'

/**
 * S3.2 — the fair price range on a services request: the SAME line for the buyer and every matched provider (the web
 * BenchmarkLine's twin; `benchmarkLine` is shared). Renders nothing unless GET /rfq/[id] carried a valid `benchmark`.
 */
export function BenchmarkBlock({ raw, role, locale, t }: { raw: unknown; role: 'buyer' | 'provider'; locale: string; t: (k: string) => string }) {
  const parsed = benchmarkViewSchema.safeParse(raw)
  const view = parsed.success ? parsed.data : null
  const [open, setOpen] = useState(false)
  const sent = useRef(false)
  useEffect(() => {
    if (!view || sent.current) return
    sent.current = true
    track('benchmark_shown', { role, scope: view.scope, category: view.category_slug })
  }, [view, role])
  if (!view) return null
  return (
    <View className="mt-2 rounded-lg border border-border bg-muted/40 p-3">
      <Text className="text-sm font-medium text-foreground">{benchmarkLine(view, locale)}</Text>
      {view.note ? <Text className="mt-1 text-xs text-foreground-secondary">{view.note}</Text> : null}
      <TouchableOpacity onPress={() => setOpen((o) => !o)} accessibilityRole="button">
        <Text className="mt-1 text-xs font-medium text-primary underline">{t('rfq.benchmark_how_title')}</Text>
      </TouchableOpacity>
      {open ? <Text className="mt-1 text-xs text-foreground-secondary">{t('rfq.benchmark_how_body')}</Text> : null}
    </View>
  )
}
