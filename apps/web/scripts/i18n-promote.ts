/**
 * E14 FR-14.1 — a native speaker approved a namespace: move its drafts live.
 *
 *   pnpm --filter @amclub/web i18n:promote -- --locale te --ns checkout --reviewer "A. Reviewer"
 *
 * Moves `messages/drafts/<locale>.json` → `<ns>` into `messages/<locale>.json`
 * (English key order; a key already live is left alone), removes it from the
 * drafts and appends one line to `messages/drafts/REVIEW_LOG.json` (locale,
 * namespace, key count, reviewer, date). The reviewer edits the draft JSON
 * first when a string needs changing; this script only moves approved text.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const locale = arg('locale')
const ns = arg('ns')
const reviewer = arg('reviewer')?.trim()
const config = JSON.parse(readFileSync(join(ROOT, 'i18n/coverage.config.json'), 'utf8')) as { locales: string[]; buyingPath: string[] }
if (!locale || !config.locales.includes(locale) || !ns || !config.buyingPath.includes(ns) || !reviewer) {
  console.error(`usage: i18n:promote -- --locale <${config.locales.join('|')}> --ns <buying-path namespace> --reviewer "<name>"`)
  process.exit(2)
}

type Tree = { [k: string]: string | Tree }
const read = (p: string): Tree => JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as Tree
const write = (p: string, t: unknown) => writeFileSync(join(ROOT, p), `${JSON.stringify(t, null, 2)}\n`)

const en = read('messages/en.json')
const live = read(`messages/${locale}.json`)
const drafts = read(`messages/drafts/${locale}.json`)
const draftNs = drafts[ns]
if (!draftNs || typeof draftNs === 'string') { console.error(`no drafts for ${locale}.${ns}`); process.exit(1) }

/** English's shape and order; the live value wins, else the draft. */
function merge(enT: Tree, liveT: Tree | undefined, draftT: Tree | undefined): { tree: Tree; moved: number } {
  const tree: Tree = {}
  let moved = 0
  for (const [k, v] of Object.entries(enT)) {
    const l = liveT?.[k]
    const d = draftT?.[k]
    if (typeof v === 'string') {
      if (typeof l === 'string') tree[k] = l
      else if (typeof d === 'string') { tree[k] = d; moved++ }
    } else {
      const sub = merge(v, typeof l === 'object' ? l : undefined, typeof d === 'object' ? d : undefined)
      if (Object.keys(sub.tree).length) tree[k] = sub.tree
      moved += sub.moved
    }
  }
  return { tree, moved }
}

const { tree, moved } = merge(en[ns] as Tree, live[ns] as Tree | undefined, draftNs)
live[ns] = tree
delete drafts[ns]
write(`messages/${locale}.json`, live)
write(`messages/drafts/${locale}.json`, drafts)
const logPath = 'messages/drafts/REVIEW_LOG.json'
const log = JSON.parse(readFileSync(join(ROOT, logPath), 'utf8')) as unknown[]
log.push({ locale, namespace: ns, keys: moved, reviewer, at: new Date().toISOString().slice(0, 10) })
write(logPath, log)
console.log(`✓ ${locale}.${ns}: ${moved} key(s) promoted (reviewed by ${reviewer}); run i18n:coverage`)
