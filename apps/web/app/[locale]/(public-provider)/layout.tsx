import PublicLayout from '../(public)/layout'

/**
 * Public provider and package pages (/p/...). Same URLs and the same shell as
 * the public group, but NOT under its loading.tsx: a notFound() thrown below a
 * loading boundary arrives after the 200 headers, so a missing provider or
 * package shipped the 404 UI as HTTP 200 (a soft 404). Here the existence
 * checks run in the segment layouts ABOVE each page's own loading.tsx, so an
 * unknown slug is a real 404 while a real page still streams its skeleton —
 * the same pattern as the (mart-public) group.
 */
export default function PublicProviderLayout({ children }: { children: React.ReactNode }) {
  return <PublicLayout>{children}</PublicLayout>
}
