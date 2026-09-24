import sharp, { type Sharp } from 'sharp'

/**
 * Decoding user-uploaded images (audit H10). The multipart Content-Type is the
 * client's claim, and sharp picks its decoder from the bytes, so the type check
 * alone let a crafted HEIF / AVIF / TIFF / SVG reach libheif, libtiff or librsvg.
 *
 * Two guards:
 * 1. `sniffUploadImage`: the bytes must be JPEG, PNG or WebP, and must match
 *    the declared type.
 * 2. Every libvips loader except JPEG, PNG and WebP is blocked for this
 *    process, so nothing else is ever decoded, whatever a later caller passes.
 */
sharp.block({ operation: ['VipsForeignLoad'] })
sharp.unblock({ operation: ['VipsForeignLoadJpeg', 'VipsForeignLoadPng', 'VipsForeignLoadWebp'] })

export type UploadImageType = 'image/jpeg' | 'image/png' | 'image/webp'

export const UPLOAD_IMAGE_TYPES: ReadonlySet<string> = new Set<UploadImageType>(['image/jpeg', 'image/png', 'image/webp'])

/** The image type the bytes actually are, or null for anything else. */
export function sniffUploadImage(buf: Buffer): UploadImageType | null {
  if (buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

/** 40 megapixels: far above any phone photo, far below a decompression bomb. */
const MAX_INPUT_PIXELS = 40_000_000

/**
 * A sharp pipeline over upload bytes, or null when the bytes are not the
 * declared JPEG / PNG / WebP. sharp's default `failOn: 'warning'` still fails
 * truncated or corrupt input.
 */
export function openUploadImage(buf: Buffer, declared: string): Sharp | null {
  const actual = sniffUploadImage(buf)
  if (!actual || actual !== declared) return null
  return sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS })
}
