import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CONTENT_FIELD_MAX, contentNumbersProblems, type ContentField, type ContentTranslateLang, type ContentTranslationView, type I18nSources, type I18nText } from '@amclub/shared'
import { checkCustomerFacing } from '@amclub/agent-core'
import { CT_COLS, contentSources, toContentTranslationView } from '@/lib/agent/content-translate'
import { recordAiDecision } from '@/lib/mart/events'
import { revalidateProviderCatalog } from '@/lib/catalog/revalidate'

/**
 * E14 FR-14.3 — the provider's side-by-side review of their translation drafts.
 * Approve is the ONLY write of a translated text into a package / profile i18n
 * map: it claims the draft (draft → approved, so a double tap cannot write
 * twice), re-checks the text (numbers copied, length, the customer-facing
 * contract — the provider may have edited it), writes the slot + its source
 * `machine_approved`, and records exactly one `ai_decisions` row (feature
 * `content_translation`). A draft whose English changed since is `stale`.
 */
type Admin = SupabaseClient
const MAP_COLUMN: Record<ContentField, string> = { title: 'title_i18n', ideal_for: 'ideal_for_i18n', about: 'about_i18n' }

export interface TranslatableSubject {
  kind: 'package' | 'profile'
  id: string
  label: string
  fields: { field: ContentField; source: string; live: Partial<Record<ContentTranslateLang, string>>; machine: Partial<Record<ContentTranslateLang, boolean>> }[]
}

/** The provider's subjects with their English, the live slots and the open drafts. The new columns are read tolerantly. */
export async function listTranslatable(admin: Admin, providerId: string): Promise<{ subjects: TranslatableSubject[]; drafts: ContentTranslationView[] }> {
  const [{ data: pkgs }, { data: prof }, { data: drafts }] = await Promise.all([
    admin.from('packages').select('id, title_i18n, ideal_for_i18n').eq('provider_id', providerId).neq('status', 'removed').is('deleted_at', null).order('created_at', { ascending: false }).limit(50),
    admin.from('provider_profiles').select('id, display_name, about').eq('id', providerId).maybeSingle(),
    admin.from('content_translations').select(CT_COLS).eq('provider_id', providerId).eq('status', 'draft').order('created_at', { ascending: false }).limit(300),
  ])
  const pkgSources = await readSources(admin, 'packages', (pkgs ?? []).map((p) => p.id as string))
  const profExtra = prof ? await readProfileI18n(admin, providerId) : null
  const pick = (map: Partial<Record<string, string>> | null | undefined): Partial<Record<ContentTranslateLang, string>> => ({ ...(map?.['hi'] ? { hi: map['hi'] } : {}), ...(map?.['te'] ? { te: map['te'] } : {}), ...(map?.['ta'] ? { ta: map['ta'] } : {}) })
  const machine = (s: I18nSources | null | undefined, f: ContentField) => ({ hi: s?.[f]?.hi === 'machine_approved', te: s?.[f]?.te === 'machine_approved', ta: s?.[f]?.ta === 'machine_approved' })
  const subjects: TranslatableSubject[] = []
  if (prof?.about) subjects.push({ kind: 'profile', id: providerId, label: String(prof.display_name ?? ''), fields: [{ field: 'about', source: String(prof.about), live: pick(profExtra?.aboutI18n ?? null), machine: machine(profExtra?.sources, 'about') }] })
  for (const p of pkgs ?? []) {
    const title = p.title_i18n as Partial<Record<string, string>> | null
    const ideal = p.ideal_for_i18n as Partial<Record<string, string>> | null
    const s = pkgSources.get(p.id as string) ?? null
    const fields: TranslatableSubject['fields'] = []
    if (title?.['en']) fields.push({ field: 'title', source: title['en'], live: pick(title), machine: machine(s, 'title') })
    if (ideal?.['en']) fields.push({ field: 'ideal_for', source: ideal['en'], live: pick(ideal), machine: machine(s, 'ideal_for') })
    if (fields.length) subjects.push({ kind: 'package', id: p.id as string, label: title?.['en'] ?? '', fields })
  }
  return { subjects, drafts: ((drafts ?? []) as Record<string, unknown>[]).map(toContentTranslationView).filter((d): d is ContentTranslationView => !!d) }
}

export type ApproveResult = { ok: true; decisionId: string | null } | { ok: false; status: number; code: string }

