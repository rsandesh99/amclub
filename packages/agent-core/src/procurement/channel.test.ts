import { describe, expect, it } from 'vitest'
import { corpusSourceAllowed, voiceMetaSchema } from '@amclub/shared'
import { rfqCreateBody } from './agent'

/**
 * ADR-030 §5 (Meta Business Solution Terms): WhatsApp content never enters the corpus or eval sets. A request the
 * procurement agent drafts from WhatsApp carries voice_meta.channel = 'whatsapp' through the ordinary RFQ contract, and
 * the corpus writer refuses it.
 */
describe('procurement voice_meta carries its channel', () => {
  const parse = { category_slug: 'tax-accounting' as const, specialization: null, state: null, description_english: 'Monthly GST filing for a shop.', original_language: 'te-IN', uncertain: false }
  const base = { categorySlug: 'tax-accounting', description: parse.description_english, via: 'audio' as const, parse, transcript: 'monthly gst', clarified: null, docs: [] }

  it('a WhatsApp voice request is tagged whatsapp, survives the RFQ schema and is refused by the corpus rule', () => {
    const body = rfqCreateBody({ ...base, channel: 'whatsapp' })
    const vm = voiceMetaSchema.parse(body['voice_meta'])
    expect(vm.channel).toBe('whatsapp')
    expect(corpusSourceAllowed({ voiceChannel: vm.channel })).toBe(false)
  })
  it('a web voice request keeps its channel and stays eligible (with the buyer\'s own opt-in)', () => {
    const vm = voiceMetaSchema.parse(rfqCreateBody({ ...base, channel: 'web' })['voice_meta'])
    expect(vm.channel).toBe('web')
    expect(corpusSourceAllowed({ voiceChannel: vm.channel })).toBe(true)
  })
  it('no channel given → no channel key (older callers unchanged)', () => {
    expect((rfqCreateBody(base)['voice_meta'] as Record<string, unknown>)['channel']).toBeUndefined()
  })
})
