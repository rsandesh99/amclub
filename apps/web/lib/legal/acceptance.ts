import 'server-only'
import { requiredLegalDocs, type LegalDoc, type LegalSurface } from '@amclub/shared'
import { LEGAL_VERSIONS_EFFECTIVE as LEGAL_VERSIONS } from '@/lib/legal/versions'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

export interface AcceptancePayload {
  ip: string | null
  user_agent: string | null
  locale: string | null
  surface: LegalSurface
}

/** Latest accepted version per document for a user (append-only table → newest row wins). */
export async function getAcceptedVersions(admin: Admin, userId: string): Promise<Partial<Record<LegalDoc, string>>> {
  const { data } = await admin
    .from('terms_acceptances')
    .select('doc, version, accepted_at')
    .eq('user_id', userId)
    .order('accepted_at', { ascending: false })
  const out: Partial<Record<LegalDoc, string>> = {}
  for (const row of data ?? []) {
    const doc = row.doc as LegalDoc
    if (!(doc in out)) out[doc] = row.version
  }
  return out
}

/** Documents this account still has to accept at the CURRENT versions. */
export async function missingLegalDocs(admin: Admin, userId: string, isProvider: boolean): Promise<LegalDoc[]> {
  const accepted = await getAcceptedVersions(admin, userId)
  return requiredLegalDocs(isProvider).filter((doc) => accepted[doc] !== LEGAL_VERSIONS[doc])
}

/** Whether the account has a provider profile or the provider role. */
export async function isProviderAccount(admin: Admin, userId: string): Promise<boolean> {
  const [{ data: prov }, { data: user }] = await Promise.all([
    admin.from('provider_profiles').select('id').eq('user_id', userId).maybeSingle(),
    admin.from('users').select('roles').eq('id', userId).maybeSingle(),
  ])
  return Boolean(prov) || ((user?.roles as string[] | undefined) ?? []).includes('provider')
}

/**
 * Append acceptance rows for the given docs at the current versions. Idempotent
 * per (user, doc, version): a doc already accepted at the current version is
 * skipped. Returns the docs actually written.
 */
export async function recordLegalAcceptances(
  admin: Admin,
  userId: string,
  docs: LegalDoc[],
  payload: AcceptancePayload,
): Promise<LegalDoc[]> {
  const accepted = await getAcceptedVersions(admin, userId)
  const toWrite = docs.filter((doc) => accepted[doc] !== LEGAL_VERSIONS[doc])
  if (toWrite.length === 0) return []
  const { error } = await admin.from('terms_acceptances').insert(
    toWrite.map((doc) => ({ user_id: userId, doc, version: LEGAL_VERSIONS[doc], payload })),
  )
  if (error) throw new Error(`terms_acceptances insert failed: ${error.message}`)
  return toWrite
}
