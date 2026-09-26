import { describe, expect, it } from 'vitest'
import { SUPPORT_COPY, SUPPORT_LOCALES } from '../index'

// WhatsApp readiness audit §7: the Support agent told providers AMClub takes "only 5 % commission" in all four
// languages. Services commission is per category (default 10 %), fixed on the order; Mart defaults differ again. The
// line names no rate: the provider sees the category's rate before listing or quoting.
describe('how_to.fees names no commission rate', () => {
  it.each([...SUPPORT_LOCALES])('%s', (l) => {
    const line = SUPPORT_COPY[l]['how_to.fees']
    expect(line).toBeTruthy()
    expect(line).not.toMatch(/\d|%|٪/)
  })
})