export async function approveContentTranslation(admin: Admin, a: { id: string; providerId: string; userId: string; text?: string }): Promise<ApproveResult> {
  // 1. Claim the draft (one approval per draft, whatever the taps).
  const { data: claimed } = await admin.from('content_translations').update({ status: 'approved', decided_at: new Date().toISOString() }).eq('id', a.id).eq('provider_id', a.providerId).eq('status', 'draft').select('id, subject_kind, subject_id, field, lang, source_text, draft_text')
  const row = (claimed as Record<string, unknown>[] | null)?.[0]
  if (!row) return { ok: false, status: 409, code: 'not_a_draft' }
  const release = async (status: 'draft' | 'stale') => { await admin.from('content_translations').update({ status, decided_at: null }).eq('id', a.id) }
  const kind = row['subject_kind'] as 'package' | 'profile'
  const subjectId = row['subject_id'] as string
  const field = row['field'] as ContentField
  const lang = row['lang'] as ContentTranslateLang
  const draft = String(row['draft_text'])
  const final = (a.text ?? draft).trim()

  // 2. The English it was drafted from is still the live English.
  const sources = await contentSources(admin, { providerId: a.providerId, subjectKind: kind, subjectId })
  if (!sources || sources[field] !== row['source_text']) { await release('stale'); return { ok: false, status: 409, code: 'source_changed' } }
  // 3. The approved text obeys the same rules as a draft (the provider may have edited it).
  const source = sources[field]!
  if (!final || final.length > CONTENT_FIELD_MAX[field] || contentNumbersProblems(source, final).length || checkCustomerFacing({ text: final }, { fields: ['text'], forbid: ['contact', 'payment', 'urls'] }).length) {
    await release('draft')
    return { ok: false, status: 422, code: 'text_rejected' }
  }

  // 4. Write the slot and mark its source.
  const written = await writeSlot(admin, { kind, subjectId, providerId: a.providerId, field, lang, text: final })
  if (!written) { await release('draft'); return { ok: false, status: 500, code: 'write_failed' } }

  // 5. Exactly one confirmation row.
  const decisionId = await recordAiDecision(admin, a.userId, {
    feature: 'content_translation',
    input_refs: { translation_id: a.id, subject_kind: kind, subject_id: subjectId, field, lang },
    proposed: { text: draft },
    final: { text: final },
  })
  await admin.from('content_translations').update({ final_text: final, decision_id: decisionId }).eq('id', a.id)
  await revalidateProviderCatalog(admin, a.providerId).catch(() => undefined)
  return { ok: true, decisionId }
}

export async function rejectContentTranslation(admin: Admin, a: { id: string; providerId: string }): Promise<boolean> {
  const { data } = await admin.from('content_translations').update({ status: 'rejected', decided_at: new Date().toISOString() }).eq('id', a.id).eq('provider_id', a.providerId).eq('status', 'draft').select('id')
  return ((data as unknown[] | null) ?? []).length === 1
}

async function writeSlot(admin: Admin, a: { kind: 'package' | 'profile'; subjectId: string; providerId: string; field: ContentField; lang: ContentTranslateLang; text: string }): Promise<boolean> {
  const table = a.kind === 'package' ? 'packages' : 'provider_profiles'
  const col = MAP_COLUMN[a.field]
  const { data, error } = await admin.from(table).select(`${col}, i18n_sources`).eq('id', a.subjectId).maybeSingle()
  if (error || !data) return false
  const cur = data as unknown as Record<string, unknown>
  const map = { ...((cur[col] as Record<string, string> | null) ?? {}), [a.lang]: a.text }
  const sources = (cur['i18n_sources'] as I18nSources | null) ?? {}
  const nextSources: I18nSources = { ...sources, [a.field]: { ...(sources[a.field] ?? {}), [a.lang]: 'machine_approved' } }
  let q = admin.from(table).update({ [col]: map, i18n_sources: nextSources }).eq('id', a.subjectId)
  if (a.kind === 'package') q = q.eq('provider_id', a.providerId)
  const { error: upErr } = await q
  return !upErr
}

// ── Buyer-side readers: tolerant of the 0061 columns being absent (null = nothing translated) ─────────────

async function readSources(client: SupabaseClient, table: 'packages', ids: string[]): Promise<Map<string, I18nSources>> {
  const out = new Map<string, I18nSources>()
  if (!ids.length) return out
  const { data, error } = await client.from(table).select('id, i18n_sources').in('id', ids)
  if (error) return out
  for (const r of data ?? []) if (r.i18n_sources) out.set(r.id as string, r.i18n_sources as I18nSources)
  return out
}

/** Which of these packages' slots are approved machine translations (for the "Translated · View original" label). */
export async function packageI18nSources(client: SupabaseClient, ids: string[]): Promise<Map<string, I18nSources>> {
  return readSources(client, 'packages', ids)
}

/** The profile's About in hi / te / ta and its sources. */
export async function readProfileI18n(client: SupabaseClient, providerId: string): Promise<{ aboutI18n: Partial<I18nText> | null; sources: I18nSources | null } | null> {
  const { data, error } = await client.from('provider_profiles').select('about_i18n, i18n_sources').eq('id', providerId).maybeSingle()
  if (error || !data) return null
  return { aboutI18n: (data.about_i18n as Partial<I18nText> | null) ?? null, sources: (data.i18n_sources as I18nSources | null) ?? null }
}
