import { martPageGate } from '@/lib/mart/gate'
import { CartClient } from './CartClient'

export default function MartCartPage() {
  martPageGate()
  return <CartClient />
}
