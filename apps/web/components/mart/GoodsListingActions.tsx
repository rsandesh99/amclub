'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Pause, Play, Pencil, Send } from 'lucide-react'
import { Link, useRouter } from '@/i18n/navigation'
import { useToast } from '@/components/ui/toast'

export function GoodsListingActions({ productId, status, sellsGoods }: { productId: string; status: string; sellsGoods: boolean }) {
  const t = useTranslations('mart')
  const router = useRouter()
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)

  async function act(action: 'submit' | 'suspend' | 'reactivate') {
    setBusy(true)
    const res = await fetch(`/api/v1/mart/seller/products/${productId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
    })
    setBusy(false)
    if (res.ok) {
      toast(action === 'submit' ? t('sent_for_approval') : t('confirmed'), 'success')
      router.refresh()
    } else {
      const d = await res.json().catch(() => ({}))
      const code = typeof d.error === 'string' ? d.error : ''
      toast(code === 'activation_required' ? t('activation_required') : code === 'suspended_by_admin' ? t('suspended_by_admin') : t('error_generic'), 'error')
    }
  }
  const btn = 'inline-flex items-center gap-1 rounded-button px-2.5 py-1.5 text-xs font-medium'
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Link href={`/partner/goods/${productId}/edit` as '/partner'} className={`${btn} text-emerald hover:bg-emerald/10`}>
        <Pencil className="h-3.5 w-3.5" /> {t('action_edit')}
      </Link>
      {status === 'draft' && (
        <button type="button" disabled={busy || !sellsGoods} onClick={() => act('submit')} className={`${btn} border border-emerald text-emerald hover:bg-emerald/10 disabled:opacity-50`}>
          <Send className="h-3.5 w-3.5" /> {t('action_submit')}
        </button>
      )}
      {status === 'active' && (
        <button type="button" disabled={busy} onClick={() => act('suspend')} className={`${btn} text-foreground-secondary hover:bg-muted`}>
          <Pause className="h-3.5 w-3.5" /> {t('action_suspend')}
        </button>
      )}
      {status === 'suspended' && (
        <button type="button" disabled={busy} onClick={() => act('reactivate')} className={`${btn} text-success hover:bg-success/10`}>
          <Play className="h-3.5 w-3.5" /> {t('action_reactivate')}
        </button>
      )}
    </div>
  )
}
