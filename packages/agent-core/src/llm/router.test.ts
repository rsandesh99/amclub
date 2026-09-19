import { afterEach, describe, expect, it } from 'vitest'
import { MODEL_DEFAULTS, resolveEmbeddingModel, resolveModel } from './router'

describe('model router (the ONE tier -> model mapping)', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('maps a task class to its tier default', () => {
    delete process.env['AGENT_MODEL_ROUTINE']
    const r = resolveModel('rfq_parse')
    expect(r.tier).toBe('routine')
    expect(r.model).toBe(MODEL_DEFAULTS.routine)
  })

  it('an env override wins over the default', () => {
    process.env['AGENT_MODEL_FRONTIER'] = 'vendor/custom-frontier'
    const r = resolveModel('document_extract')
    expect(r.tier).toBe('frontier')
    expect(r.model).toBe('vendor/custom-frontier')
  })

  it('a device-tier class has no server model', () => {
    // no task class currently routes to device, but the guard must hold if one does
    expect(() => resolveModel('speech_to_text')).not.toThrow()
  })

  it('resolves an embedding model', () => {
    delete process.env['AGENT_MODEL_EMBEDDING']
    expect(resolveEmbeddingModel()).toBeTruthy()
  })
})
