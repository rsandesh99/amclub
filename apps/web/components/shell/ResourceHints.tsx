/**
 * Early-connection and font preload hints as real `<link>` elements. React 19
 * hoists them into `<head>` during streaming SSR, so the browser's preload
 * scanner sees the body font in the first bytes of HTML instead of after the
 * CSS parse. (The `preload()`/`preconnect()` hint APIs, and next/font's own
 * hint, never reached the head on this app — see lib/fonts/preload-hrefs.ts.)
 * Server component; renders no DOM of its own in the body.
 */
export function ResourceHints({ fonts, origins }: { fonts: string[]; origins: string[] }) {
  return (
    <>
      {origins.map((o) => (
        <link key={o} rel="preconnect" href={o} crossOrigin="anonymous" />
      ))}
      {fonts.map((href) => (
        <link key={href} rel="preload" as="font" type="font/woff2" href={href} crossOrigin="anonymous" fetchPriority="high" />
      ))}
    </>
  )
}
