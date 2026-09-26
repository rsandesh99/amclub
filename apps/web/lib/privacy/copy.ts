import 'server-only'
import { createTranslator, type AbstractIntlMessages } from 'next-intl'
import en from '@/messages/en.json'
import hi from '@/messages/hi.json'
import te from '@/messages/te.json'
import ta from '@/messages/ta.json'
import teDrafts from '@/messages/drafts/te.json'
import taDrafts from '@/messages/drafts/ta.json'
import { draftNamespacesOn } from '@/i18n/drafts'

/**
 * The text a DPDP answer carries to the user (the `dpdp_answer` namespace): the fixed sentence ops cannot leave out of
 * an erasure answer (what was erased, what the law makes us keep) and the in-app notice. Rendered on the server in the
 * user's language: the live file, else the reviewed-pending draft while EXP_V3_LOCALES is on, else English.
 */

const NS = 'dpdp_answer'
type Tree = { [k: string]: string | Tree }
type Locale = 'en' | 'hi' | 'te' | 'ta'
const nsOf = (m: unknown): Tree | undefined => (m as Record<string, Tree | undefined>)[NS]
const has = (t: Tree | undefined, key: string) => typeof t?.[key] === 'string'

function treeFor(locale: Locale, key: string): { locale: Locale; tree: Tree } {
  const live = { en, hi, te, ta }[locale]
  if (has(nsOf(live), key)) return { locale, tree: nsOf(live)! }
  if ((locale === 'te' || locale === 'ta') && draftNamespacesOn().includes(NS)) {
    const d = nsOf(locale === 'te' ? teDrafts : taDrafts)
    if (has(d, key)) return { locale, tree: d! }
  }
  return { locale: 'en', tree: nsOf(en)! }
}

export function dpdpAnswerText(locale: string | null | undefined, key: string, values: Record<string, string | number> = {}): string {
  const l = (['en', 'hi', 'te', 'ta'].includes(String(locale)) ? locale : 'en') as Locale
  const { locale: used, tree } = treeFor(l, key)
  const t = createTranslator({ locale: used, messages: { [NS]: tree } as AbstractIntlMessages, namespace: NS })
  return (t as unknown as (k: string, v?: Record<string, string | number>) => string)(key, values)
}

/** The four-language map `createNotification` stores (en + hi always; te / ta when that locale has the copy). */
export function dpdpAnswerI18n(key: string, values: Record<string, string | number> = {}): { en: string; hi: string; te?: string; ta?: string } {
  const out: { en: string; hi: string; te?: string; ta?: string } = { en: dpdpAnswerText('en', key, values), hi: dpdpAnswerText('hi', key, values) }
  for (const l of ['te', 'ta'] as const) if (treeFor(l, key).locale === l) out[l] = dpdpAnswerText(l, key, values)
  return out
}
