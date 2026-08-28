import type { LegalDoc } from '@amclub/shared'

/**
 * Client helper: record acceptance of legal docs at their current versions.
 * Signup wizards call this right after authentication and BEFORE creating a
 * profile — the profile endpoints refuse (403 legal_acceptance_required)
 * until the rows exist. Idempotent on the server.
 */
export async function acceptLegalDocs(docs: LegalDoc[], locale: string): Promise<{ ok: boolean; required: LegalDoc[] }> {
  const res = await fetch('/api/v1/legal/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docs, surface: 'web', locale }),
  })
  const d = (await res.json().catch(() => null)) as { required?: LegalDoc[] } | null
  return { ok: res.ok, required: d?.required ?? [] }
}
