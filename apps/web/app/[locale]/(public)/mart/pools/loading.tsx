import { CatalogueSkeleton } from '@/components/mart/skeletons'

export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mart-skeleton mb-4 h-8 w-48" />
      <CatalogueSkeleton cards={6} />
    </div>
  )
}
