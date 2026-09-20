import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dhashFromGray, dhashFromImage, hammingHex, isNearDuplicate, isValidDhash, sharpAvailable } from './dhash'

const here = dirname(fileURLToPath(import.meta.url))
const photos = join(here, '../../golden/photos')

function gradientRows(direction: 1 | -1): number[] {
  // 9×8; each row is a monotonic ramp so every neighbour pair has the same sign.
  const out: number[] = []
  for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) out.push(direction === 1 ? x * 20 : 255 - x * 20)
  return out
}

describe('dhash — pure bit math', () => {
  it('rejects a buffer of the wrong size', () => {
    expect(() => dhashFromGray([1, 2, 3])).toThrow(/expected 72/)
  })

  it('an increasing ramp is all zeros; a decreasing ramp is all ones', () => {
    expect(dhashFromGray(gradientRows(1))).toBe('0000000000000000')
    expect(dhashFromGray(gradientRows(-1))).toBe('ffffffffffffffff')
    expect(hammingHex('0000000000000000', 'ffffffffffffffff')).toBe(64)
  })

  it('a small perturbation moves few bits', () => {
    const base = gradientRows(1)
    const nudged = [...base]
    nudged[4] = 0 // flip one comparison in row 0 (x=3 vs x=4 and x=4 vs x=5)
    const d = hammingHex(dhashFromGray(base), dhashFromGray(nudged))
    expect(d).toBeGreaterThan(0)
    expect(d).toBeLessThanOrEqual(2)
    expect(isNearDuplicate(dhashFromGray(base), dhashFromGray(nudged), 6)).toBe(true)
  })

  it('validates the hex shape', () => {
    expect(isValidDhash('0123456789abcdef')).toBe(true)
    expect(isValidDhash('0123456789ABCDEF')).toBe(false)
    expect(isValidDhash('0123')).toBe(false)
    expect(() => hammingHex('00', '0000')).toThrow()
  })
})

describe('dhash — golden photos (needs sharp; skipped when absent)', async () => {
  const available = await sharpAvailable()
  const have = available && existsSync(join(photos, 'work_1.jpg'))

  it.skipIf(!have)('near-duplicates of work_1 are within 6 bits; a different work photo is not', async () => {
    const h = async (f: string) => dhashFromImage(readFileSync(join(photos, f)))
    const base = await h('work_1.jpg')
    expect(isValidDhash(base)).toBe(true)
    expect(hammingHex(base, await h('dup_a.jpg'))).toBeLessThanOrEqual(6)
    expect(hammingHex(base, await h('dup_b.jpg'))).toBeLessThanOrEqual(6)
    expect(hammingHex(base, await h('work_2.jpg'))).toBeGreaterThan(6)
    expect(hammingHex(base, await h('document_1.jpg'))).toBeGreaterThan(6)
  })
})
