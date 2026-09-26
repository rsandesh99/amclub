import 'server-only'
import { corpusSourceAllowed, intakeCorrections, type VoiceMeta } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import type { IntakeRow } from '@/lib/agent/intake'
import { getAgentSetting } from '@/lib/agent/settings'
import { delegatedRunId } from '@/lib/agent/scope'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/** The opt-in is offered (and new rows kept) only while `corpus_consent_enabled` is on. Any failure = off. */
export async function corpusConsentOffered(admin: Admin): Promise<boolean> {
  try {
    return (await getAgentSetting(admin, 'corpus_consent_enabled')) === true
  } catch {
    return false
  }
}

/**
 * ADR-030 §5 — the surface of the agent run this request is made under (a delegated token names its run; the run
 * records its surface). null for an ordinary session. A lookup failure reads as 'whatsapp': when the source cannot be
 * proven, nothing is kept.
 */
async function delegatedRunSurface(admin: Admin): Promise<string | null> {
  let runId: string | null = null
  try {
    runId = await delegatedRunId()
  } catch {
    return null // no request context (a script): not a delegated call
  }
  if (!runId) return null
  const { data, error } = await admin.from('agent_runs').select('surface').eq('id', runId).maybeSingle()
  if (error) return 'whatsapp'
  return (data as { surface?: string } | null)?.surface ?? 'whatsapp'
}

/**
 * E15 FR-15.4 (F6) — consented corpora, written at RFQ create ONLY for a buyer
 * who opted in (`users.corpus_consent_at`) while the switch is on. Text only: the voice triple is
 * transcript → the parse → the buyer's final request (no audio exists to
 * keep); an image pair references the document already in the private
 * rfq-attachments bucket by key, with the keys the buyer corrected.
 * Best-effort; never blocks the create.
 *
 * ADR-030 §5 (Meta Business Solution Terms): nothing that came from WhatsApp is ever written — not the transcript, not
 * the documents, not anything derived from them. The source is WhatsApp when the voice metadata says so or when the
 * request runs under a delegated token whose agent run is on WhatsApp.
 */
export async function writeConsentedCorpus(admin: Admin, a: { userId: string; rfqId: string; voiceMeta: VoiceMeta | undefined; intakeRows: IntakeRow[]; final: { title: string; categorySlug: string | null; details: Record<string, unknown> } }): Promise<void> {
  try {
    const { data: u, error } = await admin.from('users').select('corpus_consent_at').eq('id', a.userId).maybeSingle()
    if (error || !u?.corpus_consent_at || !(await corpusConsentOffered(admin))) return
    if (!corpusSourceAllowed({ voiceChannel: a.voiceMeta?.channel ?? null, runSurface: await delegatedRunSurface(admin) })) return
    const final = { title: a.final.title, category_slug: a.final.categorySlug, detail_keys: Object.keys(a.final.details ?? {}) }
    if (a.voiceMeta?.transcript_english) {
      const lang = (a.voiceMeta.parse as { original_language?: string }).original_language ?? null
      await admin.from('corpus_voice_triples').insert({ user_id: a.userId, rfq_id: a.rfqId, lang, transcript: a.voiceMeta.transcript_english.slice(0, 4000), parsed: a.voiceMeta.parse, final })
    }
    const docs = a.intakeRows.filter((r) => r.kind === 'document')
    if (docs.length) {
      const { data: refs } = await admin.from('rfq_intake_extractions').select('id, input_refs').in('id', docs.map((d) => d.id))
      const keyOf = new Map((refs ?? []).map((r) => [r.id as string, ((r.input_refs as { attachment_path?: string } | null)?.attachment_path) ?? null]))
      await admin.from('corpus_image_pairs').insert(docs.map((d) => {
        const proposed = (d.proposed ?? {}) as Record<string, unknown>
        return { user_id: a.userId, rfq_id: a.rfqId, storage_key: keyOf.get(d.id) ?? null, doc_type: (proposed['doc_type'] as string | undefined) ?? null, proposed, final, corrections: intakeCorrections(proposed, { title: a.final.title, categorySlug: a.final.categorySlug }) }
      }))
    }
  } catch (e) {
    console.warn('[corpus] write', (e as Error).message)
  }
}
