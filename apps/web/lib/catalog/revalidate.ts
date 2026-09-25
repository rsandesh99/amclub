import { revalidatePath } from 'next/cache'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * Vercel's distributed ISR cache only honours LITERAL paths, and the Data/
 * Route caches are keyed on the REWRITTEN path — so every public URL must be
 * purged twice: '' is the default-locale public URL and '/en' is the internal
 * path the middleware rewrites it to (localePrefix: 'as-needed'). Verified
 * empirically in the Phase-8 emergency-takedown work (admin/providers/[id]).
 */
const LOCALES = ['', '/en', '/hi', '/te', '/ta']

/**
 * Refresh the public ISR pages affected by a package publish/edit so changes
 * appear within seconds (done-criterion: live in <5s). Safe to over-revalidate.
 */
export function revalidateCatalog(opts: {
  categorySlug?: string
  providerSlug?: string
  packageSlug?: string
}) {
  for (const l of LOCALES) {
    revalidatePath(l === '' ? '/' : l)
    revalidatePath(`${l}/services`)
    if (opts.categorySlug) revalidatePath(`${l}/services/${opts.categorySlug}`)
    if (opts.providerSlug) {
      revalidatePath(`${l}/p/${opts.providerSlug}`)
      if (opts.packageSlug) revalidatePath(`${l}/p/${opts.providerSlug}/${opts.packageSlug}`)
    }
  }
  // Belt-and-braces for runtimes where pattern purges work.
  if (opts.providerSlug) {
    // Every page under the provider layout (profile, reviews, packages) — the (public-provider) group.
    revalidatePath('/[locale]/(public-provider)/p/[providerSlug]', 'layout')
  }
}

/**
 * Purge EVERY public page that can show a provider: their profile, each of
 * their package pages, every category listing they appear in, /services, and
 * the home page. Used when their visibility flips (admin approve/reject,
 * suspend/reactivate) so the change is live in seconds, not after the ISR
 * window expires.
 */
export async function revalidateProviderCatalog(admin: Admin, providerId: string): Promise<void> {
  const [{ data: prof }, { data: pkgs }, { data: cats }] = await Promise.all([
    admin.from('provider_profiles').select('slug').eq('id', providerId).maybeSingle(),
    admin.from('packages').select('slug').eq('provider_id', providerId).is('deleted_at', null),
    admin.from('provider_categories').select('category:categories(slug)').eq('provider_id', providerId),
  ])
  const providerSlug = prof?.slug
  if (!providerSlug) return

  for (const l of LOCALES) {
    revalidatePath(l === '' ? '/' : l)
    revalidatePath(`${l}/services`)
    revalidatePath(`${l}/p/${providerSlug}`)
    for (const p of pkgs ?? []) revalidatePath(`${l}/p/${providerSlug}/${p.slug}`)
    for (const c of cats ?? []) {
      const slug = (c.category as { slug?: string } | null)?.slug
      if (slug) revalidatePath(`${l}/services/${slug}`)
    }
  }
  // Every page under the provider layout (profile, reviews, packages) — the (public-provider) group.
  revalidatePath('/[locale]/(public-provider)/p/[providerSlug]', 'layout')
}
