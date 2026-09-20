/**
 * dHash (difference hash) for evidence photos (S1.4). Greyscale 9×8, one bit
 * per horizontal neighbour pair (left > right) → 64 bits → 16 hex chars. Two
 * photos of the same scene (re-encoded, slightly cropped, brightness-shifted)
 * land within a small Hamming distance; unrelated photos are ~32 bits apart.
 * Used by the Payout-Evidence agent to spot a photo re-used across a
 * provider's orders. The bit math is pure (no BigInt — agent-core is also
 * transpiled by the web app) and unit-tested; decoding needs `sharp`, an
 * OPTIONAL peer dependency loaded lazily with a clear error when absent (web +
 * runtime install it; a keyless CI job never needs it).
 */

export const DHASH_WIDTH = 9
export const DHASH_HEIGHT = 8
export const DHASH_HEX_LEN = 16

/** Hash a row-major greyscale buffer of exactly width×height samples (0..255). One byte (2 hex) per row. */
export function dhashFromGray(gray: ArrayLike<number>, width = DHASH_WIDTH, height = DHASH_HEIGHT): string {
  if (gray.length !== width * height) throw new Error(`dhashFromGray: expected ${width * height} samples, got ${gray.length}`)
  let hex = ''
  for (let y = 0; y < height; y++) {
    let byte = 0
    for (let x = 0; x < width - 1; x++) {
      const left = gray[y * width + x] as number
      const right = gray[y * width + x + 1] as number
      byte = (byte << 1) | (left > right ? 1 : 0)
    }
    hex += (byte & 0xff).toString(16).padStart(2, '0')
  }
  return hex
}

const POPCOUNT4 = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4]

/** Hamming distance between two lowercase hex hashes of equal length (bits that differ). */
export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) throw new Error('hammingHex: hashes differ in length')
  let n = 0
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i] as string, 16)
    const y = parseInt(b[i] as string, 16)
    if (Number.isNaN(x) || Number.isNaN(y)) throw new Error('hammingHex: non-hex character')
    n += POPCOUNT4[(x ^ y) & 0xf] as number
  }
  return n
}

export function isValidDhash(h: unknown): h is string {
  return typeof h === 'string' && /^[0-9a-f]{16}$/.test(h)
}

// ── sharp (optional peer) ─────────────────────────────────────────────────────

type SharpFactory = (input?: Buffer | Uint8Array | string) => {
  greyscale(): SharpPipeline
  grayscale(): SharpPipeline
}
interface SharpPipeline {
  resize(w: number, h: number, opts?: { fit?: string }): SharpPipeline
  raw(): SharpPipeline
  toBuffer(): Promise<Buffer>
}

let sharpPromise: Promise<SharpFactory> | null = null

/** Load sharp lazily; throws a clear error naming the missing optional peer. */
export async function loadSharp(): Promise<SharpFactory> {
  if (!sharpPromise) {
    sharpPromise = (async () => {
      try {
        // Dynamic specifier keeps bundlers from resolving the optional peer eagerly.
        const name = 'sharp'
        const mod = (await import(/* @vite-ignore */ name)) as { default?: unknown } & Record<string, unknown>
        const factory = (mod.default ?? mod) as SharpFactory
        if (typeof factory !== 'function') throw new Error('sharp export is not a function')
        return factory
      } catch (e) {
        sharpPromise = null
        throw new Error(
          `dhash needs the optional peer dependency "sharp" (pnpm add sharp in the consuming package): ${(e as Error).message}`,
        )
      }
    })()
  }
  return sharpPromise
}

export async function sharpAvailable(): Promise<boolean> {
  try {
    await loadSharp()
    return true
  } catch {
    return false
  }
}

/** dHash of an encoded image (JPEG/PNG/WebP…). Requires sharp. */
export async function dhashFromImage(input: Buffer | Uint8Array): Promise<string> {
  const sharp = await loadSharp()
  const buf = await sharp(input).greyscale().resize(DHASH_WIDTH, DHASH_HEIGHT, { fit: 'fill' }).raw().toBuffer()
  return dhashFromGray(buf)
}

/** True when two hashes are within `maxDistance` bits (duplicate by the S1.4 rule). */
export function isNearDuplicate(a: string, b: string, maxDistance: number): boolean {
  return hammingHex(a, b) <= maxDistance
}
