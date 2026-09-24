import type { Metadata, Viewport } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages, getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import localFont from 'next/font/local'
import { routing } from '@/i18n/routing'
import { PostHogProvider } from '@/components/providers/posthog'
import { AnalyticsConsentNotice } from '@/components/consent/AnalyticsConsentNotice'
import { ANALYTICS_CONSENT_REQUIRED } from '@/lib/public-flags'
import { ToastProvider } from '@/components/ui/toast'
import { PwaManager } from '@/components/pwa/PwaManager'
import { ResourceHints } from '@/components/shell/ResourceHints'
import { fontPreloadHrefs } from '@/lib/fonts/preload-hrefs'
import { isOnForEveryone } from '@/lib/experiments'
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
//
// Self-hosted (PRD E1 / §7.3): the variable-weight latin subset (100–900 in
// one 35 KB file) ships in app/fonts, so builds never fetch Google Fonts —
// that fetch is what flaked the axe job ("Cannot read properties of null").
// Files: @fontsource-variable/noto-sans* 5.3.0, SIL OFL 1.1 (app/fonts/OFL-noto.txt).
const notoSans = localFont({
  src: './../fonts/noto-sans-latin-var.woff2',
  variable: '--font-sans',
  weight: '100 900',
  display: 'optional',
  adjustFontFallback: 'Arial',
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
const notoDevanagari = localFont({
  src: './../fonts/noto-sans-devanagari-var.woff2',
  variable: '--font-indic',
  weight: '100 900',
  display: 'optional',
  preload: false,
  adjustFontFallback: false,
})

const notoTelugu = localFont({
  src: './../fonts/noto-sans-telugu-var.woff2',
  variable: '--font-indic',
  weight: '100 900',
  display: 'optional',
  preload: false,
  adjustFontFallback: false,
})

const notoTamil = localFont({
  src: './../fonts/noto-sans-tamil-var.woff2',
  variable: '--font-indic',
  weight: '100 900',
  display: 'optional',
  preload: false,
  adjustFontFallback: false,
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

  // Experience v3 tokens for everyone only when EXP_V3_SHELL=on (static pages
  // can't bucket by user); cohort / percentage users get v3 from their
  // logged-in shell's own data-ui wrapper.
  const v3 = isOnForEveryone('shell')

  return (
    <html
      lang={locale}
      className={`${notoRupee.variable} ${notoSans.variable}${indic ? ` ${indic.variable}` : ''}`}
      {...(v3 ? { 'data-ui': 'v3' } : {})}
    >
      <body className="bg-background font-sans text-foreground antialiased">
        {/* v3 materials: solid bars on low-memory devices (PRD §3.4.3). Tiny, sync, before paint. */}
        <script
          dangerouslySetInnerHTML={{
            __html: "try{var m=navigator.deviceMemory;if(m&&m<=2)document.documentElement.setAttribute('data-lowmem','')}catch(e){}",
          }}
        />
        <ResourceHints fonts={fonts} origins={hintOrigins} />
        <NextIntlClientProvider messages={messages}>
          <PostHogProvider>
            <ToastProvider>{children}</ToastProvider>
          </PostHogProvider>
          <PwaManager />
          {/* E17 (gated D-UX2) — rendered only when consent is required; off = nothing, as before. */}
          {ANALYTICS_CONSENT_REQUIRED && <AnalyticsConsentNotice />}
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
