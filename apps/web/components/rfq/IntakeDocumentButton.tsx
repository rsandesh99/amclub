'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Camera, Paperclip, Loader2 } from 'lucide-react'
import { RFQ_ATTACHMENT_MAX_BYTES, intakeResultSchema, type IntakeMode, type IntakeResult } from '@amclub/shared'

/**
 * S1.8 — "Add a photo or drawing": one file input beside the mic. Posts to
 * /api/v1/rfq/document-extract (the file is stored as an attachment in the
 * same call); a document result becomes editable facts, a drawing result a
 * spec summary, both prefill only. Rendered ONLY when the page says the
 * buyer is cohorted for document intake (`enabled`), so the dark surface has
 * no button at all. Failures that still stored the attachment hand it back so
 * the form can attach the file anyway.
 */

const ACCEPT = '.jpg,.jpeg,.png,.webp,.pdf,.step,.stp,.dxf,image/jpeg,image/png,image/webp,application/pdf'
/** Camera capture: photos only (the route accepts these image types). */
const CAMERA_ACCEPT = 'image/jpeg,image/png,image/webp'

export interface IntakeDocumentButtonProps {
  mode: IntakeMode
  enabled: boolean
  onResult: (result: IntakeResult) => void
  /** The route stored the file but could not read it (scanned PDF, unreadable drawing): keep it as a plain attachment. */
  onAttachmentOnly: (attachment: { url: string; name: string }, reason: string) => void
  track: (event: string, props?: Record<string, unknown>) => void
  compact?: boolean
}

export function IntakeDocumentButton({ mode, enabled, onResult, onAttachmentOnly, track, compact = false }: IntakeDocumentButtonProps) {
  const t = useTranslations('rfq')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const cameraRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!enabled) return null

  async function onFile(file: File | null) {
    if (!file) return
    setError(null)
    if (file.size > RFQ_ATTACHMENT_MAX_BYTES) { setError(t('intake_err_size')); return }
    setBusy(true)
    try {
      const form = new FormData()
      form.append('file', file, file.name)
      form.append('mode', mode)
      const res = await fetch('/api/v1/rfq/document-extract', { method: 'POST', body: form })
      const d = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (res.ok) {
        const parsed = intakeResultSchema.safeParse(d)
        if (!parsed.success) { setError(t('intake_err_failed')); return }
        track('rfq_intake_document_added', { kind: parsed.data.kind, doc_type: parsed.data.kind === 'document' ? parsed.data.result.doc_type : parsed.data.result.format, stub: parsed.data.kind === 'document' ? parsed.data.stub : false, mode })
        onResult(parsed.data)
        return
      }
      const err = String(d['error'] ?? '')
      const attachment = d['attachment'] as { url: string; name: string } | undefined
      if (res.status === 429) setError(t('intake_err_rate_limited'))
      else if (err === 'file_too_large') setError(t('intake_err_size'))
      else if (err === 'file_type_unsupported') setError(t('intake_err_type'))
      else if (err === 'pdf_no_text') setError(t('intake_err_pdf_no_text'))
      else if (err === 'drawing_unreadable' || err === 'drawing_too_large') setError(t('intake_err_drawing'))
      else setError(t('intake_err_failed'))
      if (attachment?.url) onAttachmentOnly(attachment, err)
      track('rfq_intake_document_failed', { reason: err || `http_${res.status}`, mode })
    } catch {
      setError(t('intake_err_failed'))
      track('rfq_intake_document_failed', { reason: 'network', mode })
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
      if (cameraRef.current) cameraRef.current.value = ''
    }
  }

  const btn = 'inline-flex min-h-11 items-center gap-2 rounded-button border border-border bg-surface px-4 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60'

  // Two inputs: `capture` makes Android open the camera directly and hides the
  // file picker, so it may only sit on the photo input — the PDF / STEP / DXF
  // picker must never carry it.
  return (
    <div className={compact ? 'inline-flex flex-col gap-1' : 'flex flex-col gap-1.5'}>
      <input ref={cameraRef} type="file" accept={CAMERA_ACCEPT} capture="environment" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void onFile(e.target.files?.[0] ?? null)} />
      <input ref={inputRef} type="file" accept={ACCEPT} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void onFile(e.target.files?.[0] ?? null)} />
      <div role="group" aria-label={t('intake_add_cta')} className="flex flex-wrap gap-2">
        {busy ? (
          <span className={btn} role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t('intake_uploading')}
          </span>
        ) : (
          <>
            <button type="button" onClick={() => cameraRef.current?.click()} className={btn}>
              <Camera className="h-4 w-4" aria-hidden />
              {t('intake_take_photo')}
            </button>
            <button type="button" onClick={() => inputRef.current?.click()} className={btn}>
              <Paperclip className="h-4 w-4" aria-hidden />
              {t('intake_choose_file')}
            </button>
          </>
        )}
      </div>
      {!compact && <p className="text-xs text-foreground-secondary">{t('intake_choose_file_hint')}</p>}
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
    </div>
  )
}
