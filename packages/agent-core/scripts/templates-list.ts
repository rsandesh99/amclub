/**
 * The WhatsApp template approval list (ADR-030 §3, PRE_LAUNCH_CHECKLIST 1.3), generated from the registry
 * (packages/agent-core/src/whatsapp/templates*.ts) so what is submitted to Meta is provably what the code sends.
 * One row per (name, language): category, the body exactly as submitted, a sample filled with the registry's example
 * values, and the URL button (label, the fixed https://amclub.in/{{1}} pattern and a sample suffix).
 *
 * Run: pnpm --filter @amclub/agent-core templates:list [--summary]   (markdown on stdout)
 * Regenerate docs/PRE_LAUNCH_CHECKLIST.md 1.3 from this output whenever a template changes.
 */
import { allTemplateNames, templateApprovalList } from '../src/whatsapp/templates'

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, '<br>')

function main(): void {
  const rows = templateApprovalList()
  const kinds = [...new Set(rows.map((r) => r.kind))]
  const out: string[] = []
  out.push(`${allTemplateNames().length} templates (${kinds.length} kinds × their submitted languages), all category \`${[...new Set(rows.map((r) => r.category))].join('`, `')}\`. Telugu and Tamil bodies are machine drafts: **native review pending** before submission.`)
  out.push('')
  if (process.argv.includes('--summary')) {
    out.push('| kind | names | button |')
    out.push('|---|---|---|')
    for (const k of kinds) {
      const rs = rows.filter((r) => r.kind === k)
      const b = rs[0]!.button
      out.push(`| ${k} | ${rs.map((r) => `\`${r.name}\``).join(', ')} | ${b ? `URL \`${b.url}\`` : '—'} |`)
    }
  } else {
    out.push('| name | language | category | body (as submitted) | button |')
    out.push('|---|---|---|---|---|')
    for (const r of rows) {
      const button = r.button ? `${cell(r.button.label)} → \`${r.button.url}\` (sample \`${r.button.example}\`)` : r.quickReplies.length ? `quick replies: ${r.quickReplies.map(cell).join(' / ')}` : '—'
      out.push(`| \`${r.name}\` | ${r.language} | ${r.category} | ${cell(r.body)} | ${button} |`)
    }
  }
  process.stdout.write(out.join('\n') + '\n')
}

main()
