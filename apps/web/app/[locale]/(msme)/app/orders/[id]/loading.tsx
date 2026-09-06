import { OrderWorkspaceSkeleton } from '@/components/mart/skeletons'

/** Shared by services and goods orders — the skeleton is kind-neutral (card shapes only). */
export default function Loading() {
  return (
    <div className="min-h-screen bg-background">
      <OrderWorkspaceSkeleton />
    </div>
  )
}
