import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'

/**
 * `generateMetadata` for a signed-in group or section layout: the tab title is
 * the section's own name from an existing message (the nav label or the page
 * heading) plus the brand, "Orders | AMClub". Pages below that set no title
 * inherit it.
 *
 * `default` is run through the parent's "%s | AMClub" template, and the
 * template is declared again because a layout that sets a title replaces the
 * inherited template — without it a page below with its own title would lose
 * the brand.
 */
export function sectionTitle(namespace: string, key: string) {
  return async function generateMetadata(): Promise<Metadata> {
    const [t, tCommon] = await Promise.all([getTranslations(namespace), getTranslations('common')])
    return { title: { default: t(key), template: `%s | ${tCommon('app_name')}` } }
  }
}
