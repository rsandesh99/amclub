/** Public URL for a key in the public-assets bucket (product images). */
export function publicAssetUrl(key: string): string {
  const base = process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? ''
  return `${base}/storage/v1/object/public/public-assets/${key}`
}
