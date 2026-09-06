import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { GATEWAY_ENABLED } from '@/lib/flags'
import { LegacyLanding } from '@/components/landing/LegacyLanding'
import { PublicHeader } from '@/components/catalog/PublicHeader'
import { PublicFooter } from '@/components/catalog/PublicFooter'
import { GatewayLazy as Gateway } from '@/components/gateway/GatewayLazy'

// ISR — `/` refreshes hourly (§ Phase 3 SEO; gateway itself is static markup,
// the legacy fallback fetches catalog data).
export const revalidate = 3600

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'gateway' })
  return {
    title: { absolute: t('meta_title') },
    description: t('meta_description'),
  }
}

export default function RootPage() {
  // Logged-in users never reach this render — middleware redirects them to
  // their role home before first paint (see middleware.ts gateway bypass).
  if (!GATEWAY_ENABLED) {
    return (
      <div className="flex min-h-screen flex-col">
        <PublicHeader />
        <main className="flex-1">
          <LegacyLanding />
        </main>
        <PublicFooter />
      </div>
    )
  }

  return <Gateway />
}
