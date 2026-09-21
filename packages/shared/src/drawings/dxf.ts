import { drawingSummarySchema, type DrawingSummary } from '../intake'
import { DRAWING_MAX_BYTES, DrawingParseError } from './step'

/**
 * S1.8 — deterministic DXF (ASCII) summary. Group-code / value pairs on
 * alternating lines: `$INSUNITS` (70), `$EXTMIN` / `$EXTMAX` (10/20/30), the
 * LAYER table (name = code 2), and entity counts in ENTITIES. Holes are
 * estimated as the CIRCLE count — a 2-D drilling view draws one circle per
 * hole; a section view draws none. Stated as a heuristic. Binary DXF is not
 * supported (its sentinel is refused with `drawing_unreadable`).
 */

const ENTITY_TYPES = ['LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE', 'TEXT', 'MTEXT', 'INSERT'] as const
const UNIT_NAMES: Record<number, { name: string; toMm: number }> = {
  1: { name: 'inch', toMm: 25.4 },
  2: { name: 'ft', toMm: 304.8 },
  4: { name: 'mm', toMm: 1 },
  5: { name: 'cm', toMm: 10 },
  6: { name: 'm', toMm: 1000 },
}
const r1 = (n: number): number => Math.round(n * 10) / 10
const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1))

export function parseDxfSummary(text: string): DrawingSummary {
  if (text.length > DRAWING_MAX_BYTES) throw new DrawingParseError('drawing_too_large')
  if (/AutoCAD Binary DXF/.test(text.slice(0, 64))) throw new DrawingParseError('drawing_unreadable', 'binary DXF is not supported')
  const lines = text.split(/\r?\n/)
  const pairs: [number, string][] = []
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number((lines[i] ?? '').trim())
    if (!Number.isFinite(code)) throw new DrawingParseError('drawing_unreadable', `bad group code at line ${i + 1}`)
    pairs.push([code, (lines[i + 1] ?? '').trim()])
  }
  if (!pairs.some(([c, v]) => c === 0 && v === 'SECTION')) throw new DrawingParseError('drawing_unreadable', 'no SECTION')

  let section = ''
  let table = ''
  let insunits: number | null = null
  const ext: Record<'$EXTMIN' | '$EXTMAX', [number, number, number] | null> = { $EXTMIN: null, $EXTMAX: null }
  const layers = new Set<string>()
  const counts: Record<string, number> = Object.fromEntries(ENTITY_TYPES.map((t) => [t, 0]))
  let entities = 0

  for (let i = 0; i < pairs.length; i++) {
    const [c, v] = pairs[i]!
    if (c === 0 && v === 'SECTION') {
      const nx = pairs[i + 1]
      section = nx && nx[0] === 2 ? nx[1] : ''
      table = ''
      continue
    }
    if (c === 0 && v === 'ENDSEC') { section = ''; table = ''; continue }
    if (section === 'HEADER' && c === 9) {
      if (v === '$INSUNITS') {
        const nx = pairs[i + 1]
        if (nx && nx[0] === 70) insunits = Number(nx[1])
      } else if (v === '$EXTMIN' || v === '$EXTMAX') {
        const p: [number, number, number] = [0, 0, 0]
        for (let j = i + 1; j < Math.min(i + 4, pairs.length); j++) {
          const [cc, vv] = pairs[j]!
          if (cc === 10) p[0] = Number(vv)
          else if (cc === 20) p[1] = Number(vv)
          else if (cc === 30) p[2] = Number(vv)
          else break
        }
        if (p.every((n) => Number.isFinite(n))) ext[v] = p
      }
      continue
    }
    if (section === 'TABLES') {
      if (c === 0 && v === 'TABLE') { const nx = pairs[i + 1]; table = nx && nx[0] === 2 ? nx[1] : ''; continue }
      if (c === 0 && v === 'ENDTAB') { table = ''; continue }
      if (table === 'LAYER' && c === 0 && v === 'LAYER') {
        for (let j = i + 1; j < Math.min(i + 12, pairs.length); j++) {
          const [cc, vv] = pairs[j]!
          if (cc === 0) break
          if (cc === 2) { if (vv && layers.size < 50) layers.add(vv.slice(0, 60)); break }
        }
      }
      continue
    }
    if (section === 'ENTITIES' && c === 0) {
      entities++
      if (v in counts) counts[v] = (counts[v] ?? 0) + 1
    }
  }

  const unit = insunits !== null ? (UNIT_NAMES[insunits] ?? null) : null
  const toMm = unit?.toMm ?? 1
  let bbox_mm: [number, number, number] | null = null
  if (ext.$EXTMIN && ext.$EXTMAX) {
    const d = ext.$EXTMAX.map((v, k) => Math.abs(v - ext.$EXTMIN![k]!) * toMm)
    // AutoCAD writes ±1e20 sentinels when extents were never computed.
    if (d.every((n) => Number.isFinite(n) && n < 1e12)) bbox_mm = [r1(d[0]!), r1(d[1]!), r1(d[2]!)]
  }
  const hole_estimate = counts['CIRCLE'] ?? 0
  const layerList = [...layers]
  const size = bbox_mm ? `${fmt(bbox_mm[0])} × ${fmt(bbox_mm[1])} mm` : 'size not stated'
  const summary_english = `2D drawing, approx. ${size}, ${entities} entities on ${layerList.length} layer${layerList.length === 1 ? '' : 's'}, about ${hole_estimate} holes (estimated from circles).`.slice(0, 600)

  return drawingSummarySchema.parse({
    format: 'dxf',
    product_name: null,
    units: unit?.name ?? null,
    bbox_mm,
    counts: { ...counts, entities },
    hole_estimate,
    layers: layerList,
    summary_english,
    spec_rows: [
      { k: 'Overall size', v: bbox_mm ? `${fmt(bbox_mm[0])} × ${fmt(bbox_mm[1])} mm` : 'not stated' },
      { k: 'Holes (est.)', v: String(hole_estimate) },
      { k: 'Layers', v: layerList.length ? layerList.slice(0, 6).join(', ').slice(0, 200) : 'none' },
      { k: 'Source', v: `DXF${unit ? ` (${unit.name})` : ''}` },
    ],
  })
}
