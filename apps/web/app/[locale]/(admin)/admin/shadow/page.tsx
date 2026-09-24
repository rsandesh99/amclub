import { getTranslations } from 'next-intl/server'
import { SHADOW_FEATURES, SHADOW_MODEL_VERSION, weeklyShadowReport } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

/**
 * E15 FR-15.5 (F10) — the weekly error report of every shadow feature (rules
 * first). Admin / ops only (the group layout gates the role); nobody else ever
 * sees a shadow. Shows counts and mean error per IST week — never a subject.
 */
export default async function AdminShadowPage() {
  const t = await getTranslations('admin_shadow')
  const admin = await createAdminClient()
  const now = new Date().toISOString()
  const since = new Date(Date.now() - 8 * 7 * 86_400_000).toISOString()
  const reports = await Promise.all(SHADOW_FEATURES.map(async (feature) => {
    const [{ data }, { data: flag }] = await Promise.all([
      admin.from('shadow_predictions').select('created_at, resolved_at, error').eq('feature', feature).gte('created_at', since).limit(20000),
      admin.from('agent_settings').select('value').eq('key', `shadow_${feature}_enabled`).maybeSingle(),
    ])
    return { feature, on: flag?.value === true, weeks: weeklyShadowReport((data ?? []) as { created_at: string; resolved_at: string | null; error: number | null }[], now) }
  }))
  return (
    <div className="mx-auto max-w-4xl px-4 py-8" data-testid="admin-shadow">
      <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
      <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle')}</p>
      {reports.map((r) => (
        <section key={r.feature} className="mt-6 rounded-card border border-border bg-surface p-4" data-feature={r.feature}>
          <h2 className="font-semibold">{t(`feature_${r.feature}`)} <span className="text-xs font-normal text-foreground-secondary">· {SHADOW_MODEL_VERSION[r.feature]} · {r.on ? t('on') : t('off')}</span></h2>
          <table className="mt-3 w-full text-sm tabular-nums">
            <caption className="sr-only">{t(`feature_${r.feature}`)}</caption>
            <thead><tr className="text-left text-xs text-foreground-secondary"><th className="py-1 font-medium">{t('col_week')}</th><th className="font-medium">{t('col_predicted')}</th><th className="font-medium">{t('col_resolved')}</th><th className="font-medium">{t('col_error')}</th></tr></thead>
            <tbody>
              {r.weeks.map((w) => (
                <tr key={w.weekStart} className="border-t border-border">
                  <td className="py-1">{w.weekStart}</td><td>{w.predicted}</td><td>{w.resolved}</td><td>{w.meanError === null ? '—' : w.meanError.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  )
}
