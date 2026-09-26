import { createServerClient } from '@supabase/ssr'
import { type NextRequest, NextResponse } from 'next/server'
import createNextIntlMiddleware from 'next-intl/middleware'
import { routing, LOCALE_PREFIX_PATTERN } from './i18n/routing'

const nextIntl = createNextIntlMiddleware(routing)

// Locale prefix stripper built from the single source of truth in i18n/routing.
const LOCALE_RE = new RegExp(`^/(${LOCALE_PREFIX_PATTERN})(/|$)`)

// Routes requiring authentication — matched against the path AFTER stripping the locale prefix.
// Role-level gating (provider/admin) deliberately does NOT live here: checking
// DB roles in middleware would add a round-trip to every request, so the
// (provider)/(admin) layouts enforce roles server-side instead.
const PROTECTED_PREFIXES = ['/app', '/partner/onboarding', '/partner/earnings', '/partner/listings', '/partner/rfqs', '/partner/orders', '/partner/profile', '/partner/settings', '/partner/privacy', '/admin']

// Experience v3 E5 (FR-5.1): with EXP_V3_CHECKOUT=on a signed-out visitor may
// open ONE path — a package checkout — and sign up inline on it. Read here
// with the same "on" rule as parseExperienceSetting (the edge bundle stays
// free of the shared package); percentages cannot apply without a user.
const GUEST_CHECKOUT_RE = /^\/app\/checkout\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function guestCheckoutOn(): boolean {
  const v = (process.env['EXP_V3_CHECKOUT'] ?? '').trim().toLowerCase()
  return v === 'on' || v === 'true' || v === '100'
}

// next-intl 3.x open redirect (GHSA-8f24-v5vv-gm5j, audit M25): for
// /en/%09/evil.example the locale redirect drops "/en", and URL parsing then
// drops the tab, leaving "//evil.example" (another host). next-intl >= 4.9.1
// strips tab / CR / LF itself; these two guards stay as defence in depth:
// refuse paths with control characters or backslashes (encoded or not) before
// next-intl sees them, and never pass on a redirect that leaves this origin.
const HOSTILE_PATH_CHARS = /[\u0000-\u001F\u007F\\]/
function hostilePath(pathname: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return true
  }
  return HOSTILE_PATH_CHARS.test(pathname) || HOSTILE_PATH_CHARS.test(decoded)
}

function stripLocale(pathname: string): string {
  return pathname.replace(LOCALE_RE, '/').replace(/\/$/, '') || '/'
}

function makeSupabase(request: NextRequest, response: NextResponse) {
  return createServerClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          // Only set on response if it is not a redirect from intl middleware
          if (response.status < 300 || response.status >= 400) {
            cookiesToSet.forEach(({ name, value, options }) =>
              response.cookies.set(name, value, options),
            )
          }
        },
      },
    },
  )
}

export async function middleware(request: NextRequest) {
  if (hostilePath(request.nextUrl.pathname)) return new NextResponse(null, { status: 400 })

  // Apply next-intl locale routing first
  const intlResponse = nextIntl(request)
  const intlLocation = intlResponse?.headers.get('location')
  if (intlLocation && new URL(intlLocation, request.url).origin !== request.nextUrl.origin) {
    return NextResponse.redirect(new URL('/', request.url))
  }

  // Build a mutable response; intlResponse may be a redirect (locale detection)
  let response = intlResponse ?? NextResponse.next({ request })

  const path = stripLocale(request.nextUrl.pathname)

  // Detect current locale for building redirect URLs
  const localeMatch = request.nextUrl.pathname.match(LOCALE_RE)
  const locale = localeMatch ? localeMatch[1] : 'en'
  const localePrefix = locale === 'en' ? '' : `/${locale}`

  // ── Phase 8a gateway bypass ─────────────────────────────────────────────
  // Logged-in users never see the anonymous gateway at `/`: redirect them to
  // their role home BEFORE first paint. Cookie sniff first so anonymous
  // visitors (no sb-* auth cookie) keep the zero-network fast path and `/`
  // stays static.
  const isRedirect = response.status >= 300 && response.status < 400
  if (path === '/' && !isRedirect) {
    const hasAuthCookie = request.cookies
      .getAll()
      .some((c) => c.name.startsWith('sb-') && c.name.includes('-auth-token'))
    if (hasAuthCookie) {
      const supabase = makeSupabase(request, response)
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (user) {
        // Same resolution order as /api/v1/profile/me (admin → provider → msme).
        // Own-row reads under RLS; a missing row simply yields null.
        const [{ data: u }, { data: provider }, { data: msme }] = await Promise.all([
          supabase.from('users').select('roles').eq('id', user.id).maybeSingle(),
          supabase.from('provider_profiles').select('id, status').eq('user_id', user.id).maybeSingle(),
          supabase.from('msme_profiles').select('id').eq('user_id', user.id).maybeSingle(),
        ])
        const roles: string[] = u?.roles ?? []
        // Active providers land on /partner; a buyer who merely APPLIED to be a
        // provider (pending/under_review/rejected) keeps their buyer home.
        const destination =
          roles.includes('admin') || roles.includes('ops')
            ? '/admin/verifications'
            : provider && (provider.status === 'active' || !msme)
              ? '/partner'
              : msme
                ? '/app'
                : '/signup?complete=1'
        return NextResponse.redirect(new URL(`${localePrefix}${destination}`, request.url))
      }
    }
    return response
  }

  // Fast path: public marketing/catalog pages (/services, /p, …) are not
  // protected. Skip the Supabase auth round-trip entirely so SSR/ISR stays fast.
  const needsAuthCheck = PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))
  if (!needsAuthCheck) {
    return response
  }

  // Supabase SSR client that reads cookies and can update the session cookie
  const supabase = makeSupabase(request, response)

  // Refresh session (this also updates the cookie expiry)
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    if (GUEST_CHECKOUT_RE.test(path) && guestCheckoutOn()) return response
    const loginUrl = new URL(`${localePrefix}/login`, request.url)
    // Locale-STRIPPED path: the login page pushes `next` through the next-intl
    // router, which re-prefixes the active locale — a raw /hi/... here would
    // become /hi/hi/... and 404.
    // The query rides along (e.g. a checkout's ?tier=), so the intent survives signup (E0 / U1).
    loginUrl.searchParams.set('next', `${path}${request.nextUrl.search}`)
    return NextResponse.redirect(loginUrl)
  }

  // For admin routes, we can't cheaply check DB role in middleware without extra latency.
  // The layout server component does the role check and redirects if insufficient.
  // Middleware only ensures the user is authenticated.

  return response
}

export const config = {
  matcher: [
    // Skip static files, _next internals, api routes, and favicon
    // Metadata image routes (opengraph-image-*, twitter-image-*) live under
    // [locale] and carry no file extension — leave them alone or the default-
    // locale redirect turns every WhatsApp card preview into a 307 → 404.
    '/((?!api|_next|_vercel|.*\\..*|.*(?:opengraph|twitter)-image.*).*)',
  ],
}
