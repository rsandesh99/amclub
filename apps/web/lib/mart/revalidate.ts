import { revalidatePath } from 'next/cache'

/**
 * On-demand ISR purge for Mart pages (mirrors lib/catalog/revalidate.ts).
 * The public Mart pages are statically cached at the edge (revalidate = 60–300s);
 * every catalog mutation that changes what buyers see calls this so a newly
 * approved, edited or paused listing is live within seconds, not minutes.
 * Vercel's ISR cache honours LITERAL paths only, so every locale prefix is
 * purged explicitly ('' = default-locale URL, '/en' = its rewritten path).
 */
const LOCALES = ['', '/en', '/hi', '/te', '/ta']

export function revalidateMart(opts: { productId?: string; categorySlug?: string; providerSlug?: string } = {}) {
  for (const l of LOCALES) {
    revalidatePath(`${l}/mart`)
    if (opts.categorySlug) revalidatePath(`${l}/mart/c/${opts.categorySlug}`)
    if (opts.productId) revalidatePath(`${l}/mart/p/${opts.productId}`)
    if (opts.providerSlug) revalidatePath(`${l}/p/${opts.providerSlug}`)
  }
  revalidatePath('/[locale]/(mart-public)/mart/c/[slug]', 'page')
  revalidatePath('/[locale]/(mart-public)/mart/p/[id]', 'page')
}
