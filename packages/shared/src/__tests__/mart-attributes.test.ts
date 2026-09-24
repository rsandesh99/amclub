import { describe, expect, it } from 'vitest'
import { countAttributeFacets, parseAttributeFilters, productInputSchema, validateProductAttributes, type MartAttributeDef } from '../index'

const defs: MartAttributeDef[] = [
  { key: 'material', label_i18n: { en: 'Material' }, type: 'enum', unit: null, options: ['MS', 'SS 304'], facetable: true, required: true, sort: 1 },
  { key: 'diameter_mm', label_i18n: { en: 'Diameter' }, type: 'number', unit: 'mm', options: null, facetable: false, required: false, sort: 2 },
  { key: 'zinc_plated', label_i18n: { en: 'Zinc plated' }, type: 'bool', unit: null, options: null, facetable: true, required: false, sort: 3 },
]

describe('mart attributes (E16 N40)', () => {
  it('validates and normalises against the category definitions', () => {
    expect(validateProductAttributes(defs, { material: 'MS', diameter_mm: '12', zinc_plated: true })).toEqual({ ok: true, value: { material: 'MS', diameter_mm: 12, zinc_plated: true } })
    const bad = validateProductAttributes(defs, { material: 'Gold', diameter_mm: 'x', colour: 'red' })
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.problems.map((p) => `${p.key}:${p.code}`).sort()).toEqual(['colour:unknown', 'diameter_mm:type', 'material:option'])
    expect(validateProductAttributes(defs, {})).toEqual({ ok: false, problems: [{ key: 'material', code: 'required' }] })
  })

  it('facets count facetable values only; filters accept facetable keys only', () => {
    const facets = countAttributeFacets(defs, [{ attributes: { material: 'MS', zinc_plated: true } }, { attributes: { material: 'MS' } }, { attributes: { material: 'SS 304', diameter_mm: 8 } }])
    expect(facets).toEqual([
      { key: 'material', label_i18n: { en: 'Material' }, values: [{ value: 'MS', count: 2 }, { value: 'SS 304', count: 1 }] },
      { key: 'zinc_plated', label_i18n: { en: 'Zinc plated' }, values: [{ value: 'true', count: 1 }] },
    ])
    expect(parseAttributeFilters(defs, { 'a.material': 'MS', 'a.diameter_mm': '12', query: 'bolt' })).toEqual({ material: 'MS' })
    expect(parseAttributeFilters(defs, { 'a.material': 'Gold', 'a.zinc_plated': 'true' })).toEqual({ zinc_plated: true })
    expect(parseAttributeFilters(defs, { 'a.zinc_plated': 'yes' })).toEqual({})
  })

  it('product input carries attributes (default {})', () => {
    const base = { category_slug: 'fasteners', name: 'Hex bolt M12', hsn_code: '7318', gst_rate_bps: 1800, unit: 'pcs', tiers: [{ min_qty: 1, unit_price_paise: 1000 }] }
    expect(productInputSchema.parse(base).attributes).toEqual({})
    expect(productInputSchema.safeParse({ ...base, attributes: { material: 'MS' } }).success).toBe(true)
  })
})
