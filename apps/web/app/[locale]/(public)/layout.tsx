import { PublicHeader } from '@/components/catalog/PublicHeader'
import { PublicFooter } from '@/components/catalog/PublicFooter'

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <PublicHeader />
      <main className="flex-1">{children}</main>
      <PublicFooter />
    </div>
  )
}
