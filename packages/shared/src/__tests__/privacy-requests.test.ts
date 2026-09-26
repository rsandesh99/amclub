import { describe, expect, it } from 'vitest'
import {
  PRIVACY_DETAILS_MAX, PRIVACY_REQUEST_DUE_DAYS, privacyRequestCreateSchema, privacyRequestDueAt, privacyRequestProblem,
} from '../privacy-requests'

describe('privacyRequestProblem (the form rule on web, mobile and the route)', () => {
  it('access, erasure and withdrawal need no details', () => {
    for (const kind of ['access', 'erasure', 'withdrawal'] as const) {
      expect(privacyRequestProblem({ kind }), kind).toBeNull()
      expect(privacyRequestProblem({ kind, details: '' }), kind).toBeNull()
    }
  })
  it('correction and grievance must say what (at least 10 characters after trimming)', () => {
    for (const kind of ['correction', 'grievance'] as const) {
      expect(privacyRequestProblem({ kind })).toBe('details_required')
      expect(privacyRequestProblem({ kind, details: '   short   ' })).toBe('details_required')
      expect(privacyRequestProblem({ kind, details: 'My GSTIN is wrong on the profile' })).toBeNull()
    }
  })
  it('details are capped', () => {
    expect(privacyRequestProblem({ kind: 'access', details: 'x'.repeat(PRIVACY_DETAILS_MAX + 1) })).toBe('details_too_long')
    expect(privacyRequestProblem({ kind: 'access', details: 'x'.repeat(PRIVACY_DETAILS_MAX) })).toBeNull()
  })
})

describe('privacyRequestCreateSchema', () => {
  it('accepts the five kinds a person files, with an optional source', () => {
    expect(privacyRequestCreateSchema.safeParse({ kind: 'access' }).success).toBe(true)
    expect(privacyRequestCreateSchema.safeParse({ kind: 'erasure', source: 'mobile', details: null }).success).toBe(true)
  })
  it('refuses ops-only kinds, unknown sources and a correction with no details', () => {
    expect(privacyRequestCreateSchema.safeParse({ kind: 'nomination' }).success).toBe(false)
    expect(privacyRequestCreateSchema.safeParse({ kind: 'access', source: 'whatsapp' }).success).toBe(false)
    const r = privacyRequestCreateSchema.safeParse({ kind: 'correction' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.message).toBe('details_required')
  })
})

describe('privacyRequestDueAt', () => {
  it('is 30 days after filing', () => {
    const now = new Date('2026-09-26T10:00:00Z')
    expect(PRIVACY_REQUEST_DUE_DAYS).toBe(30)
    expect(privacyRequestDueAt(now).toISOString()).toBe('2026-10-26T10:00:00.000Z')
  })
})
