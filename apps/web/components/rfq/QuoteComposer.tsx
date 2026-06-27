'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

export function QuoteComposer({ rfqId }: { rfqId: string }) {
  const t = useTranslations('rfq')
  const router = useRouter()
  const [price, setPrice] = useState('')
  const [days, setDays] = useState('')
  const [scope, setScope] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setError('')
    const pricePaise = Math.round(Number(price) * 100)
    const deliveryDays = Number(days)
    if (!pricePaise || pricePaise <= 0) { setError(t('quote_price_label') + ': ' + t('required_field')); return }
    if (!deliveryDays || deliveryDays <= 0) { setError(t('quote_delivery_label') + ': ' + t('required_field')); return }
    if (scope.trim().length < 20) { setError(t('quote_scope_label') + ': ' + t('required_field')); return }
    setLoading(true)
    try {
      const res = await fetch(`/api/v1/rfq/${rfqId}/quote`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ price_paise: pricePaise, delivery_days: deliveryDays, scope: scope.trim(), ...(message.trim() ? { message: message.trim() } : {}) }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (d.error === 'already_quoted') throw new Error(t('already_quoted'))
        if (d.error === 'rfq_closed') throw new Error(t('rfq_closed'))
        throw new Error(t('err_quote'))
      }
      router.refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('err_quote'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card space-y-4">
      <h2 className="text-sm font-semibold">{t('quote_title')}</h2>
      <div className="flex gap-3">
        <div className="flex-1 flex flex-col gap-1.5">
          <Label htmlFor="q-price">{t('quote_price_label')}</Label>
          <Input id="q-price" type="number" inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
        <div className="flex-1 flex flex-col gap-1.5">
          <Label htmlFor="q-days">{t('quote_delivery_label')}</Label>
          <Input id="q-days" type="number" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="q-scope">{t('quote_scope_label')}</Label>
        <Textarea id="q-scope" value={scope} onChange={(e) => setScope(e.target.value)} placeholder={t('quote_scope_placeholder')} rows={4} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="q-msg">{t('quote_message_label')}</Label>
        <Textarea id="q-msg" value={message} onChange={(e) => setMessage(e.target.value)} rows={2} />
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button onClick={submit} loading={loading} className="w-full">{loading ? t('submitting_quote') : t('submit_quote')}</Button>
    </div>
  )
}
