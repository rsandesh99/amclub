import { martPageGate } from '@/lib/mart/gate'
import AdminLayout from '../(admin)/layout'

/**
 * AMC Mart route group (MART_DESIGN.md §0 hard-404 rule). The admin group
 * streams through its loading.tsx, so a notFound() thrown by a Mart page or
 * segment layout arrives AFTER the 200 headers and the 404 UI ships as a 200
 * (found by the flag-OFF inertness run). This group has no loading boundary
 * above the gate: with MART_ENABLED=false the whole subtree is a real 404
 * before any shell renders. Same URLs, same shell as the admin group.
 */
export default function MartGroupLayout({ children }: { children: React.ReactNode }) {
  martPageGate()
  return <AdminLayout>{children}</AdminLayout>
}
