/** Renders a schema.org JSON-LD block. Server component. */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // Next.js-recommended pattern for structured data.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  )
}
