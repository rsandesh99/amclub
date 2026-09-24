import { describe, expect, it } from 'vitest'
import {
  businessNamesMatch,
  businessNameTokens,
  KYC_ATTEMPT_OUTCOMES,
  kycAttemptOutcomeSchema,
  kycOwnership,
  kycOwnershipSchema,
  normaliseBusinessName,
  panFromGstin,
  udyamClaimKey,
} from '../index'

/**
 * Audit M12 / ADR 028 — a KYC vendor answer earns a chip only when the record
 * is the claimant's own: an ID match, or a conservative name match against a
 * GST-locked name. The tables are the contract.
 */

describe('normaliseBusinessName', () => {
  it.each([
    ['Sri Sai Traders Pvt. Ltd.', 'SRI SAI TRADERS'],
    ['SRI SAI TRADERS PRIVATE LIMITED', 'SRI SAI TRADERS'],
    ['M/s. Sri Sai Traders', 'SRI SAI TRADERS'],
    ['MESSRS Sri Sai Traders', 'SRI SAI TRADERS'],
    ['Kumar & Co.', 'KUMAR'],
    ['Kumar and Company', 'KUMAR'],
    ['Acme Consulting LLP', 'ACME CONSULTING'],
    ['Acme Consulting (OPC) Private Limited', 'ACME CONSULTING'],
    ['ACME CONSULTING PRIVATE LIMI', 'ACME CONSULTING'], // a bank's truncated field
    ['Acme (P) Ltd', 'ACME'],
    ['Acme P. Ltd.', 'ACME'],
    ['The Guntur Steel Works', 'GUNTUR STEEL WORKS'],
    ['  sri   sai-traders  ', 'SRI SAI TRADERS'],
    ['Ravi Kumar P', 'RAVI KUMAR P'], // an initial is not a legal form
    ['Private Limited', 'PRIVATE'], // never strips a name to nothing
    ['', ''],
  ])('%s → %s', (raw, want) => {
    expect(normaliseBusinessName(raw)).toBe(want)
  })

  it('tokens drop fillers anywhere', () => {
    expect(businessNameTokens('Bank of the Deccan and Sons')).toEqual(['BANK', 'DECCAN', 'SONS'])
  })
})

describe('businessNamesMatch', () => {
  it.each([
    // same business, different spelling of the legal form / punctuation / case
    ['SRI SAI TRADERS', 'Sri Sai Traders Pvt Ltd', true, 'exact'],
    ['M/S SRI SAI TRADERS', 'sri sai traders', true, 'exact'],
    ['ACME CONSULTING PRIVATE LIMI', 'Acme Consulting Pvt. Ltd.', true, 'exact'],
    ['KUMAR & CO', 'Kumar and Company', true, 'exact'],
    ['R K ENTERPRISES', 'RK Enterprises', true, 'compact'],
    ['SRISAI TRADERS', 'Sri Sai Traders', true, 'compact'],
    ['R K SHARMA', 'Rajesh Kumar Sharma', true, 'initials'],
    ['SHARMA RAJESH KUMAR', 'Rajesh Kumar Sharma', true, 'tokens'], // surname first
    ['GUNTUR STEEL AND WIRE WORKS', 'Guntur Steel Wire Works India', true, 'tokens'], // 4 of 5
    // different businesses
    ['SRI SAI TRADERS', 'Sri Sai Enterprises', false, null],
    ['SRI SAI TRADERS', 'Sri Sai Balaji Traders', false, null], // 3 of 4 < 0.8
    ['ABC TRADERS', 'XYZ Traders', false, null],
    ['S S ENTERPRISES', 'Sri Sai Enterprises', false, null], // initials over generic words only
    ['RELIANCE', 'Reliance Retail', false, null],
    ['GUNTUR STEEL WORKS', 'Guntur Cement Works', false, null],
    ['FAKE VERIFIED ENTERPRISE', 'A Co', false, null],
    ['', 'Anything', false, null],
  ])('%s ~ %s → %s', (a, b, match, rule) => {
    const m = businessNamesMatch(a, b)
    expect(m.match).toBe(match)
    expect(m.rule).toBe(rule)
    expect(businessNamesMatch(b, a).match).toBe(match) // symmetric
  })
})

