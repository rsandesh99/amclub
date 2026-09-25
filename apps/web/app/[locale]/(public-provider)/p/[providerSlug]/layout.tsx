import { notFound } from 'next/navigation'
import { isProviderPublic } from '@/lib/catalog/queries'

/**
 * The provider must be public before anything under /p/<slug> renders. This
 * layout sits above the pages' loading boundaries, so an unknown, suspended or
 * deleted provider answers HTTP 404 (the pages keep their own notFound() as a
 * fallback for a provider that disappears between the two reads).
 */
export default async function ProviderSegmentLayout({ children, params }: { children: React.ReactNode; params: Promise<{ providerSlug: string }> }) {
  const { providerSlug } = await params
  if (!(await isProviderPublic(providerSlug))) notFound()
  return children
}
