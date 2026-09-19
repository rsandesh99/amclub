import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentTaskClassSchema, type AgentTaskClass } from '@amclub/shared'

/**
 * Prompt registry (ADR-009 §5). Every prompt is a file
 * `src/prompts/<id>/<version>.md` with YAML-ish front-matter
 * `{ id, version, taskClass, schemaRef }`, so a prompt change is a reviewable
 * diff and the model id never appears in the prompt (only the router knows it).
 * The loader refuses an unknown `id@version` — a caller cannot invent a prompt.
 */

export interface PromptMeta {
  id: string
  version: string
  taskClass: AgentTaskClass
  /** Name of the Zod schema (in this repo) the model output must satisfy. */
  schemaRef: string
}

export interface PromptRef extends PromptMeta {
  /** The prompt body (system instructions). Trusted content only. */
  text: string
}

/** Parse a `<id>/<version>.md` file's front-matter + body into a PromptRef. */
export function parsePromptFile(raw: string): PromptRef {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw)
  if (!m) throw new Error('prompt file missing front-matter (--- … ---)')
  const front = m[1] ?? ''
  const body = (m[2] ?? '').trim()
  const meta: Record<string, string> = {}
  for (const line of front.split('\n')) {
    const kv = /^([A-Za-z_]+)\s*:\s*(.+)$/.exec(line.trim())
    if (kv) meta[kv[1] as string] = (kv[2] as string).trim()
  }
  const id = meta['id']
  const version = meta['version']
  const taskClass = meta['taskClass']
  const schemaRef = meta['schemaRef']
  if (!id || !version || !taskClass || !schemaRef) {
    throw new Error('prompt front-matter needs id, version, taskClass, schemaRef')
  }
  const tc = agentTaskClassSchema.safeParse(taskClass)
  if (!tc.success) throw new Error(`prompt ${id}@${version}: unknown taskClass '${taskClass}'`)
  if (!body) throw new Error(`prompt ${id}@${version}: empty body`)
  return { id, version, taskClass: tc.data, schemaRef, text: body }
}

const key = (id: string, version: string) => `${id}@${version}`

const REGISTRY = new Map<string, PromptRef>()

/** Register (or replace) a prompt. Idempotent for the same content. */
export function registerPrompt(ref: PromptRef): PromptRef {
  REGISTRY.set(key(ref.id, ref.version), ref)
  return ref
}

export function hasPrompt(id: string, version: string): boolean {
  return REGISTRY.has(key(id, version))
}

/** Get a registered prompt or throw — the loader refuses an unknown id@version. */
export function getPrompt(id: string, version: string): PromptRef {
  const ref = REGISTRY.get(key(id, version))
  if (!ref) throw new Error(`unknown prompt ${key(id, version)} (not registered)`)
  return ref
}

export function listPrompts(): PromptRef[] {
  return [...REGISTRY.values()]
}

/** Load every `<id>/<version>.md` under `dir` into the registry (runtime/eval boot). */
export function loadPromptsFromDir(dir: string): PromptRef[] {
  const loaded: PromptRef[] = []
  let ids: string[] = []
  try {
    ids = readdirSync(dir)
  } catch {
    return loaded
  }
  for (const id of ids) {
    const idDir = join(dir, id)
    let isDir = false
    try {
      isDir = statSync(idDir).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) continue
    for (const file of readdirSync(idDir)) {
      if (!file.endsWith('.md')) continue
      const raw = readFileSync(join(idDir, file), 'utf8')
      const ref = registerPrompt(parsePromptFile(raw))
      loaded.push(ref)
    }
  }
  return loaded
}

/** Load the prompts shipped inside agent-core (this directory). */
export function loadDefaultPrompts(): PromptRef[] {
  const here = dirname(fileURLToPath(import.meta.url))
  return loadPromptsFromDir(here)
}
