/**
 * Experience v3 FR-4.3 — "no client money math" (lint rule amclub/no-client-money-math).
 * Money is computed on the server (computeOrderAmounts / computeGoodsOrderAmounts);
 * client components render the paise the server sends. This scan finds + − × ÷
 * with an operand whose name ends in `Paise` / `_paise` inside 'use client'
 * files. Existing hits are baselined (client-money-baseline.json, matched by
 * file + expression text, not line numbers); any NEW hit fails `pnpm lint`.
 * Epics remove baseline entries as they move a calculation to the server.
 *
 * Run: pnpm --filter @amclub/web exec tsx scripts/lint/client-money.ts [--update]
 */
import ts from 'typescript'
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const BASELINE = path.join(__dirname, 'client-money-baseline.json')
const OPS = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx|ts)$/.test(name)) out.push(p)
  }
  return out
}

const isPaise = (n: ts.Node): boolean => {
  if (ts.isIdentifier(n)) return /(Paise|_paise)$/.test(n.text)
  if (ts.isPropertyAccessExpression(n)) return /(Paise|_paise)$/.test(n.name.text)
  if (ts.isParenthesizedExpression(n)) return isPaise(n.expression)
  return false
}

export function scan(): { file: string; expr: string; line: number }[] {
  const hits: { file: string; expr: string; line: number }[] = []
  for (const abs of [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'components'))]) {
    const text = readFileSync(abs, 'utf8')
    if (!/^['"]use client['"]/m.test(text.slice(0, 200))) continue
    const src = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = (n: ts.Node) => {
      if (ts.isBinaryExpression(n) && OPS.has(n.operatorToken.kind) && (isPaise(n.left) || isPaise(n.right))) {
        hits.push({ file: path.relative(ROOT, abs), expr: n.getText().replace(/\s+/g, ' '), line: src.getLineAndCharacterOfPosition(n.getStart()).line + 1 })
      }
      ts.forEachChild(n, visit)
    }
    visit(src)
  }
  return hits
}

if (require.main === module) {
  const hits = scan()
  const key = (h: { file: string; expr: string }) => `${h.file} :: ${h.expr}`
  if (process.argv.includes('--update')) {
    writeFileSync(BASELINE, JSON.stringify([...new Set(hits.map(key))].sort(), null, 2) + '\n')
    console.log(`baseline updated: ${hits.length} entries`)
    process.exit(0)
  }
  const baseline = new Set<string>(JSON.parse(readFileSync(BASELINE, 'utf8')) as string[])
  const fresh = hits.filter((h) => !baseline.has(key(h)))
  if (fresh.length) {
    console.error('✗ amclub/no-client-money-math — money arithmetic in a client component (compute it on the server; PRD FR-4.3):')
    for (const h of fresh) console.error(`  ${h.file}:${h.line}  ${h.expr}`)
    process.exit(1)
  }
  console.log(`✔ no new client money math (${hits.length} baselined)`)
}