describe('kycOwnership — the decision', () => {
  const refs = { names: ['Sri Sai Traders Private Limited', 'SRI SAI STEELS'], pans: [], gstins: ['36AABCS1234K1Z5'] }

  it.each([
    ['vendor GSTIN is ours', { name: 'Someone Else', gstin: '36AABCS1234K1Z5' }, 'verified', 'gstin', 'id_match'],
    ['vendor PAN is inside our GSTIN', { name: 'Someone Else', pan: 'AABCS1234K' }, 'verified', 'pan', 'id_match'],
    ['vendor GSTIN from another state, same PAN', { gstin: '29AABCS1234K1Z1' }, 'verified', 'pan', 'id_match'],
    ['vendor PAN contradicts ours though the name agrees', { name: 'Sri Sai Traders', pan: 'ZZZZZ9999Z' }, 'name_mismatch', null, 'id_conflict'],
    ['legal name matches', { name: 'M/S SRI SAI TRADERS' }, 'verified', 'name', 'name_match'],
    ['trade name matches', { name: 'Sri Sai Steels' }, 'verified', 'name', 'name_match'],
    ['name does not match', { name: 'Fake Verified Enterprise' }, 'name_mismatch', null, 'mismatch'],
    ['vendor returned no name', { name: '  ' }, 'name_mismatch', null, 'no_vendor_name'],
  ] as const)('%s', (_label, vendor, outcome, basis, reason) => {
    const d = kycOwnership(vendor, refs)
    expect(d.outcome).toBe(outcome)
    expect(d.basis).toBe(basis)
    expect(d.reason).toBe(reason)
    expect(kycOwnershipSchema.safeParse(d).success).toBe(true)
  })

  it('no GST-locked reference → never verified by name', () => {
    expect(kycOwnership({ name: 'Sri Sai Traders' }, { names: [], pans: [], gstins: [] })).toMatchObject({ outcome: 'name_mismatch', reason: 'no_reference' })
  })

  it('a vendor ID with no ID of ours to compare falls through to the name', () => {
    expect(kycOwnership({ name: 'Sri Sai Traders', pan: 'AABCS1234K' }, { names: ['Sri Sai Traders'], pans: [], gstins: [] })).toMatchObject({ outcome: 'verified', basis: 'name' })
  })

  it('an admin-reviewed PAN counts as ours', () => {
    expect(kycOwnership({ pan: 'aabcs1234k' }, { names: [], pans: ['AABCS1234K'], gstins: [] })).toMatchObject({ outcome: 'verified', basis: 'pan' })
  })

  it('malformed IDs are ignored, never matched', () => {
    expect(kycOwnership({ name: 'X', pan: 'NOTAPAN', gstin: 'NOTAGSTIN' }, { names: ['Y'], pans: ['NOTAPAN'], gstins: ['NOTAGSTIN'] })).toMatchObject({ outcome: 'name_mismatch', reason: 'mismatch' })
  })

  it('reports the best reference for the ops card', () => {
    expect(kycOwnership({ name: 'Sri Sai Steels Works' }, refs)).toMatchObject({ outcome: 'name_mismatch', reference: 'SRI SAI STEELS' })
  })
})

describe('identifiers and outcomes', () => {
  it('panFromGstin', () => {
    expect(panFromGstin('36AABCS1234K1Z5')).toBe('AABCS1234K')
    expect(panFromGstin(' 36aabcs1234k1z5 ')).toBe('AABCS1234K')
    expect(panFromGstin('36AABCS1234K1Z')).toBeNull()
    expect(panFromGstin(null)).toBeNull()
  })
  it('udyamClaimKey upper-cases and trims', () => {
    expect(udyamClaimKey(' udyam-ka-03-0001234 ')).toBe('UDYAM-KA-03-0001234')
  })
  it('the outcome enum is closed', () => {
    expect([...KYC_ATTEMPT_OUTCOMES]).toEqual(['verified', 'name_mismatch', 'not_verified', 'stub', 'udyam_already_claimed'])
    expect(kycAttemptOutcomeSchema.safeParse('approved').success).toBe(false)
  })
})
