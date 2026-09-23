import { redirect, notFound } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { createAdminClient, createClient, createPublicClient } from '@/lib/supabase/server'
import { activeAddonsFor, addonsOn } from '@/lib/addons'
import { getSessionUser, getMsmeProfile, type SessionUser } from '@/lib/auth/session'
import { addonIdsSchema, computeOrderAmounts, isValidGstin, ORDER_ACCEPT_WINDOW_HOURS, packageCharge, packageChargeDisplay, priceDisplay, resolveAddonSelection, rfqFieldLabel } from '@amclub/shared'
import { pickI18n } from '@/lib/format'
import { COUPONS_ENABLED } from '@/lib/flags'
import { isOnFor, isOnForEveryone } from '@/lib/experiments'
import { CheckoutV3, type CheckoutAddonLine, type CheckoutMode } from '@/components/checkout-v3/CheckoutV3'
import { CheckoutClient } from './CheckoutClient'

interface RequirementField {
  name: string
  label_en?: string
  label_hi?: string
}

/**
 * Experience v3 E5 (flag `checkout`). Guests and signed-in users read the
 * package through the anon client (public, active rows only); the buyer's own
 * GSTIN decides the ITC line (checksum-valid only; shown masked).
 */
async function CheckoutV3Page({ packageId, user, addonParam }: { packageId: string; user: SessionUser | null; addonParam: string | undefined }) {
  const t = await getTranslations('checkout')
  const tv = await getTranslations('checkout_v3')
  const locale = await getLocale()
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const { data: pkg } = await createPublicClient()
    .from('packages')
    .select('id, title_i18n, price_paise, discount_bps, delivery_days, revision_count, requirements_template, provider:provider_profiles!inner(display_name, status, capacity_paused)')
    .eq('id', packageId)
    .eq('status', 'active')
    .is('deleted_at', null)
    .maybeSingle()
  const p = pkg as any
  if (!p || p.provider?.status !== 'active') notFound()
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const msme = user ? await getMsmeProfile(user.id) : null
  const mode: CheckoutMode = !user ? 'guest' : !msme ? 'profile' : 'pay'
  let profileGstin: string | null = null
  if (user && msme) {
    const { data } = await (await createClient()).from('msme_profiles').select('gstin').eq('user_id', user.id).maybeSingle()
    profileGstin = (data?.gstin as string | null | undefined)?.trim().toUpperCase() ?? null
  }
  const itc = !!profileGstin && isValidGstin(profileGstin)
  // E12a / ADR 019 — add-ons chosen in the buy box (`?addons=`), re-read and
  // priced here with the SAME packageCharge checkout freezes. Anything that is
  // no longer an active add-on of this package is dropped with a note.
  const wanted = addonIdsSchema.safeParse((addonParam ?? '').split(',').filter(Boolean))
  let addonLines: CheckoutAddonLine[] = []
  let addonIds: string[] = []
  let addonsDropped = false
  let charge: ReturnType<typeof packageCharge> | null = null
  if (wanted.success && wanted.data.length) {
    const admin = await createAdminClient()
    const sel = (await addonsOn(admin)) ? resolveAddonSelection(await activeAddonsFor(admin, p.id), wanted.data) : ({ ok: false } as const)
    if (sel.ok) {
      charge = packageCharge({ pricePaise: Number(p.price_paise), discountBps: p.discount_bps, commissionBps: 0, deliveryDays: p.delivery_days, revisionCount: p.revision_count ?? null, addons: sel.rows })
      addonIds = sel.rows.map((r) => r.id)
      addonLines = sel.rows.map((r) => ({ id: r.id, label: pickI18n(r.label_i18n, locale), pricePaise: Number(r.price_paise) }))
    } else {
      addonsDropped = true
    }
  } else if (addonParam) {
    addonsDropped = true
  }
  // Exactly what checkout charges (no coupon, no member price) — N16.
  const display = charge
    ? packageChargeDisplay(charge, { discountBps: p.discount_bps, buyerHasGstin: itc })
    : priceDisplay({ pricePaise: Number(p.price_paise), discountBps: p.discount_bps, buyerHasGstin: itc })
  const fields: RequirementField[] = (p.requirements_template as { fields?: RequirementField[] } | null)?.fields ?? []
  const labels = fields.map((f) => rfqFieldLabel(f, locale) || f.name).filter(Boolean).slice(0, 4)
  const nextSteps = [
    tv('next_accept', { provider: p.provider.display_name, hours: ORDER_ACCEPT_WINDOW_HOURS }),
    labels.length > 0 ? tv('next_share', { items: labels.join(', ') }) : tv('next_share_none'),
    tv('next_release'),
  ]

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <h1 className="mb-1 font-display text-2xl font-bold">{t('title')}</h1>
      <p className="mb-6 text-sm text-foreground-secondary">{t('subtitle')}</p>
      <CheckoutV3
        mode={mode}
        locale={locale}
        packageId={p.id}
        title={pickI18n(p.title_i18n, locale)}
        providerName={p.provider.display_name}
        deliveryDays={charge?.deliveryDays ?? p.delivery_days}
        display={display}
        addonIds={addonIds}
        addonLines={addonLines}
        addonsDropped={addonsDropped}
        itcGstinMasked={itc ? `${profileGstin!.slice(0, 4)}…${profileGstin!.slice(-2)}` : null}
        profileGstin={profileGstin}
        providerPaused={!!p.provider.capacity_paused}
        couponsEnabled={COUPONS_ENABLED}
        nextSteps={nextSteps}
      />
    </div>
  )
}

