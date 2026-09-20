import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPrompt, hasPrompt, loadDefaultPrompts, parsePromptFile } from './registry'
import { quoteExtractionSchema } from './quote_extract/schema'

const here = dirname(fileURLToPath(import.meta.url))

describe('prompt registry', () => {
  it('loads the shipped prompts, including quote_extract@v1 with the right task class + schemaRef', () => {
    loadDefaultPrompts()
    expect(hasPrompt('hello', 'v1')).toBe(true)
    expect(hasPrompt('photo_plausibility', 'v1')).toBe(true)
    const p = getPrompt('quote_extract', 'v1')
    expect(p.taskClass).toBe('quote_extract')
    expect(p.schemaRef).toBe('quoteExtractionSchema')
    expect(p.text).toMatch(/INTEGER PAISE/)
    expect(p.text).not.toMatch(/gpt-|claude-|gemini|openrouter/i) // no model ids in a prompt
  })

  it('the golden expectations parse with the prompt schema', () => {
    const cases = JSON.parse(readFileSync(join(here, '../../golden/quote_extract.json'), 'utf8')) as Array<{ id: string; expect: unknown }>
    expect(cases.length).toBeGreaterThanOrEqual(30)
    for (const c of cases) {
      const r = quoteExtractionSchema.safeParse(c.expect)
      expect(r.success, `${c.id}: ${r.success ? '' : JSON.stringify(r.error.flatten())}`).toBe(true)
    }
  })

  it('refuses an unknown id@version and malformed front-matter', () => {
    expect(() => getPrompt('quote_extract', 'v9')).toThrow(/not registered/)
    expect(() => parsePromptFile('no front matter')).toThrow()
  })
})
