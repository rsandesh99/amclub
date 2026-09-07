import { martPageGate } from '@/lib/mart/gate'
import { MartSettingsClient } from './MartSettingsClient'

/**
 * Launch Gate — founder decisions (§9) editor. Flag-gated like every Mart
 * page; the admin layout already requires the admin/ops role.
 */
export default function AdminMartSettingsPage() {
  martPageGate()
  return <MartSettingsClient />
}
