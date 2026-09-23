'use client'

import { useTranslations } from 'next-intl'

/**
 * Explicit signup consent (Phase 2b) — replaces the passive "By continuing…"
 * line on signup surfaces. Checked state is owned by the wizard so it can be
 * turned into terms_acceptances rows right after authentication.
 */
export function ConsentCheckbox({
  checked,
  onChange,
  id = 'legal-consent',
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  id?: string
}) {
  const t = useTranslations('auth')
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3 rounded-button border border-border bg-surface px-3 py-2.5 text-sm leading-relaxed text-foreground">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-6 w-6 shrink-0 accent-primary"
        required
      />
      <span>
        {t.rich('consent_checkbox', {
          terms: (chunks) => (
            <a href="/terms" target="_blank" rel="noopener" className="text-primary underline underline-offset-2 hover:no-underline">
              {chunks}
            </a>
          ),
          privacy: (chunks) => (
            <a href="/privacy" target="_blank" rel="noopener" className="text-primary underline underline-offset-2 hover:no-underline">
              {chunks}
            </a>
          ),
        })}
      </span>
    </label>
  )
}
