import { getLocale, getTranslations } from 'next-intl/server'
import { BadgeCheck, FileText, Languages, MapPin } from 'lucide-react'
import { rfqMustHavesSchema, isEmptyMustHaves, rfqDocumentsExpectedSchema, isSpecializationOf, type CategorySlug } from '@amclub/shared'
import { createAdminClient, createPublicClient } from '@/lib/supabase/server'

/** Detail keys the v3 form adds; shown by RfqExtrasV3, not in the generic list. */
export const RFQ_V3_DETAIL_KEYS = ['service_slug', 'documents_expected'] as const

/**
 * Experience v3 E6 — what a v3 requirement adds, as the provider sees it: the
 * service, the buyer's must-haves (display only — fan-out is unchanged, D-PRD6)
 * and the documents the buyer expects to share. Renders nothing for a request
 * made with the older form. Every read is error-tolerant (0053 may be pending).
 */
export async function RfqExtrasV3({ rfqId, categorySlug, details, stateName }: { rfqId: string; categorySlug: string | null; details: Record<string, unknown>; stateName?: string | null }) {
  const t = await getTranslations('rfq_v3')
  const tc = await getTranslations('catalog')
  const ts = await getTranslations('services')
  const locale = await getLocale()

  const service = typeof details['service_slug'] === 'string' && categorySlug && isSpecializationOf(categorySlug as CategorySlug, details['service_slug']) ? details['service_slug'] : null
  const docsParsed = rfqDocumentsExpectedSchema.safeParse(details['documents_expected'])
  const docKeys = docsParsed.success ? docsParsed.data : []

  let mustHaves = null
  try {
    const { data, error } = await (await createAdminClient()).from('rfqs').select('must_haves').eq('id', rfqId).maybeSingle()
    if (!error && data?.must_haves) {
      const m = rfqMustHavesSchema.safeParse(data.must_haves)
      if (m.success && !isEmptyMustHaves(m.data)) mustHaves = m.data
    }
  } catch { /* column not there yet */ }

  let docLabels: string[] = []
  if (docKeys.length > 0 && categorySlug) {
    const { data } = await createPublicClient().from('service_document_requirements').select('doc_key, label_i18n').eq('category_slug', categorySlug).in('doc_key', docKeys)
    const byKey = new Map(((data ?? []) as { doc_key: string; label_i18n: Record<string, string> }[]).map((d) => [d.doc_key, d.label_i18n[locale] ?? d.label_i18n['en'] ?? d.doc_key]))
    docLabels = docKeys.map((k) => byKey.get(k) ?? k.replace(/_/g, ' '))
  }

  if (!service && !mustHaves && docLabels.length === 0) return null
  const chip = 'inline-flex items-center gap-1 rounded-chip bg-sunken px-2.5 py-1 text-xs'
  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4 text-sm" data-testid="rfq-extras">
      {service && (
        <p><span className="text-xs text-foreground-secondary">{t('service')}</span><br /><span className="font-medium">{ts(service as 'gst-filing')}</span></p>
      )}
      {mustHaves && (
        <div>
          <p className="text-xs text-foreground-secondary">{t('must_haves')}</p>
          <div className="mt-1 flex flex-wrap gap-1.5" data-testid="rfq-must-haves-view">
            {mustHaves.credentials.map((k) => <span key={k} className={chip}><BadgeCheck className="h-3 w-3" aria-hidden />{tc(`badge_${k}` as 'badge_gstin')}</span>)}
            {mustHaves.languages.map((l) => <span key={l} className={chip}><Languages className="h-3 w-3" aria-hidden />{tc(`lang_${l}` as 'lang_en')}</span>)}
            {mustHaves.onSite && <span className={chip}><MapPin className="h-3 w-3" aria-hidden />{t('on_site')}</span>}
            {mustHaves.inStateOnly && <span className={chip}><MapPin className="h-3 w-3" aria-hidden />{t('in_state_only', { state: stateName ?? '' })}</span>}
          </div>
        </div>
      )}
      {docLabels.length > 0 && (
        <div>
          <p className="text-xs text-foreground-secondary">{t('documents_buyer_has')}</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {docLabels.map((l) => <li key={l} className={chip}><FileText className="h-3 w-3" aria-hidden />{l}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}
