import { createServerClient } from '@supabase/ssr'
import { type NextRequest, NextResponse } from 'next/server'
import createNextIntlMiddleware from 'next-intl/middleware'
import { routing } from './i18n/routing'

const nextIntl = createNextIntlMiddleware(routing)

// Routes requiring authentication — matched against the path AFTER stripping the locale prefix
const PROTECTED_PREFIXES = ['/app', '/partner/onboarding', '/partner/earnings', '/partner/listings', '/partner/rfqs', '/partner/orders', '/partner/profile', '/admin']

// Routes that require the provider role specifically (not just auth)
const PROVIDER_PREFIXES = ['/partner/onboarding', '/partner/earnings', '/partner/listings', '/partner/rfqs', '/partner/orders', '/partner/profile']

// Routes that require admin/ops role
const ADMIN_PREFIXES = ['/admin']

export async function middleware(request: NextRequest) {
  // Apply next-intl locale routing first
  const intlResponse = nextIntl(request)

  // Build a mutable response; intlResponse may be a redirect (locale detection)
  let response = intlResponse ?? NextResponse.next({ request })

  // Fast path: public marketing/catalog pages (/, /services, /p, …) are not
  // protected. Skip the Supabase auth round-trip entirely so SSR/ISR stays fast.
  const path = request.nextUrl.pathname.replace(/^\/(en|hi)(\/|$)/, '/').replace(/\/$/, '') || '/'
  const needsAuthCheck = PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))
  if (!needsAuthCheck) {
    return response
  }

  // Supabase SSR client that reads cookies and can update the session cookie
  const supabase = createServerClient(
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

  // Refresh session (this also updates the cookie expiry)
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  // Strip locale prefix (e.g. /hi/app → /app; /app → /app since en has no prefix)
  const localePattern = /^\/(en|hi)(\/|$)/
  const cleanPath = pathname.replace(localePattern, '/').replace(/\/$/, '') || '/'

  // Detect current locale for building redirect URLs
  const localeMatch = pathname.match(/^\/(en|hi)(\/|$)/)
  const locale = localeMatch ? localeMatch[1] : 'en'
  const localePrefix = locale === 'en' ? '' : `/${locale}`

  const isProtected = PROTECTED_PREFIXES.some((p) => cleanPath === p || cleanPath.startsWith(`${p}/`))

  if (isProtected && !user) {
    const loginUrl = new URL(`${localePrefix}/login`, request.url)
    loginUrl.searchParams.set('next', pathname)
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
    '/((?!api|_next|_vercel|.*\\..*).*)',
  ],
}
