import 'server-only'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Hashed URLs of the fonts next/font marks as preloadable for the root
 * layout (the Latin Noto Sans subset and the 2 KB rupee face).
 *
 * Why this exists: next/font emits its preload as a React resource hint from
 * the server-component layer. On this app (Next 15.5, streaming) those hints
 * only reach the RSC payload, never the HTML `<head>` — measured: no
 * `<link rel="preload" as="font">` on any page, so the browser discovered the
 * body font only after CSS parse and behind the JS queue (+1–3 s of LCP
 * "render delay" on simulated 4G). The layout passes these hrefs to
 * `<ResourceHints>`, a client component whose hints DO render into the head.
 *
 * Reads the build manifest once; on any failure returns [] (the page still
 * works — it only loses the preload).
 */
let cached: string[] | null = null

export function fontPreloadHrefs(): string[] {
  if (cached) return cached
  try {
    const raw = readFileSync(join(process.cwd(), '.next', 'server', 'next-font-manifest.json'), 'utf8')
    const manifest = JSON.parse(raw) as { app?: Record<string, string[]> }
    const files = new Set<string>()
    for (const [entry, list] of Object.entries(manifest.app ?? {})) {
      if (/[\\/]app[\\/]\[locale\][\\/]layout$/.test(entry)) for (const f of list) files.add(f)
    }
    cached = [...files].map((f) => `/_next/${f}`)
  } catch {
    cached = []
  }
  return cached
}
