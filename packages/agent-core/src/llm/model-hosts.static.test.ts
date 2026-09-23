import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Track F static invariant (ARCHITECTURE.md §7 "model calls go only through
 * agent-core/src/llm"): no model-host URL may appear in app or package code
 * outside packages/agent-core/src/llm. A direct fetch to a model vendor bypasses
 * max_tokens, the cost ledger, the budget and the residency guard.
 *
 * Scope: apps/web/lib, apps/agent-runtime/src, and every packages/* src tree.
 */

const HOSTS = ['openrouter.ai', 'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com']
const EXT = /\.(ts|tsx|js|mjs|cjs)$/

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../../..')
const allowedDir = resolve(here) + sep

function walk(dir: string, out: string[]): void {
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.next' || name === '.turbo') continue
    const p = join(dir, name)
    let isDir = false
    try {
      isDir = statSync(p).isDirectory()
    } catch {
      continue
    }
    if (isDir) walk(p, out)
    else if (EXT.test(name)) out.push(p)
  }
}

export function findModelHostViolations(root: string = repo): string[] {
  const files: string[] = []
  walk(join(root, 'apps/web/lib'), files)
  walk(join(root, 'apps/agent-runtime/src'), files)
  let pkgs: string[] = []
  try {
    pkgs = readdirSync(join(root, 'packages'))
  } catch {
    pkgs = []
  }
  for (const pkg of pkgs) walk(join(root, 'packages', pkg, 'src'), files)
  const violations: string[] = []
  for (const f of files) {
    if ((resolve(f) + '').startsWith(allowedDir)) continue
    const text = readFileSync(f, 'utf8')
    for (const h of HOSTS) {
      if (text.includes(h)) violations.push(`${relative(root, f)}: ${h}`)
    }
  }
  return violations
}

describe('static: model hosts only in agent-core/src/llm', () => {
  it('scans a non-trivial tree (the guard is not vacuous)', () => {
    const files: string[] = []
    walk(join(repo, 'apps/web/lib'), files)
    expect(files.length).toBeGreaterThan(50)
  })

  it('no model-host URL appears outside packages/agent-core/src/llm', () => {
    expect(findModelHostViolations()).toEqual([])
  })
})
