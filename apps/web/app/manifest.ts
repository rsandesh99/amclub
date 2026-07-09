import type { MetadataRoute } from 'next'

/**
 * PWA manifest (Phase 8 §5). Next serves this at /manifest.webmanifest and
 * injects the <link> automatically. Copy is en-only by web-manifest design
 * (one manifest per origin; installers don't localise).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'AMClub — Every service your business needs',
    short_name: 'AMClub',
    description:
      "India's trusted B2B services marketplace for MSMEs — legal, CA, HR, marketing and more. Verified providers, safe payments.",
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    theme_color: '#1B4D3E',
    background_color: '#FAFAF7',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
