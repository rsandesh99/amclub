/**
 * E14 FR-14.1 — the buying-path language gate.
 *
 *   pnpm --filter @amclub/web i18n:coverage            # CI: every key live or drafted
 *   pnpm --filter @amclub/web i18n:coverage --strict   # launch gate: every key live (no pending drafts)
 *
 * For each locale in `i18n/coverage.config.json` and every key of every
 * buying-path namespace in `messages/en.json`, the key must be in the live
 * file (`messages/<locale>.json`) or — unless `--strict` — in the
 * reviewed-pending drafts (`messages/drafts/<locale>.json`). It also fails on:
 * a te / ta message that does not parse, or whose ICU argument names or tags
 * differ from English (a broken placeholder is a runtime crash); a
 * draft or live buying-path key English no longer has; a draft outside the
 * buying path. Outside the buying path a bad live message is a warning.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'

const ROOT = join(__dirname, '..')
const strict = process.argv.includes('--strict')
const config = JSON.parse(readFileSync(join(ROOT, 'i18n/coverage.config.json'), 'utf8')) as { locales: string[]; buyingPath: string[] }

type Tree = { [k: string]: string | Tree }
const load = (p: string): Tree => JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as Tree
function flat(t: Tree, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(t)) {
    if (!prefix && k.startsWith('_')) continue // file-level comments
    if (typeof v === 'string') out[prefix + k] = v
    else flat(v, `${prefix}${k}.`, out)
  }
  return out
}

/**
 * The parts of a message a translation must keep: every argument name and every
 * rich-text tag. A translation may express an English plural as a plain
 * argument (or the reverse) — that renders; a renamed or dropped argument,
 * a stray one, or a lost tag does not.
 */
export function icuSignature(message: string): string {
  const acc = new Set<string>()
  const walk = (els: MessageFormatElement[]) => {
    for (const el of els) {
      if (el.type === TYPE.argument || el.type === TYPE.number || el.type === TYPE.date || el.type === TYPE.time) acc.add(`arg:${el.value}`)
      else if (el.type === TYPE.plural || el.type === TYPE.select) {
        acc.add(`arg:${el.value}`)
        for (const o of Object.values(el.options)) walk(o.value)
      } else if (el.type === TYPE.tag) {
        acc.add(`tag:${el.value}`)
        walk(el.children)
      }
    }
  }
  walk(parse(message))
  return [...acc].sort().join('|')
}

const en = flat(load('messages/en.json'))
const inPath = (k: string) => config.buyingPath.includes(k.split('.')[0]!)
let errors = 0
let warnings = 0
const err = (msg: string) => { errors++; console.log(`  ✗ ${msg}`) }

for (const locale of config.locales) {
  const live = flat(load(`messages/${locale}.json`))
  const drafts = flat(load(`messages/drafts/${locale}.json`))
  console.log(`\n${locale}${strict ? ' (strict: drafts count as missing)' : ''}`)

  const check = (key: string, value: string, where: 'live' | 'draft') => {
    const source = en[key]
    if (source === undefined) {
      if (where === 'draft' || inPath(key)) err(`${where} ${key}: English no longer has this key`)
      return
    }
    let want: string
    try { want = icuSignature(source) } catch { return } // English itself is checked by next-intl
    let got: string
    try { got = icuSignature(value) } catch (e) {
      if (inPath(key) || where === 'draft') err(`${where} ${key}: does not parse (${(e as Error).message})`)
      else { warnings++; console.log(`  ! live ${key}: does not parse`) }
      return
    }
    if (got !== want) {
      if (inPath(key) || where === 'draft') err(`${where} ${key}: placeholders differ from English\n      en: ${want}\n      ${locale}: ${got}`)
      else { warnings++; console.log(`  ! live ${key}: placeholders differ from English`) }
    }
  }
  for (const [k, v] of Object.entries(live)) check(k, v, 'live')
  for (const [k, v] of Object.entries(drafts)) {
    if (!inPath(k)) err(`draft ${k}: drafts hold buying-path namespaces only`)
    if (k in live) err(`draft ${k}: already live (promote removes the draft)`)
    check(k, v, 'draft')
  }

  const rows: string[] = []
  let total = 0, liveN = 0, draftN = 0
  for (const ns of config.buyingPath) {
    const keys = Object.keys(en).filter((k) => k.split('.')[0] === ns)
    if (keys.length === 0) { err(`namespace ${ns} is in the config but not in en.json`); continue }
    const l = keys.filter((k) => k in live).length
    const d = keys.filter((k) => !(k in live) && k in drafts).length
    const missing = keys.filter((k) => !(k in live) && (strict || !(k in drafts)))
    total += keys.length; liveN += l; draftN += d
    if (missing.length) err(`${ns}: ${missing.length} missing — ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`)
    rows.push(`  ${ns.padEnd(16)} ${String(keys.length).padStart(4)} keys · live ${String(l).padStart(4)} · draft ${String(d).padStart(4)}`)
  }
  console.log(rows.join('\n'))
  const pct = (n: number) => `${total ? Math.floor((n / total) * 1000) / 10 : 100} %`
  console.log(`  ${locale}: ${total} buying-path keys · live ${pct(liveN)} · with drafts ${pct(liveN + draftN)}`)
}

console.log(`\n${errors === 0 ? '✓' : '✗'} i18n coverage: ${errors} error(s), ${warnings} warning(s) outside the buying path`)
process.exit(errors === 0 ? 0 : 1)
