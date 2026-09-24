import 'server-only'
import coverage from './coverage.config.json'
import { isOnForEveryone } from '@/lib/experiments'

/**
 * E14 FR-14.1 — reviewed-pending te / ta copy. Machine drafts for the buying
 * path live in `messages/drafts/<locale>.json` until a native speaker approves
 * them (`pnpm --filter @amclub/web i18n:promote`, which moves the namespace into
 * the live file and logs the reviewer). They render only while
 * `EXP_V3_LOCALES=on`, and only for the namespaces in
 * `EXP_V3_LOCALES_NAMESPACES` (comma list; unset = every buying-path
 * namespace). Message files are loaded once per request with no user, so the
 * flag honours `on` only — a percentage or cohort has no effect here.
 */
export const DRAFT_LOCALES = coverage.locales as readonly string[]
export const BUYING_PATH_NAMESPACES = coverage.buyingPath as readonly string[]

export function draftNamespacesOn(): string[] {
  if (!isOnForEveryone('locales')) return []
  const raw = (process.env['EXP_V3_LOCALES_NAMESPACES'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return raw.length ? BUYING_PATH_NAMESPACES.filter((ns) => raw.includes(ns)) : [...BUYING_PATH_NAMESPACES]
}

/** The draft namespaces that are switched on, and nothing else. */
export function pickDraftNamespaces<T extends Record<string, unknown>>(drafts: T, on: readonly string[]): Partial<T> {
  const out: Partial<T> = {}
  for (const ns of on) if (ns in drafts) (out as Record<string, unknown>)[ns] = drafts[ns]
  return out
}
