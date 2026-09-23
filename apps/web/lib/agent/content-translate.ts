import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CONTENT_TRANSLATE_FIELDS, contentTranslationViewSchema, type ContentField, type ContentSubjectKind, type ContentTranslateLang, type ContentTranslationView } from '@amclub/shared'
import { buildContentTranslateParts, contentTranslateSchema, contentTranslationProblems, stubContentTranslation, type ContentTranslateInput } from '@amclub/agent-core'
import { AGENT_ENABLED } from '@/lib/flags'
import { boundedChatJson } from '@/lib/agent/bounded'
import { isAgentEnabledForUser } from '@/lib/agent/settings'

/**
 * E14 FR-14.3 (N32b, dark) — DRAFTS of a provider's own catalogue copy in
 * hi / te / ta. One bounded `provider_content_translate@v1` call per field
 * (untrusted source enveloped; the customer-facing contract + the numbers,
 * length and script rules decide what may become a draft). Writes ONLY
 * `content_translations` (status `draft`) — nothing a buyer can see. The
 * provider's approve (lib/translations/content.ts, a spine path) is the only
 * way a text reaches a package or profile.
 */
export async function isContentTranslateEnabledFor(admin: SupabaseClient, userId: string): Promise<boolean> {
  return AGENT_ENABLED && (await isAgentEnabledForUser(admin, 'content_translate', userId))
}

export const CT_COLS = 'id, subject_kind, subject_id, field, lang, source_text, draft_text, status'
export function toContentTranslationView(r: Record<string, unknown>): ContentTranslationView | null {
  const v = contentTranslationViewSchema.safeParse({ id: r['id'], subjectKind: r['subject_kind'], subjectId: r['subject_id'], field: r['field'], lang: r['lang'], sourceText: r['source_text'], draftText: r['draft_text'], status: r['status'] })
  return v.success ? v.data : null
}

/** The English source of each translatable field (the provider's own, current). Null when the subject is not theirs. */
export async function contentSources(admin: SupabaseClient, a: { providerId: string; subjectKind: ContentSubjectKind; subjectId: string }): Promise<Partial<Record<ContentField, string>> | null> {
  if (a.subjectKind === 'package') {
    const { data } = await admin.from('packages').select('title_i18n, ideal_for_i18n, status').eq('id', a.subjectId).eq('provider_id', a.providerId).is('deleted_at', null).maybeSingle()
    if (!data || data.status === 'removed') return null
    const title = (data.title_i18n as { en?: string } | null)?.en?.trim()
    const ideal = (data.ideal_for_i18n as { en?: string } | null)?.en?.trim()
    return { ...(title ? { title } : {}), ...(ideal ? { ideal_for: ideal } : {}) }
  }
  const { data } = await admin.from('provider_profiles').select('about').eq('id', a.providerId).maybeSingle()
  if (!data) return null
  const about = (data.about as string | null)?.trim()
  return about ? { about } : {}
}

export async function draftContentTranslations(
  admin: SupabaseClient,
  a: { userId: string; providerId: string; subjectKind: ContentSubjectKind; subjectId: string; lang: ContentTranslateLang },
): Promise<{ drafts: ContentTranslationView[]; skipped: { field: ContentField; reason: string }[] } | null> {
  const sources = await contentSources(admin, a)
  if (!sources) return null
  const drafts: ContentTranslationView[] = []
  const skipped: { field: ContentField; reason: string }[] = []
  for (const field of CONTENT_TRANSLATE_FIELDS[a.subjectKind] as readonly ContentField[]) {
    const source = sources[field]
    if (!source) continue
    const input: ContentTranslateInput = { subjectId: a.subjectId, field, lang: a.lang, source }
    try {
      const res = await boundedChatJson(admin, {
        userId: a.userId,
        feature: 'content_translation',
        taskClass: 'content_translate',
        promptId: 'provider_content_translate',
        promptVersion: 'v1',
        schema: contentTranslateSchema,
        parts: buildContentTranslateParts(input),
        temperature: 0.2,
        stub: () => stubContentTranslation(input),
        meta: { subject_kind: a.subjectKind, field, lang: a.lang, source_chars: source.length },
      })
      const problems = contentTranslationProblems(input, res.data, { stub: res.stub })
      if (problems.length) { skipped.push({ field, reason: problems[0]! }); continue }
      // One open draft per (subject, field, lang): a fresh draft replaces the previous one.
      await admin.from('content_translations').update({ status: 'stale' }).eq('subject_kind', a.subjectKind).eq('subject_id', a.subjectId).eq('field', field).eq('lang', a.lang).eq('status', 'draft')
      const { data: row, error } = await admin
        .from('content_translations')
        .insert({ provider_id: a.providerId, subject_kind: a.subjectKind, subject_id: a.subjectId, field, lang: a.lang, source_text: source, draft_text: res.data.text })
        .select(CT_COLS)
        .single()
      if (error || !row) { skipped.push({ field, reason: 'store_failed' }); continue }
      const view = toContentTranslationView(row as Record<string, unknown>)
      if (view) drafts.push(view)
    } catch (e) {
      // Contract rejection (contact / payment / link), budget or model error: no draft for this field.
      skipped.push({ field, reason: (e as Error).name === 'BudgetExceededError' ? 'budget' : 'rejected' })
    }
  }
  return { drafts, skipped }
}
