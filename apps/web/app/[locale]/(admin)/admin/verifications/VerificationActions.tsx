'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/toast'

interface VerificationActionsProps {
  providerId: string
}

export function VerificationActions({ providerId }: VerificationActionsProps) {
  const t = useTranslations('admin')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const { toast } = useToast()
  const [mode, setMode] = useState<'idle' | 'rejecting'>('idle')
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState('')

  async function act(action: 'approve' | 'reject') {
    if (action === 'reject' && !reason.trim()) {
      setError(t('reason_required'))
      return
    }
    setError('')
    setLoading(action)
    try {
      const res = await fetch(`/api/v1/admin/verifications/${providerId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason: reason.trim() || undefined }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        // Audit M11 — a provider that is no longer pending (decided, suspended) is changed from its provider page.
        if (d.code === 'not_pending') throw new Error(t('verification_not_pending'))
        throw new Error(typeof d.error === 'string' ? d.error : t('action_failed'))
      }
      // Phase 3b (ii): approval goes through, but the approver hears — right
      // now — that payouts will hold until the Route/bank work on the
      // dashboard tile is done.
      if (action === 'approve') {
        if (d.readiness && d.readiness !== 'ready') toast(t('approved_not_ready'), 'error')
        else toast(t('approved_ready'), 'success')
      }
      router.refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('action_failed'))
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="mt-5 border-t border-border pt-4">
      {mode === 'rejecting' ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`reason-${providerId}`}>{t('reject_reason_label')}</Label>
            <Textarea
              id={`reason-${providerId}`}
              placeholder={t('reject_reason_placeholder')}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button
              variant="danger"
              onClick={() => act('reject')}
              loading={loading === 'reject'}
              size="sm"
            >
              {t('confirm_reject')}
            </Button>
            <Button variant="ghost" onClick={() => { setMode('idle'); setReason('') }} size="sm">
              {tCommon('cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <Button
            onClick={() => act('approve')}
            loading={loading === 'approve'}
            size="sm"
          >
            {t('approve_btn')}
          </Button>
          <Button
            variant="outline"
            onClick={() => setMode('rejecting')}
            size="sm"
            className="border-danger text-danger hover:bg-danger/10"
          >
            {t('reject_btn')}
          </Button>
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      )}
    </div>
  )
}
