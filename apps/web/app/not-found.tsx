/**
 * Root 404 — reached only for paths that fall outside the [locale] tree
 * (the locale segment has its own not-found). The root layout is a
 * pass-through, so this page must render <html>/<body> itself; without it
 * Next's built-in 404 ships an <html> with no lang attribute (axe serious).
 * Outside the locale context next-intl is unavailable — en copy by design.
 */
import Link from 'next/link'

export default function RootNotFound() {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', background: '#FAFAF7', color: '#1A1D1A' }}>
        <main
          style={{
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.75rem',
            padding: '1.5rem',
            textAlign: 'center',
          }}
        >
          <p style={{ fontSize: '3rem', fontWeight: 700, margin: 0, color: '#1B4D3E' }}>404</p>
          <h1 style={{ fontSize: '1.25rem', margin: 0 }}>Page not found</h1>
          <p style={{ margin: 0, color: '#5C645C' }}>The page you are looking for does not exist.</p>
          <Link
            href="/"
            style={{
              marginTop: '0.75rem',
              display: 'inline-block',
              background: '#1B4D3E',
              color: '#FFFFFF',
              borderRadius: '10px',
              padding: '0.7rem 1.4rem',
              textDecoration: 'none',
              fontWeight: 500,
            }}
          >
            Go to AMClub home
          </Link>
        </main>
      </body>
    </html>
  )
}
