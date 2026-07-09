/** Renders a schema.org JSON-LD block. Server component. */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // JSON.stringify does NOT escape `<`, so a provider-authored string
      // containing "</script>" could close the block (XSS). < is the
      // canonical JSON-LD escape (Phase 8 §8).
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  )
}
