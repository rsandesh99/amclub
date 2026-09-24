import 'server-only'
import { createTranslator, type AbstractIntlMessages } from 'next-intl'
import { pickI18n } from '@amclub/shared'
import en from '@/messages/en.json'
import hi from '@/messages/hi.json'
import te from '@/messages/te.json'
import ta from '@/messages/ta.json'
import teDrafts from '@/messages/drafts/te.json'
import taDrafts from '@/messages/drafts/ta.json'
import { draftNamespacesOn } from '@/i18n/drafts'

/**
 * E14 FR-14.1 — notification copy is the `notify` namespace of the message
 * files, so it sits in the buying-path gate (`i18n:coverage`) and the drafts
 * overlay like every other buying-path string. `notifyText(key, values)` gives
 * the four-language map `createNotification` stores: `en` + `hi` always; `te` /
 * `ta` only when that locale has the key live, or drafted while
 * `EXP_V3_LOCALES` is on for `notify` — otherwise the slot is absent and the
 * reader gets English (`resolveText`). A value may itself be a four-language
 * map (a milestone label, the "your request" fallback): each locale takes its
 * own slot.
 */
export type NotifyText = { en: string; hi: string; te?: string; ta?: string }
type Value = string | number | { en: string; hi?: string; te?: string; ta?: string }

type Tree = { [k: string]: string | Tree }
const NS = 'notify'
const nsOf = (m: unknown): Tree | undefined => (m as Record<string, Tree | undefined>)[NS]

function has(tree: Tree | undefined, key: string): boolean {
  let node: string | Tree | undefined = tree
  for (const part of key.split('.')) node = typeof node === 'object' ? node[part] : undefined
  return typeof node === 'string'
}

function format(locale: string, tree: Tree, key: string, values: Record<string, Value>): string {
  const own: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(values)) own[k] = typeof v === 'object' ? pickI18n(v, locale) : v
  const t = createTranslator({ locale, messages: { [NS]: tree } as AbstractIntlMessages, namespace: NS })
  return (t as unknown as (k: string, v?: Record<string, string | number>) => string)(key, own)
}

export function notifyText(key: string, values: Record<string, Value> = {}): NotifyText {
  const enTree = nsOf(en)!
  const out: NotifyText = { en: format('en', enTree, key, values), hi: format('hi', has(nsOf(hi), key) ? nsOf(hi)! : enTree, key, values) }
  const draftsOn = draftNamespacesOn().includes(NS)
  for (const [locale, live, drafts] of [['te', te, teDrafts], ['ta', ta, taDrafts]] as const) {
    const tree = has(nsOf(live), key) ? nsOf(live) : draftsOn && has(nsOf(drafts), key) ? nsOf(drafts) : undefined
    if (tree) out[locale] = format(locale, tree, key, values)
  }
  return out
}

/** A plain map for user content that is never translated (a request title as a notification body). */
export const sameText = (text: string): NotifyText => ({ en: text, hi: text })
