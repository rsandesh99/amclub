import { revalidatePath } from 'next/cache'

/**
 * Refresh the public ISR pages affected by a package publish/edit so changes
 * appear within seconds (done-criterion: live in <5s). Both locales, since the
 * provider may have authored in either. Safe to over-revalidate.
 */
export function revalidateCatalog(opts: { categorySlug?: string; providerSlug?: string }) {
  const locales = ['en', 'hi']
  for (const l of locales) {
    revalidatePath(`/${l}`)
    revalidatePath(`/${l}/services`)
    if (opts.categorySlug) revalidatePath(`/${l}/services/${opts.categorySlug}`)
    if (opts.providerSlug) revalidatePath(`/${l}/p/${opts.providerSlug}`)
  }
}
