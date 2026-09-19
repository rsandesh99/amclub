import { agentPageGate } from '@/lib/agent/gate'
import AdminLayout from '../(admin)/layout'

/**
 * Agent admin route group (ADR-009 §7 dark-build rule; mirrors (mart-admin)).
 * The admin group streams through its loading.tsx, so a page-level notFound()
 * would ship the 404 UI as a 200. This group gates FIRST — with
 * AGENT_ENABLED=false the whole /admin/agents subtree is a real 404 before any
 * shell renders. Same URLs, same shell as the admin group.
 */
export default function AgentAdminGroupLayout({ children }: { children: React.ReactNode }) {
  agentPageGate()
  return <AdminLayout>{children}</AdminLayout>
}
