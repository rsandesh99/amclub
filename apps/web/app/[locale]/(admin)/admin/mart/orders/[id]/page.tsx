import { martPageGate } from '@/lib/mart/gate'
import { MartOrderDossierClient } from './MartOrderDossierClient'

/**
 * AMC Mart — payout-evidence dossier for one goods order (MART_DESIGN.md
 * §4.3/§5). Flag-gated like every Mart surface: 404 while MART_ENABLED is OFF.
 */
export default async function AdminMartOrderPage({ params }: { params: Promise<{ id: string }> }) {
  martPageGate()
  const { id } = await params
  return <MartOrderDossierClient id={id} />
}
