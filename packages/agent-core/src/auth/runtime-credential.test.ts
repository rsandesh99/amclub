import { describe, expect, it } from 'vitest'
import {
  extractRuntimeCredential,
  signRuntimeCredential,
  verifyRuntimeCredential,
} from './runtime-credential'

const SECRET = 'test-runtime-secret'
const USER = '00000000-0000-0000-0000-000000000001'
const RUN = '00000000-0000-0000-0000-000000000009'

describe('runtime credential', () => {
  it('round-trips a signed credential', () => {
    const cred = signRuntimeCredential(SECRET, { userId: USER, persona: 'buyer', runId: RUN })
    const claims = verifyRuntimeCredential(SECRET, cred)
    expect(claims).toEqual({ userId: USER, persona: 'buyer', runId: RUN, ts: expect.any(Number) })
  })

  it('rejects a tampered signature', () => {
    const cred = signRuntimeCredential(SECRET, { userId: USER, persona: 'buyer', runId: RUN })
    const tampered = cred.slice(0, -2) + (cred.endsWith('aa') ? 'bb' : 'aa')
    expect(verifyRuntimeCredential(SECRET, tampered)).toBeNull()
  })

  it('rejects a credential signed with a different secret', () => {
    const cred = signRuntimeCredential('other-secret', { userId: USER, persona: 'buyer', runId: RUN })
    expect(verifyRuntimeCredential(SECRET, cred)).toBeNull()
  })

  it('rejects a credential outside the +/-5 min window', () => {
    const past = Math.floor(Date.now() / 1000) - 3600
    const cred = signRuntimeCredential(SECRET, { userId: USER, persona: 'ops', runId: RUN, ts: past })
    expect(verifyRuntimeCredential(SECRET, cred)).toBeNull()
    // within the window it verifies
    const fresh = signRuntimeCredential(SECRET, { userId: USER, persona: 'ops', runId: RUN })
    expect(verifyRuntimeCredential(SECRET, fresh)).not.toBeNull()
  })

  it('rejects an unknown persona', () => {
    const ts = Math.floor(Date.now() / 1000)
    // hand-craft a credential with an invalid persona segment
    const bad = signRuntimeCredential(SECRET, { userId: USER, persona: 'buyer', runId: RUN, ts }).replace('.buyer.', '.wizard.')
    expect(verifyRuntimeCredential(SECRET, bad)).toBeNull()
  })

  it('parses the Authorization header form', () => {
    expect(extractRuntimeCredential('AMC-Runtime abc.def')).toBe('abc.def')
    expect(extractRuntimeCredential('Bearer xyz')).toBeNull()
    expect(extractRuntimeCredential(null)).toBeNull()
  })
})
