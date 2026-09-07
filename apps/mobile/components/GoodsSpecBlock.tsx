import { Text, View } from 'react-native'
import { formatINR } from '@/lib/format'

/** AMC Mart M2 — the requested spec on a goods RFQ (buyer + seller read the same block). */
export function GoodsSpecBlock({ spec, t }: { spec: any; t: (k: string, p?: Record<string, string | number>) => string }) {
  const rows: { k: string; v: string }[] = spec.spec ?? []
  const d = spec.delivery
  return (
    <View className="mx-4 mt-4 rounded-xl border border-border bg-surface p-4">
      <Text className="text-xs font-semibold uppercase text-foreground-secondary">{t('rfq.goods_spec_title')}</Text>
      <Text className="mt-1 text-base font-bold text-foreground">{spec.item}</Text>
      <Text className="text-sm text-foreground">
        {t('rfq.goods_qty_line', { qty: spec.qty, unit: spec.unit })}
        {spec.target_unit_price_paise ? ` · ${t('rfq.goods_target_line', { price: formatINR(spec.target_unit_price_paise), unit: spec.unit })}` : ''}
      </Text>
      {rows.map((r, i) => (
        <Text key={`${r.k}-${i}`} className="mt-1 text-sm text-foreground"><Text className="text-foreground-secondary">{r.k}: </Text>{r.v}</Text>
      ))}
      {d ? (
        <Text className="mt-2 text-xs text-foreground-secondary">{t('rfq.goods_deliver_to')}: {d.pickup ? t('rfq.goods_pickup_line') + ' · ' : ''}{d.city}, {d.state} {d.pincode}</Text>
      ) : null}
    </View>
  )
}

