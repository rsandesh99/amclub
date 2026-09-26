import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createWhatsAppProvider,
  sendWhatsApp,
  whatsappConfigFromEnv,
  type WaButton,
  type WaLocale,
  type WaSendBody,
  type WaSendResult,
  type WhatsAppProvider,
} from '@amclub/agent-core'
import type { WaConsentPurpose } from '@amclub/shared'
import { admin } from '../deps'

/**
 * The runtime's outbound WhatsApp (ADR-030 §3). Every message the runtime sends — the dispatcher's system replies and
 * every agent's cards, texts and templates — goes through agent-core `sendWhatsApp`: consent + suppression, the
 * window (free-form inside it, the kind's template outside), the ledger row written before the call under an
 * idempotency key, classified Graph errors. Nothing in the runtime calls a driver's send methods directly.
 *
 * Purpose: `assistant` for agent messages, `transactional` for system replies unless the caller says otherwise.
 * Initiation: `reply` when answering the user's own message (only "not STOPped" needed inside the window), `business`
 * when the runtime writes first (the purpose's opt-in needed). Idempotency keys come from run ids and inbound message
 * ids, so a retried job never sends twice.
 */

export interface OutboundConv {
  id: string
  phone_e164: string
  user_id?: string | null
}

export interface RuntimeSendDeps {
  admin: SupabaseClient
  whatsapp: WhatsAppProvider
  now?: () => Date
}

export interface RuntimeSend {
  conv: OutboundConv
  userId?: string | null
  /** Recorded on the row as notification_kind (the template kind, or the runtime message kind). */
  kind: string
  purpose: WaConsentPurpose
  initiation: 'business' | 'reply'
  idempotencyKey: string
  /** Free-form text (inside the window); with `buttons` it is an interactive reply-button / list message. */
  text?: string
  buttons?: WaButton[]
  listLabel?: string
  /** The template: the body when there is no `text`, else the fallback outside the window. */
  template?: { kind: string; locale: WaLocale; values?: Record<string, string | null | undefined> }
  runId?: string | null
  /** Payload merged into the row (a card's run id for the M42 binding, the agent's refs). Never secrets. */
  meta?: Record<string, unknown>
  /** Payload when the fallback template goes instead (absent = `meta`). */
  fallbackMeta?: Record<string, unknown>
}

let _provider: WhatsAppProvider | null = null
/** The runtime's provider (env-configured; every Graph call carries WHATSAPP_TIMEOUT_MS). */
export function runtimeWhatsApp(): WhatsAppProvider {
  if (!_provider) _provider = createWhatsAppProvider(whatsappConfigFromEnv())
  return _provider
}

/** One outbound message through the one send path. */
export async function runtimeSend(deps: RuntimeSendDeps, s: RuntimeSend): Promise<WaSendResult> {
  const tpl = s.template ? ({ type: 'template', kind: s.template.kind, locale: s.template.locale, values: s.template.values ?? {} } as const) : null
  let body: WaSendBody
  if (s.text !== undefined) body = s.buttons?.length ? { type: 'buttons', text: s.text, buttons: s.buttons, ...(s.listLabel ? { listLabel: s.listLabel } : {}) } : { type: 'text', text: s.text }
  else if (tpl) body = tpl
  else throw new Error('runtimeSend: text or template required')
  return sendWhatsApp(
    { db: deps.admin, provider: deps.whatsapp, ...(deps.now ? { now: deps.now } : {}) },
    {
      phoneE164: s.conv.phone_e164,
      conversationId: s.conv.id,
      userId: s.userId ?? s.conv.user_id ?? null,
      purpose: s.purpose,
      initiation: s.initiation,
      kind: s.kind,
      body,
      ...(s.text !== undefined && tpl ? { fallbackTemplate: tpl } : {}),
      idempotencyKey: s.idempotencyKey,
      runId: s.runId ?? null,
      ...(s.meta ? { meta: s.meta } : {}),
      ...(s.fallbackMeta ? { fallbackMeta: s.fallbackMeta } : {}),
    },
  )
}

/**
 * A system message (the dispatcher's opt-in / opt-out confirmation, holding reply, HELP menu …): the registry
 * template `kind` in `locale`, or `text` (+ `buttons`) inside the window with that template as the fallback.
 */
export async function sendSystem(
  conv: OutboundConv,
  kind: string,
  locale: WaLocale,
  opts: {
    idempotencyKey: string
    values?: Record<string, string | null>
    buttons?: WaButton[]
    text?: string
    purpose?: WaConsentPurpose
    initiation?: 'business' | 'reply'
    runId?: string | null
    meta?: Record<string, unknown>
  },
): Promise<WaSendResult> {
  return runtimeSend(
    { admin: admin(), whatsapp: runtimeWhatsApp() },
    {
      conv,
      kind,
      purpose: opts.purpose ?? 'transactional',
      initiation: opts.initiation ?? 'reply',
      idempotencyKey: opts.idempotencyKey,
      ...(opts.text !== undefined ? { text: opts.text } : {}),
      ...(opts.buttons ? { buttons: opts.buttons } : {}),
      template: { kind, locale, values: opts.values ?? {} },
      runId: opts.runId ?? null,
      meta: { system: kind, ...(opts.meta ?? {}) },
    },
  )
}

/** The outbound row id an agent keeps (drafts' `delivered.whatsapp`, counters): a written row, whatever its fate. */
export function sentMessageId(r: WaSendResult): string | null {
  return r.outcome === 'skipped' ? null : r.messageId ?? null
}

/** True when the message went (or had already gone under the same key). */
export function wasDelivered(r: WaSendResult): boolean {
  return r.outcome === 'sent' || r.outcome === 'stub' || r.outcome === 'duplicate'
}
