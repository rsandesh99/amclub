import type { Metadata, Viewport } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages, getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import {
  Inter,
  Bricolage_Grotesque,
  Noto_Sans_Devanagari,
  Noto_Sans_Telugu,
  Noto_Sans_Tamil,
} from 'next/font/google'
import { routing } from '@/i18n/routing'
import { PostHogProvider } from '@/components/providers/posthog'
import { ToastProvider } from '@/components/ui/toast'
import { PwaManager } from '@/components/pwa/PwaManager'
import '@/app/globals.css'

// PWA chrome color (Phase 8 §5) — matches manifest theme_color.
export const viewport: Viewport = {
  themeColor: '#1B4D3E',
}

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-bricolage',
  display: 'swap',
})

// Indic companions (§4.2) — all three publish the SAME CSS variable
// (--font-indic, referenced by the Tailwind sans/display stacks) and only the
// active locale's class lands on <html>, so exactly one resolves per page and
// the other scripts are never downloaded. preload:false keeps them off the
// critical path (they would be dead weight on en pages).
const notoDevanagari = Noto_Sans_Devanagari({
  subsets: ['devanagari'],
  variable: '--font-indic',
  display: 'swap',
  preload: false,
})

const notoTelugu = Noto_Sans_Telugu({
  subsets: ['telugu'],
  variable: '--font-indic',
  display: 'swap',
  preload: false,
})

const notoTamil = Noto_Sans_Tamil({
  subsets: ['tamil'],
  variable: '--font-indic',
  display: 'swap',
  preload: false,
})

const INDIC_FONT: Record<string, { variable: string } | undefined> = {
  hi: notoDevanagari,
  te: notoTelugu,
  ta: notoTamil,
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'common' })

  return {
    title: {
      template: `%s | ${t('app_name')}`,
      default: t('app_name'),
    },
    description: t('tagline'),
  }
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }))
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params

  if (!(routing.locales as readonly string[]).includes(locale)) {
    notFound()
  }

  const messages = await getMessages()

  const indic = INDIC_FONT[locale]

  return (
    <html
      lang={locale}
      className={`${inter.variable} ${bricolage.variable}${indic ? ` ${indic.variable}` : ''}`}
    >
      <body className="bg-background font-sans text-foreground antialiased">
        <NextIntlClientProvider messages={messages}>
          <PostHogProvider>
            <ToastProvider>{children}</ToastProvider>
          </PostHogProvider>
          <PwaManager />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
