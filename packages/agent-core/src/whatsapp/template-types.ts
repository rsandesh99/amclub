import type { WaLocale, WaTemplateCategory } from '@amclub/shared'

/**
 * ADR-030 §3 — one WhatsApp template in the registry. A kind names a template; the send path resolves it to a
 * (name, language) pair that exists: the locale's variant when `locales` has it, else en with the en language code.
 * The body text is kept here exactly as submitted to Meta, so the approval list (PRE_LAUNCH_CHECKLIST 1.3) and the
 * consent notice are provable from the repo.
 */
export type WaTemplateValues = Record<string, string | null | undefined>

export interface WaTemplateSpec {
  /** Meta template name stem; the approved name per locale is `${stem}_${locale}`. */
  stem: string
  category: WaTemplateCategory
  /** Locales submitted for approval (en always). */
  locales: readonly WaLocale[]
  /** Body per locale as submitted, with {{1}}, {{2}} … placeholders; a missing locale is not submitted. */
  body: Partial<Record<WaLocale, string>> & { en: string }
  /** Ordered body parameters from the send's values (each ≤ 1024 chars; the driver cleans newlines / tabs). */
  params: (v: WaTemplateValues) => string[]
  /**
   * Optional URL button: `https://<app host>/<path>` where the fixed prefix is approved with the template and only
   * the suffix (e.g. `app/orders/<id>`) is dynamic. Links go only to our own domain.
   */
  urlButton?: { label: Partial<Record<WaLocale, string>> & { en: string }; suffix: (v: WaTemplateValues) => string | null }
  /** Optional quick-reply buttons (≤ 3): the payload id comes back as the button reply. */
  quickReplies?: ReadonlyArray<{ id: string; label: Partial<Record<WaLocale, string>> & { en: string } }>
}

export type WaTemplateRegistry = Record<string, WaTemplateSpec>
