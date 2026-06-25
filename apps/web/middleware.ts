import createMiddleware from 'next-intl/middleware'
import { routing } from './i18n/routing'

export default createMiddleware(routing)

export const config = {
  // Match all pathnames except for:
  // - /api/* (route handlers)
  // - /_next/* (Next.js internals)
  // - /static/* (static files)
  // - Files with extensions (images, fonts, etc.)
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
}
