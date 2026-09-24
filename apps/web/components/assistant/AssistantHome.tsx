import { getTranslations } from 'next-intl/server'
import { Ban, Check, Hand, Sparkles } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { agentAvailability } from '@/lib/agent/availability'
import { ASKS_FIRST, NEVER, capabilitiesFor } from '@/lib/agent/capabilities'
import { AgentGrantsSection } from '@/components/agent/AgentGrantsSection'
import { WhatsAppOptInSection } from '@/components/agent/WhatsAppOptInSection'
import { AssistantHomeViewed } from './AssistantHomeViewed'
import { CapabilityIcon } from './CapabilityIcon'
import { LauncherPreference } from './LauncherPreference'

/**
 * The assistant's home (buyer /app/ai, provider /partner/ai): what it is in
 * plain words, what it does (each capability with "On" or "Coming to your
 * account"), what it always asks first, what it never does, and its settings:
 * the web permission, WhatsApp, the corner button. Replaces the scope list that
 * used to sit at the bottom of the profile page.
 */
export async function AssistantHome({ persona, userId }: { persona: 'buyer' | 'provider'; userId: string }) {
  const t = await getTranslations('assistant_home')
  const avail = await agentAvailability(await createAdminClient(), userId)
  const caps = capabilitiesFor(persona).map((c) => ({ ...c, on: c.agent === null ? true : avail[c.agent] }))
  const onCount = caps.filter((c) => c.on).length
  const tryNow = caps.filter((c) => c.on && c.href).slice(0, 3)

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-6 lg:py-8" data-testid="assistant-home" data-persona={persona}>
      <AssistantHomeViewed persona={persona} on={onCount} />

      <header className="rounded-sheet bg-primary/5 p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"><Sparkles className="h-5 w-5" aria-hidden /></span>
          <div className="min-w-0">
            <h1 className="t-title-1 text-foreground">{t('title')}</h1>
            <p className="t-body mt-2 max-w-3xl text-foreground-secondary">{t(persona === 'buyer' ? 'lead_buyer' : 'lead_provider')}</p>
          </div>
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(['stat_on', 'stat_asks', 'stat_languages', 'stat_off'] as const).map((k) => (
            <div key={k} className="rounded-card bg-surface p-3 shadow-card">
              <dt className="t-footnote text-foreground-secondary">{t(`${k}_label`)}</dt>
              <dd className="t-headline mt-0.5 text-foreground">{k === 'stat_on' ? t('stat_on_value', { on: onCount, total: caps.length }) : t(`${k}_value`)}</dd>
            </div>
          ))}
        </dl>
      </header>

      {tryNow.length > 0 && (
        <section aria-labelledby="try-now">
          <h2 id="try-now" className="t-title-3 mb-3 text-foreground">{t('section_try')}</h2>
          <ul className="grid gap-3 sm:grid-cols-3">
            {tryNow.map((c) => (
              <li key={c.key}>
                <Link href={c.href as '/app'} className="flex h-full items-start gap-3 rounded-card border border-border bg-surface p-4 shadow-card hover:border-primary/40 hover:bg-primary/5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><CapabilityIcon icon={c.icon} className="h-5 w-5" /></span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-foreground">{t(`cap.${c.key}.try`)}</span>
                    <span className="t-footnote mt-0.5 block text-foreground-secondary">{t(`cap.${c.key}.title`)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="what-it-does">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="what-it-does" className="t-title-3 text-foreground">{t('section_does')}</h2>
          {onCount < caps.length && <p className="t-footnote text-foreground-secondary">{t('rolling_out')}</p>}
        </div>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="assistant-capabilities">
          {caps.map((c) => (
            <li key={c.key} className="flex flex-col rounded-card border border-border bg-surface p-4 shadow-card" data-capability={c.key} data-on={c.on}>
              <div className="flex items-start justify-between gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary"><CapabilityIcon icon={c.icon} className="h-5 w-5" /></span>
                <span className={c.on ? 'rounded-chip bg-success/10 px-2 py-0.5 text-xs font-semibold text-success' : 'rounded-chip bg-foreground/5 px-2 py-0.5 text-xs font-medium text-foreground-secondary'}>
                  {c.on ? t('chip_on') : t('chip_soon')}
                </span>
              </div>
              <h3 className="mt-3 text-[15px] font-semibold text-foreground">{t(`cap.${c.key}.title`)}</h3>
              <p className="t-subhead mt-1 flex-1 text-foreground-secondary">{t(`cap.${c.key}.body`)}</p>
              <p className="t-footnote mt-3 rounded-button bg-muted px-2.5 py-2 italic text-foreground-secondary">{t(`cap.${c.key}.example`)}</p>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section aria-labelledby="asks-first" className="rounded-card border border-border bg-surface p-5 shadow-card">
          <h2 id="asks-first" className="t-headline flex items-center gap-2 text-foreground"><Hand className="h-5 w-5 text-warning" aria-hidden /> {t('section_asks')}</h2>
          <p className="t-footnote mt-1 text-foreground-secondary">{t('section_asks_sub')}</p>
          <ul className="mt-3 space-y-2">
            {ASKS_FIRST[persona].map((k) => (
              <li key={k} className="flex items-start gap-2 text-sm text-foreground"><Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />{t(`asks.${k}`)}</li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="never" className="rounded-card border border-border bg-surface p-5 shadow-card">
          <h2 id="never" className="t-headline flex items-center gap-2 text-foreground"><Ban className="h-5 w-5 text-danger" aria-hidden /> {t('section_never')}</h2>
          <p className="t-footnote mt-1 text-foreground-secondary">{t('section_never_sub')}</p>
          <ul className="mt-3 space-y-2">
            {NEVER[persona].map((k) => (
              <li key={k} className="flex items-start gap-2 text-sm text-foreground"><Ban className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />{t(`never.${k}`)}</li>
            ))}
          </ul>
        </section>
      </div>

      <section aria-labelledby="settings" className="space-y-4">
        <h2 id="settings" className="t-title-3 text-foreground">{t('section_settings')}</h2>
        <AgentGrantsSection persona={persona} />
        <WhatsAppOptInSection businessNumber={process.env['NEXT_PUBLIC_WHATSAPP_NUMBER'] ?? null} />
        <LauncherPreference persona={persona} />
      </section>

      <section aria-labelledby="faq">
        <h2 id="faq" className="t-title-3 mb-3 text-foreground">{t('section_faq')}</h2>
        <div className="divide-y divide-border rounded-card border border-border bg-surface shadow-card">
          {(['what_on_means', 'undo', 'why_soon', 'languages', 'data'] as const).map((k) => (
            <details key={k} className="group px-4 py-3">
              <summary className="cursor-pointer list-none text-sm font-semibold text-foreground marker:hidden">
                <span className="flex items-center justify-between gap-3">{t(`faq.${k}.q`)}<span aria-hidden className="text-foreground-secondary transition-transform group-open:rotate-45">+</span></span>
              </summary>
              <p className="t-subhead mt-2 text-foreground-secondary">{t(`faq.${k}.a`)}</p>
            </details>
          ))}
        </div>
      </section>
    </div>
  )
}
