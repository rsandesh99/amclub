import type { Metadata } from 'next'
import { UiGallery } from '@/components/ui-v3/UiGallery'

export const metadata: Metadata = { title: 'UI v3', robots: { index: false, follow: false } }

/**
 * PRD E1 FR-1.2 — the v3 component gallery: every component in its states,
 * in Comfortable and Compact, in the page's locale (switch locale in the URL
 * to review hi / te / ta). Admin-only (the (admin) layout gates the role),
 * never indexed. Always renders the v3 tokens, whatever the rollout flag.
 */
export default function DevUiPage() {
  return <UiGallery />
}
