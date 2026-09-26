import { describe, expect, it } from 'vitest'
import { channelEnabled, essentialChannelMissing, isPaused, pauseUntilIso, preferencesPatchSchema, withChannel } from '../preferences'
import { notificationSettingsSchema, type NotificationPreference } from '../notify'

describe('preferencesPatchSchema', () => {
  it('takes the density, the language, or both', () => {
    expect(preferencesPatchSchema.safeParse({ uiDensity: 'compact' }).success).toBe(true)
    expect(preferencesPatchSchema.safeParse({ uiDensity: null }).success).toBe(true)
    expect(preferencesPatchSchema.safeParse({ preferredLocale: 'te' }).success).toBe(true)
    expect(preferencesPatchSchema.safeParse({ preferredLocale: 'ta', uiDensity: 'comfortable' }).success).toBe(true)
  })
  it('refuses an empty patch, an unknown density and an unknown language', () => {
    expect(preferencesPatchSchema.safeParse({}).success).toBe(false)
    expect(preferencesPatchSchema.safeParse({ uiDensity: 'tiny' }).success).toBe(false)
    expect(preferencesPatchSchema.safeParse({ preferredLocale: 'fr' }).success).toBe(false)
  })
})

describe('notification settings helpers', () => {
  const prefs: NotificationPreference[] = [
    { category: 'orders', channel: 'email', enabled: false },
    { category: 'orders', channel: 'whatsapp', enabled: true },
  ]
  it('a sent row wins; a missing row falls back (on, except offers and push)', () => {
    expect(channelEnabled(prefs, 'orders', 'email')).toBe(false)
    expect(channelEnabled(prefs, 'orders', 'whatsapp')).toBe(true)
    expect(channelEnabled(prefs, 'orders', 'sms')).toBe(true)
    expect(channelEnabled(prefs, 'updates', 'email')).toBe(false)
    expect(channelEnabled(prefs, 'orders', 'push')).toBe(false)
  })
  it('withChannel replaces the row instead of adding a second one', () => {
    const next = withChannel(prefs, 'orders', 'email', true)
    expect(next.filter((p) => p.category === 'orders' && p.channel === 'email')).toEqual([{ category: 'orders', channel: 'email', enabled: true }])
    expect(next).toHaveLength(2)
  })
  it('an essential category must keep one of email / SMS / WhatsApp', () => {
    const allOff = withChannel(withChannel(withChannel(prefs, 'payments', 'email', false), 'payments', 'sms', false), 'payments', 'whatsapp', false)
    expect(essentialChannelMissing(allOff, ['orders', 'payments'])).toBe('payments')
    expect(essentialChannelMissing(allOff, ['orders'])).toBeNull()
    // push being "on" does not count (it is not switchable yet)
    expect(essentialChannelMissing(withChannel(allOff, 'payments', 'push', true), ['payments'])).toBe('payments')
  })
  it('a pause ends at 08:00 IST on the chosen day, and the value passes the settings schema', () => {
    // 2026-09-26 23:30 IST (18:00 UTC) + 1 day → 2026-09-27 08:00 IST = 02:30 UTC
    const until = pauseUntilIso(1, new Date('2026-09-26T18:00:00Z'))
    expect(until).toBe('2026-09-27T02:30:00.000Z')
    // 2026-09-27 00:30 IST (2026-09-26 19:00 UTC) is already the 27th in India → +3 days = the 30th
    expect(pauseUntilIso(3, new Date('2026-09-26T19:00:00Z'))).toBe('2026-09-30T02:30:00.000Z')
    expect(notificationSettingsSchema.safeParse({ preferences: [], quietHours: null, pausedUntil: until, digestLeads: false }).success).toBe(true)
  })
  it('isPaused is true only for a future instant', () => {
    const now = new Date('2026-09-26T10:00:00Z')
    expect(isPaused('2026-09-27T02:30:00.000Z', now)).toBe(true)
    expect(isPaused('2026-09-25T02:30:00.000Z', now)).toBe(false)
    expect(isPaused(null, now)).toBe(false)
    expect(isPaused('garbage', now)).toBe(false)
  })
})
