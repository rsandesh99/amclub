/**
 * Generate the document_extract golden IMAGE fixtures (S1.8 §3): three
 * synthetic PNGs of rendered text (a GST notice, a tax invoice, a quotation)
 * under golden/documents/. Synthetic, fictitious names and numbers, ≤ 60 KB
 * each, safe to commit. The S1.4 photo-fixture pattern (sharp over SVG).
 *
 *   pnpm --filter @amclub/agent-core gen:documents
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '../golden/documents')
const W = 640
const H = 480
const MAX_BYTES = 60 * 1024

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function page(title: string, lines: string[], stamp?: string): Buffer {
  const body = lines
    .map((l, i) => `<text x="40" y="${110 + i * 26}" font-family="Arial, Helvetica, sans-serif" font-size="15" fill="#111">${esc(l)}</text>`)
    .join('')
  const stampSvg = stamp
    ? `<g transform="rotate(-12 500 400)"><rect x="420" y="380" width="170" height="44" fill="none" stroke="#b00" stroke-width="3"/><text x="505" y="409" text-anchor="middle" font-family="Arial" font-size="18" font-weight="bold" fill="#b00">${esc(stamp)}</text></g>`
    : ''
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<rect width="${W}" height="${H}" fill="#fdfdf8"/>` +
      `<rect x="24" y="24" width="${W - 48}" height="${H - 48}" fill="none" stroke="#999" stroke-width="1"/>` +
      `<text x="40" y="64" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="bold" fill="#000">${esc(title)}</text>` +
      `<line x1="40" y1="78" x2="${W - 40}" y2="78" stroke="#333" stroke-width="1"/>` +
      body +
      stampSvg +
      `</svg>`,
  )
}

const DOCS: Record<string, Buffer> = {
  'gst_notice_1.png': page(
    'GOVERNMENT OF INDIA — CENTRAL GST, GUNTUR DIVISION',
    [
      'NOTICE under Section 61 of the CGST Act, 2017',
      'Reference: ZD3709260012345 · Date: 12/09/2026',
      'To: Sri Venkateswara Garments (Prop.)',
      'GSTIN: 37AAACS4321K1Z2',
      'Subject: Discrepancy in return GSTR-3B for period 04/2026',
      'Tax difference noticed: Rs. 48,500 (IGST) — explain or pay',
      'Reply due on or before 27/09/2026',
      'Failure to reply may attract proceedings under Section 73.',
      'Signed: Superintendent, Range-IV',
    ],
    'NOTICE',
  ),
  'invoice_1.png': page(
    'TAX INVOICE — Krishna Industrial Supplies',
    [
      'Invoice No: KIS/2026-27/0418 · Date: 03/09/2026',
      'Seller GSTIN: 36AABCK7788M1ZQ',
      'Buyer: Sai Fabricators, Hyderabad',
      'Buyer GSTIN: 36AAACS9911R1Z7',
      'Item: MS Angle 50x50x5 mm — 1,200 kg @ Rs. 62.00 = Rs. 74,400.00',
      'Item: Welding rods 3.15 mm — 40 pkt @ Rs. 480.00 = Rs. 19,200.00',
      'Taxable value Rs. 93,600.00 · CGST 9% Rs. 8,424.00 · SGST 9% Rs. 8,424.00',
      'Grand total: Rs. 1,10,448.00 · Payment due: 30 days',
      'PAN: AABCK7788M',
    ],
  ),
  'quotation_1.png': page(
    'QUOTATION — Lakshmi Precision Works, Coimbatore',
    [
      'Quotation No: LPW/Q/2026/091 · Valid till: 15/10/2026',
      'To: Anand Auto Components',
      'Item 1: CNC turning of shaft, EN8, dia 40 x 320 mm — 500 nos @ Rs. 185',
      'Item 2: Drilling 6 holes M8 per piece — included',
      'Item 3: Zinc plating — Rs. 22 per piece',
      'Delivery: 21 days from PO · Packing: wooden crates',
      'Terms: 50% advance, balance on delivery · GST 18% extra',
      'Total (ex-GST): Rs. 1,03,500.00',
    ],
  ),
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  for (const [name, svg] of Object.entries(DOCS)) {
    const out = join(outDir, name)
    const buf = await sharp(svg).png({ compressionLevel: 9, palette: true, colours: 16 }).toBuffer()
    writeFileSync(out, buf)
    const size = statSync(out).size
    if (size > MAX_BYTES) throw new Error(`${name} is ${size} bytes (> ${MAX_BYTES})`)
    console.log(`✓ ${name} ${size} B`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
