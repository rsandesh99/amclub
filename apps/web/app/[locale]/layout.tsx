import type { Metadata, Viewport } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages, getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import {
  Noto_Sans,
  Noto_Sans_Devanagari,
  Noto_Sans_Telugu,
  Noto_Sans_Tamil,
} from 'next/font/google'
import localFont from 'next/font/local'
import { routing } from '@/i18n/routing'
import { PostHogProvider } from '@/components/providers/posthog'
import { ToastProvider } from '@/components/ui/toast'
import { PwaManager } from '@/components/pwa/PwaManager'
import { ResourceHints } from '@/components/shell/ResourceHints'
import { fontPreloadHrefs } from '@/lib/fonts/preload-hrefs'
import '@/app/globals.css'

// PWA chrome color (Phase 8 §5) — matches manifest theme_color.
export const viewport: Viewport = {
  themeColor: '#1B4D3E',
}

// FRONTEND.md v2 §2.4 — Noto Sans is the one Latin face (cross-script harmony
// with the Indic companions below); hierarchy is size + weight. Replaces the
// Inter + Bricolage pair: one family, four weights, self-hosted by next/font,
// preloaded, no layout shift (size-adjusted fallback).
// display:'optional' — on a first 4G visit the page paints at once in the
// system face (Android ships Noto/Roboto; metrics-matched fallback, no
// shift) and the web font is used from the second navigation on. 'swap'
// re-painted the LCP text 3–4s later on simulated 4G (measured: LCP 5.2s →
// dominated by "render delay" waiting on fonts).
const notoSans = Noto_Sans({
  subsets: ['latin'],
  // 500 is `font-medium` — every Button / Badge / Label (240+ usages); without
  // it the browser snapped those to 400 and the hierarchy flattened.
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'optional',
  adjustFontFallback: true,
})

// The rupee sign. Google's Noto Sans keeps U+20B9 in its DEVANAGARI subset,
// so every price on an English page pulled a 98 KB font file for one glyph
// (measured on /mart, /services and the product page). This is that glyph
// alone — Noto Sans's own ₹ and ₨ outlines, variable weight, 2 KB — listed
// FIRST in the Tailwind font stacks so the browser never reaches the big
// subset for it. The full Devanagari face still loads on Hindi pages.
const notoRupee = localFont({
  src: './../fonts/noto-sans-rupee.woff2',
  variable: '--font-rupee',
  weight: '100 900',
  display: 'swap',
  preload: true,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'U+20B9, U+20A8' }],
})

// Indic companions (§4.2) — all three publish the SAME CSS variable
// (--font-indic, referenced by the Tailwind sans/display stacks) and only the
// active locale's class lands on <html>, so exactly one resolves per page and
// the other scripts are never downloaded. preload:false keeps them off the
// critical path (they would be dead weight on en pages).
const notoDevanagari = Noto_Sans_Devanagari({
  subsets: ['devanagari'],
  variable: '--font-indic',
  display: 'optional',
  preload: false,
})

const notoTelugu = Noto_Sans_Telugu({
  subsets: ['telugu'],
  variable: '--font-indic',
  display: 'optional',
  preload: false,
})

const notoTamil = Noto_Sans_Tamil({
  subsets: ['tamil'],
  variable: '--font-indic',
  display: 'optional',
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

  // Every page's first data-bearing requests (storage images, client auth)
  // go to the Supabase origin — open the connection during HTML parse. The
  // two preloadable fonts ride the same hint component (see ResourceHints).
  const supabaseOrigin = process.env['NEXT_PUBLIC_SUPABASE_URL']
  const hintOrigins = supabaseOrigin ? [supabaseOrigin] : []
  const fonts = fontPreloadHrefs()

  return (
    <html
      lang={locale}
      className={`${notoRupee.variable} ${notoSans.variable}${indic ? ` ${indic.variable}` : ''}`}
    >
      <body className="bg-background font-sans text-foreground antialiased">
        <ResourceHints fonts={fonts} origins={hintOrigins} />
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
