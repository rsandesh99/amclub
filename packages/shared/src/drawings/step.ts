import { drawingSummarySchema, type DrawingSummary } from '../intake'

/**
 * S1.8 — deterministic STEP (ISO-10303-21) summary. A pure string parser: no
 * model, no dependency, ≤ 10 MB input, bounded regexes. It reads the header
 * (schema → AP number, file name), the product name, the length unit, the
 * bounding box from CARTESIAN_POINT extents, entity counts, and estimates
 * holes as round(cylindrical_surfaces / 2) — each cylindrical hole is usually
 * two half-cylinder faces in a B-rep; a through-hole with a chamfer counts
 * higher, a fillet counts as a hole. Stated as a heuristic in the summary.
 */

export const DRAWING_MAX_BYTES = 10 * 1024 * 1024

export class DrawingParseError extends Error {
  constructor(
    public readonly code: 'drawing_too_large' | 'drawing_unreadable',
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'DrawingParseError'
  }
}

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length
const r1 = (n: number): number => Math.round(n * 10) / 10
const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1))

export function parseStepSummary(text: string): DrawingSummary {
  if (text.length > DRAWING_MAX_BYTES) throw new DrawingParseError('drawing_too_large')
  if (!/^\s*ISO-10303-21;/.test(text) || !/ENDSEC;/.test(text)) {
    throw new DrawingParseError('drawing_unreadable', 'not an ISO-10303-21 STEP file')
  }

  // Header: FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }')) → AP214; ('AP203'…) → AP203
  const schemaM = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/.exec(text)
  const schema = schemaM?.[1] ?? ''
  const apM = /AP\s?(\d{3})/i.exec(schema) ?? /10303\s+(\d{3})/.exec(schema)
  const ap = apM?.[1] ?? null

  // Product name: PRODUCT('name','description',...) — first arg; fallback: the file name in FILE_NAME.
  const productM = /PRODUCT\s*\(\s*'([^']*)'/.exec(text)
  const fileNameM = /FILE_NAME\s*\(\s*(?:\/\*[^*]*\*\/\s*)?'([^']*)'/.exec(text)
  const rawName = (productM?.[1] || fileNameM?.[1] || '').trim()
  const product_name = rawName ? rawName.slice(0, 120) : null

  // Length unit: the SI_UNIT that follows a LENGTH_UNIT() in the complex entity; inch via CONVERSION_BASED_UNIT.
  let units: 'mm' | 'inch' | 'm' | null = null
  if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) units = 'inch'
  else {
    const lenM = /LENGTH_UNIT\s*\(\s*\)[\s\S]{0,60}?SI_UNIT\s*\(\s*(\.MILLI\.|\$)\s*,\s*\.METRE\./.exec(text)
    if (lenM) units = lenM[1] === '.MILLI.' ? 'mm' : 'm'
    else if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\./.test(text)) units = 'mm'
    else if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\./.test(text)) units = 'm'
  }
  const toMm = units === 'inch' ? 25.4 : units === 'm' ? 1000 : 1

  // Bounding box from CARTESIAN_POINT extents (2-D points get z = 0).
  const pointRe = /CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(\s*([-+0-9.Ee]+)\s*,\s*([-+0-9.Ee]+)(?:\s*,\s*([-+0-9.Ee]+))?\s*\)/g
  let min = [Infinity, Infinity, Infinity]
  let max = [-Infinity, -Infinity, -Infinity]
  let points = 0
  for (const m of text.matchAll(pointRe)) {
    const p = [Number(m[1]), Number(m[2]), m[3] === undefined ? 0 : Number(m[3])]
    if (p.some((v) => !Number.isFinite(v))) continue
    points++
    min = min.map((v, i) => Math.min(v, p[i]!))
    max = max.map((v, i) => Math.max(v, p[i]!))
    if (points > 2_000_000) break
  }
  const bbox_mm: [number, number, number] | null = points > 0 ? [r1((max[0]! - min[0]!) * toMm), r1((max[1]! - min[1]!) * toMm), r1((max[2]! - min[2]!) * toMm)] : null

  const counts = {
    solids: count(text, /MANIFOLD_SOLID_BREP\s*\(/g),
    faces: count(text, /ADVANCED_FACE\s*\(/g),
    cylindrical_surfaces: count(text, /CYLINDRICAL_SURFACE\s*\(/g),
    planes: count(text, /\bPLANE\s*\(/g),
    edges: count(text, /EDGE_CURVE\s*\(/g),
    points,
  }
  const hole_estimate = Math.round(counts.cylindrical_surfaces / 2)

  const size = bbox_mm ? `${fmt(bbox_mm[0])} × ${fmt(bbox_mm[1])} × ${fmt(bbox_mm[2])} mm` : 'size not stated'
  const summary_english = `Machined part '${product_name ?? 'unnamed'}', approx. ${size}, ${counts.faces} faces, about ${hole_estimate} holes (estimated from cylindrical faces).`.slice(0, 600)

  return drawingSummarySchema.parse({
    format: 'step',
    product_name,
    units,
    bbox_mm,
    counts,
    hole_estimate,
    layers: [],
    summary_english,
    spec_rows: [
      { k: 'Material', v: 'not stated' },
      { k: 'Overall size', v: bbox_mm ? `${fmt(bbox_mm[0])} × ${fmt(bbox_mm[1])} × ${fmt(bbox_mm[2])} mm` : 'not stated' },
      { k: 'Holes (est.)', v: String(hole_estimate) },
      { k: 'Source', v: `STEP AP${ap ?? '?'}` },
    ],
  })
}
