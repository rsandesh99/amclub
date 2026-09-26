import { WA_COPY, WA_LOCALES, WA_PAYLOAD_START, WA_PAYLOAD_STOP, waMenuPayload, type WaCopyKey, type WaLocale } from '@amclub/shared'
import type { WaTemplateRegistry, WaTemplateSpec, WaTemplateValues } from './template-types'

/**
 * ADR-030 §2 — system templates the runtime sends on its own (opt-in / opt-out confirmation, the holding reply,
 * language changed, data-request receipt). Merged into WA_TEMPLATES by templates.ts. Owned by the consent / dispatcher
 * work.
 *
 * Inside the 24-hour window the runtime sends the same line as free text (it is a reply to the person's own message);
 * these templates are what goes out when the window has closed. Each body is built from the ONE copy module
 * (`@amclub/shared` whatsapp-copy) with its `{slot}`s numbered `{{1}}`, `{{2}}` … in order, so the copy and the template
 * cannot drift. Changing a line there means re-submitting its template (PRE_LAUNCH_CHECKLIST 1.3), and a change to the
 * opt-in wording also bumps WA_NOTICE_VERSION. te / ta bodies are machine drafts — native review pending before
 * submission (WA_COPY_REVIEW).
 */

/** A copy line as a Meta template body: `{slot}` → `{{n}}` in order of first appearance. */
export function templateBodyFrom(key: WaCopyKey, locale: WaLocale, slots: readonly string[]): string {
  return WA_COPY[locale][key].replace(/\{([a-z_]+)\}/g, (m, name: string) => {
    const i = slots.indexOf(name)
    return i >= 0 ? `{{${i + 1}}}` : m
  })
}

function bodies(key: WaCopyKey, slots: readonly string[]): WaTemplateSpec['body'] {
  const out = {} as Record<WaLocale, string>
  for (const l of WA_LOCALES) out[l] = templateBodyFrom(key, l, slots)
  return out as WaTemplateSpec['body']
}

function labels(key: WaCopyKey): Partial<Record<WaLocale, string>> & { en: string } {
  const out = {} as Record<WaLocale, string>
  for (const l of WA_LOCALES) out[l] = WA_COPY[l][key]
  return out
}

const paramsOf = (slots: readonly string[]) => (v: WaTemplateValues): string[] => slots.map((s) => String(v[s] ?? ''))

function spec(stem: string, key: WaCopyKey, slots: readonly string[], extra: Pick<WaTemplateSpec, 'quickReplies'> = {}): WaTemplateSpec {
  return { stem, category: 'utility', locales: WA_LOCALES, body: bodies(key, slots), params: paramsOf(slots), ...extra }
}

export const SYSTEM_TEMPLATES: WaTemplateRegistry = {
  // START → the confirmation (the notice version on the consent event is WA_NOTICE_VERSION). Quick replies: open the
  // menu, or stop again.
  wa_opt_in_confirmed: spec('amc_wa_opt_in', 'opt_in_confirmed', [], {
    quickReplies: [
      { id: waMenuPayload('open'), label: labels('item_open') },
      { id: WA_PAYLOAD_STOP, label: labels('item_stop') },
    ],
  }),
  // STOP → the ONE message a stopped phone may still get. Its quick reply is an explicit opt-in (a button tap).
  wa_opt_out_confirmed: spec('amc_wa_opt_out', 'opt_out_confirmed', [], {
    quickReplies: [{ id: WA_PAYLOAD_START, label: labels('button_start_again') }],
  }),
  // Anything the runtime cannot answer: "Reply MENU to see what I can do" (≤ 1 per 24 h).
  wa_holding_reply: spec('amc_wa_holding', 'holding', []),
  // LANGUAGE / a language name / the language list → sent in the NEW language. [the language named in itself]
  wa_language_changed: spec('amc_wa_language_changed', 'language_changed', ['language']),
  // MY DATA / DELETE MY DATA → [what was asked, the reference, the due date (IST)]
  wa_data_request_received: spec('amc_wa_data_request', 'data_received', ['what', 'ref', 'date']),
}
