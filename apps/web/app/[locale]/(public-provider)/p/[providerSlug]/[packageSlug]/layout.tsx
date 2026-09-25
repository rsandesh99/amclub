import { notFound } from 'next/navigation'
import { isPackagePublic } from '@/lib/catalog/queries'

/** The package must be public before its page renders: above the page's loading boundary, so a missing package is HTTP 404. */
export default async function PackageSegmentLayout({ children, params }: { children: React.ReactNode; params: Promise<{ providerSlug: string; packageSlug: string }> }) {
  const { providerSlug, packageSlug } = await params
  if (!(await isPackagePublic(providerSlug, packageSlug))) notFound()
  return children
}