export default async function CheckoutPage({ params, searchParams }: { params: Promise<{ packageId: string }>; searchParams: Promise<{ addons?: string | string[] }> }) {
  const { packageId } = await params
  const addonParam = (await searchParams).addons
  const addonsRaw = Array.isArray(addonParam) ? addonParam.join(',') : addonParam
  const user = await getSessionUser()
  if (user ? isOnFor('checkout', user.id) : isOnForEveryone('checkout')) {
    if (!/^[0-9a-f-]{36}$/i.test(packageId)) notFound()
    return <CheckoutV3Page packageId={packageId} user={user} addonParam={addonsRaw} />
  }
  if (!user) redirect(`/login?next=/app/checkout/${packageId}`)

  const t = await getTranslations('checkout')
  const locale = await getLocale()
  const supabase = await createClient()

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const { data: pkg } = await supabase
    .from('packages')
    .select('id, title_i18n, price_paise, discount_bps, member_extra_discount_bps, delivery_days, provider:provider_profiles!inner(display_name, status, capacity_paused), category:categories(commission_bps)')
    .eq('id', packageId)
    .eq('status', 'active')
    .maybeSingle()
  const p = pkg as any
  if (!p || p.provider?.status !== 'active') notFound()

  const commissionBps = p.category?.commission_bps ?? 1000
  const amounts = computeOrderAmounts({ pricePaise: Number(p.price_paise), discountBps: p.discount_bps, commissionBps })
  const title = pickI18n(p.title_i18n, locale)
  // Prefill the invoice GSTIN from the buyer's profile (RLS: owner read).
  const { data: msme } = await supabase.from('msme_profiles').select('gstin').eq('user_id', user.id).maybeSingle()
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <h1 className="mb-1 font-display text-2xl font-bold">{t('title')}</h1>
      <p className="mb-6 text-sm text-foreground-secondary">{t('subtitle')}</p>
      <CheckoutClient
        packageId={p.id}
        title={title}
        providerName={p.provider.display_name}
        deliveryDays={p.delivery_days}
        amounts={amounts}
        couponsEnabled={COUPONS_ENABLED}
        profileGstin={(msme?.gstin as string | null | undefined) ?? null}
        providerPaused={!!p.provider?.capacity_paused}
      />
    </div>
  )
}
