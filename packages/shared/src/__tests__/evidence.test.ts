import { describe, expect, it } from 'vitest'
import {
  canAddMilestone,
  evaluateServicesReleaseGate,
  milestoneSchema,
  nextMilestoneKind,
  type MilestoneKind,
} from '../index'

const UUID = '00000000-0000-0000-0000-000000000001'

describe('milestone schema', () => {
  it('requires a photo for site_or_materials / in_progress / work_complete', () => {
    expect(milestoneSchema.safeParse({ kind: 'work_complete' }).success).toBe(false)
    expect(milestoneSchema.safeParse({ kind: 'in_progress', photo_doc_id: UUID }).success).toBe(true)
  })
  it('allows a photoless accepted check-in', () => {
    expect(milestoneSchema.safeParse({ kind: 'accepted' }).success).toBe(true)
    expect(milestoneSchema.safeParse({ kind: 'accepted', note: 'reached' }).success).toBe(true)
  })
})

describe('milestone machine', () => {
  it('nextMilestoneKind walks the order and ends at null', () => {
    expect(nextMilestoneKind([])).toBe('accepted')
    expect(nextMilestoneKind(['accepted'])).toBe('site_or_materials')
    expect(nextMilestoneKind(['accepted', 'site_or_materials', 'in_progress', 'work_complete'])).toBeNull()
  })

  it('adds only in order, once each, while the order is open', () => {
    expect(canAddMilestone([], 'accepted', 'accepted').ok).toBe(true)
    expect(canAddMilestone([], 'in_progress', 'in_progress')).toEqual({ ok: false, reason: 'out_of_order' })
    expect(canAddMilestone(['accepted'], 'accepted', 'in_progress')).toEqual({ ok: false, reason: 'duplicate' })
    expect(canAddMilestone([], 'accepted', 'completed')).toEqual({ ok: false, reason: 'order_not_open' })
  })
})

describe('services release gate', () => {
  const wc = (photo: string | null) => [{ kind: 'work_complete' as MilestoneKind, photo_doc_id: photo }]

  it('holds until a work-complete photo exists', () => {
    const g = evaluateServicesReleaseGate({ milestones: [], buyerConfirmedAt: new Date(), disputeOpen: false })
    expect(g.ok).toBe(false)
    expect(g.reasons).toContain('missing_work_complete_photo')
  })

  it('holds while the buyer has not confirmed', () => {
    const g = evaluateServicesReleaseGate({ milestones: wc(UUID), buyerConfirmedAt: null, disputeOpen: false })
    expect(g.reasons).toContain('awaiting_buyer_confirmation')
  })

  it('holds while a dispute is open', () => {
    const g = evaluateServicesReleaseGate({ milestones: wc(UUID), buyerConfirmedAt: new Date(), disputeOpen: true })
    expect(g.reasons).toContain('dispute_open')
  })

  it('releases when photo + confirmation exist and no dispute', () => {
    const g = evaluateServicesReleaseGate({ milestones: wc(UUID), buyerConfirmedAt: new Date(), disputeOpen: false })
    expect(g.ok).toBe(true)
    expect(g.reasons).toEqual([])
  })
})
