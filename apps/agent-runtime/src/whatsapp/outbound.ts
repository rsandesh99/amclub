import { createWhatsAppProvider, sendWhatsApp, whatsappConfigFromEnv, type WaButton, type WaLocale, type WaSendBody, type WaSendResult } from '@amclub/agent-core'
import type { WaConsentPurpose } from '@amclub/shared'
import { admin } from '../deps'

/**
 * ADR-030 §3 — the runtime's system send, on the ONE send path (agent-core `sendWhatsApp`). Placeholder with the agreed
 * signature: the transport work owns this file and its merge keeps that version. Body: buttons when `opts.buttons`,
 * free text when `opts.text`, else the registered template `kind` with `opts.values`.
 */
export async function sendSystem(
  conv: { id: string; phone_e164: string; user_id: string | null },
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
  const body: WaSendBody = opts.buttons
    ? { type: 'buttons', text: opts.text ?? '', buttons: opts.buttons }
    : opts.text
      ? { type: 'text', text: opts.text }
      : { type: 'template', kind, locale, values: opts.values ?? {} }
  return sendWhatsApp(
    { db: admin(), provider: createWhatsAppProvider(whatsappConfigFromEnv()) },
    {
      phoneE164: conv.phone_e164,
      userId: conv.user_id,
      conversationId: conv.id,
      purpose: opts.purpose ?? 'transactional',
      initiation: opts.initiation ?? 'reply',
      kind,
      body,
      idempotencyKey: opts.idempotencyKey,
      runId: opts.runId ?? null,
      ...(opts.meta ? { meta: opts.meta } : {}),
    },
  )
}
