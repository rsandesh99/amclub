/**
 * Generate the photo_plausibility golden fixtures (S1.4 §3d). Deterministic
 * synthetic JPEGs ≤ 20 KB each under golden/photos + golden/photo_plausibility.json.
 * No real photos, no fonts (documents/screenshots are drawn as bars and frames),
 * so the set is safe to commit and identical on every machine.
 *
 *   pnpm --filter @amclub/agent-core exec tsx scripts/gen-photo-fixtures.ts
 *
 * Cases: 2 blank walls, 2 text-heavy "documents", 2 screenshot-like UI frames,
 * 4 plausible "work" photos (noise + shapes), 2 near-duplicates of work_1
 * (brightness shift; 2-px crop) for the dHash duplicate check.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp, { type Sharp } from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '../golden/photos')
const W = 160
const H = 120
const MAX_BYTES = 20 * 1024

// mulberry32 — deterministic PRNG
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function noiseRaw(seed: number, base: [number, number, number], amp: number): Buffer {
  const r = rng(seed)
  const buf = Buffer.alloc(W * H * 3)
  for (let i = 0; i < W * H; i++) {
    const n = (r() - 0.5) * amp
    buf[i * 3] = Math.max(0, Math.min(255, base[0] + n))
    buf[i * 3 + 1] = Math.max(0, Math.min(255, base[1] + n))
    buf[i * 3 + 2] = Math.max(0, Math.min(255, base[2] + n))
  }
  return buf
}

const svg = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`)

function workShapes(seed: number): string {
  const r = rng(seed)
  const palette = ['#6b4f2a', '#8c6b3f', '#4a5a3a', '#7a7a7a', '#b08d57', '#3f5a6e', '#9c5b3c']
  const parts: string[] = []
  for (let i = 0; i < 9; i++) {
    const c = palette[Math.floor(r() * palette.length)]
    const x = Math.floor(r() * W)
    const y = Math.floor(r() * H)
    const w = 12 + Math.floor(r() * 60)
    const h = 6 + Math.floor(r() * 40)
    const kind = r()
    if (kind < 0.45) parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}" opacity="0.85" transform="rotate(${Math.floor(r() * 30 - 15)} ${x} ${y})"/>`)
    else if (kind < 0.75) parts.push(`<line x1="${x}" y1="${y}" x2="${x + w}" y2="${y + h}" stroke="${c}" stroke-width="${2 + Math.floor(r() * 4)}"/>`)
    else parts.push(`<circle cx="${x}" cy="${y}" r="${4 + Math.floor(r() * 14)}" fill="${c}" opacity="0.8"/>`)
  }
  // a floor/horizon band like a site photo
  parts.push(`<rect x="0" y="${H - 28}" width="${W}" height="28" fill="#5a4a3a" opacity="0.55"/>`)
  return parts.join('')
}

function documentBars(seed: number): string {
  const r = rng(seed)
  const parts: string[] = [`<rect x="0" y="0" width="${W}" height="${H}" fill="#fbfbf7"/>`]
  parts.push(`<rect x="14" y="10" width="70" height="5" fill="#111"/>`) // heading
  for (let y = 24; y < H - 8; y += 7) {
    const lines = 2 + Math.floor(r() * 3)
    let x = 14
    for (let i = 0; i < lines; i++) {
      const w = 12 + Math.floor(r() * 45)
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="2.5" fill="#222"/>`)
      x += w + 5
      if (x > W - 20) break
    }
  }
  parts.push(`<rect x="14" y="${H - 16}" width="40" height="3" fill="#444"/>`) // signature line
  return parts.join('')
}

function screenshotFrame(seed: number): string {
  const r = rng(seed)
  const accent = ['#1a73e8', '#0f9d58', '#6b3fa0'][seed % 3]
  const parts: string[] = [`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`]
  parts.push(`<rect x="0" y="0" width="${W}" height="10" fill="#111"/>`) // status bar
  parts.push(`<rect x="0" y="10" width="${W}" height="18" fill="${accent}"/>`) // app bar
  parts.push(`<rect x="6" y="15" width="8" height="8" fill="#fff"/>`)
  for (let i = 0; i < 4; i++) {
    const y = 36 + i * 20
    parts.push(`<rect x="8" y="${y}" width="${W - 16}" height="15" rx="3" fill="#f1f3f4" stroke="#dadce0"/>`)
    parts.push(`<rect x="14" y="${y + 5}" width="${30 + Math.floor(r() * 50)}" height="4" fill="#5f6368"/>`)
  }
  parts.push(`<rect x="${W - 40}" y="${H - 22}" width="32" height="14" rx="7" fill="${accent}"/>`) // FAB/button
  parts.push(`<rect x="0" y="${H - 6}" width="${W}" height="6" fill="#eee"/>`)
  return parts.join('')
}

async function toJpeg(pipeline: Sharp, quality = 62): Promise<Buffer> {
  let q = quality
  for (;;) {
    const buf = await pipeline.clone().jpeg({ quality: q, mozjpeg: true }).toBuffer()
    if (buf.length <= MAX_BYTES || q <= 30) return buf
    q -= 8
  }
}

interface Case {
  image: string
  claimed_stage: string
  expected: { is_screenshot_or_document: boolean; looks_like_work: boolean }
  duplicate_of?: string
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  const cases: Case[] = []
  const write = async (name: string, buf: Buffer, c: Omit<Case, 'image'>) => {
    writeFileSync(join(outDir, name), buf)
    const size = statSync(join(outDir, name)).size
    if (size > MAX_BYTES) throw new Error(`${name} is ${size} bytes (> 20 KB)`)
    cases.push({ image: name, ...c })
    console.log(`  ${name.padEnd(16)} ${String(size).padStart(6)} B`)
  }

  // blank walls
  await write('blank_wall_1.jpg', await toJpeg(sharp(noiseRaw(11, [214, 205, 190], 6), { raw: { width: W, height: H, channels: 3 } })), {
    claimed_stage: 'work_complete', expected: { is_screenshot_or_document: false, looks_like_work: false },
  })
  await write('blank_wall_2.jpg', await toJpeg(sharp(noiseRaw(12, [160, 160, 164], 4), { raw: { width: W, height: H, channels: 3 } })), {
    claimed_stage: 'in_progress', expected: { is_screenshot_or_document: false, looks_like_work: false },
  })
  // documents
  await write('document_1.jpg', await toJpeg(sharp(svg(documentBars(21)))), { claimed_stage: 'work_complete', expected: { is_screenshot_or_document: true, looks_like_work: false } })
  await write('document_2.jpg', await toJpeg(sharp(svg(documentBars(22)))), { claimed_stage: 'site_or_materials', expected: { is_screenshot_or_document: true, looks_like_work: false } })
  // screenshots
  await write('screenshot_1.jpg', await toJpeg(sharp(svg(screenshotFrame(31)))), { claimed_stage: 'work_complete', expected: { is_screenshot_or_document: true, looks_like_work: false } })
  await write('screenshot_2.jpg', await toJpeg(sharp(svg(screenshotFrame(32)))), { claimed_stage: 'delivery_photo', expected: { is_screenshot_or_document: true, looks_like_work: false } })
  // work photos: noise base + shapes
  const work = async (n: number, seed: number, stage: string) => {
    const base = sharp(noiseRaw(seed, [120 + (seed % 5) * 9, 110 + (seed % 7) * 6, 95 + (seed % 3) * 10], 40), { raw: { width: W, height: H, channels: 3 } })
      .composite([{ input: svg(workShapes(seed + 100)), top: 0, left: 0 }])
    const buf = await toJpeg(base)
    await write(`work_${n}.jpg`, buf, { claimed_stage: stage, expected: { is_screenshot_or_document: false, looks_like_work: true } })
    return buf
  }
  const work1 = await work(1, 41, 'work_complete')
  await work(2, 42, 'in_progress')
  await work(3, 43, 'site_or_materials')
  await work(4, 44, 'delivery_photo')
  // near-duplicates of work_1
  await write('dup_a.jpg', await toJpeg(sharp(work1).modulate({ brightness: 1.04 })), {
    claimed_stage: 'work_complete', expected: { is_screenshot_or_document: false, looks_like_work: true }, duplicate_of: 'work_1.jpg',
  })
  await write('dup_b.jpg', await toJpeg(sharp(work1).extract({ left: 2, top: 2, width: W - 4, height: H - 4 }).resize(W, H)), {
    claimed_stage: 'work_complete', expected: { is_screenshot_or_document: false, looks_like_work: true }, duplicate_of: 'work_1.jpg',
  })

  writeFileSync(join(here, '../golden/photo_plausibility.json'), JSON.stringify(cases, null, 2) + '\n')
  console.log(`\nwrote ${cases.length} fixtures + golden/photo_plausibility.json`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
