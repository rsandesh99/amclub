'use client'

import { useTranslations } from 'next-intl'

/**
 * The WhatsApp box at signup and checkout (audit §5 item 1): unticked by
 * default, the transactional notice beside it (the text the consent records,
 * WA_NOTICE_VERSION). It never blocks signing up; the choice is sent once the
 * account exists (lib/api/settings-client sendPendingWhatsAppOptIn).
 */
export function WhatsAppOptInCheckbox({
  checked,
  onChange,
  id = 'wa-optin',
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  id?: string
}) {
  const t = useTranslations('whatsapp')
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3 rounded-button border border-border bg-surface px-3 py-2.5 text-sm leading-relaxed text-foreground" data-testid="wa-optin">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={`${id}-notice`}
        className="mt-0.5 h-6 w-6 shrink-0 accent-primary"
      />
      <span>
        <span className="block font-medium">{t('checkbox_label')}</span>
        <span id={`${id}-notice`} className="mt-0.5 block text-xs text-foreground-secondary">{t('notice_transactional')}</span>
      </span>
    </label>
  )
}
