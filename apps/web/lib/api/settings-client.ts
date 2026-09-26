import {
  WA_NOTICE_VERSION,
  type NotificationCategory,
  type NotificationSettings,
  type PrivacyRequestCreate,
  type PrivacyRequestView,
  type WaConsentPurpose,
  type WaConsentState,
  type WaConsentUpdate,
} from '@amclub/shared'

/**
 * Browser client for the settings contracts (PRD_WHATSAPP W1):
 *
 *   GET/POST /api/v1/me/whatsapp                 → WaConsentState, or { ready: false } before 0086 (503 not_ready on POST)
 *   GET/PUT  /api/v1/me/notification-preferences → { settings, ready, essentialCategories } (503 not_ready on PUT)
 *   GET/POST /api/v1/me/privacy-requests         → the caller's DPDP requests (503 not_ready on POST)
 *
 * Every call resolves (never throws): a network failure is { ok: false, status: 0 }.
 */

export type Loaded<T> = { kind: 'ready'; data: T } | { kind: 'not_ready' } | { kind: 'error' }
export type Sent<T> = { ok: true; data: T } | { ok: false; status: number; error: string | null }

async function getJson(url: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null }
  } catch {
    return { status: 0, body: null }
  }
}

async function send<T>(url: string, method: 'POST' | 'PUT', body: unknown, keepalive = false): Promise<Sent<T>> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive })
    const data = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null
    if (res.ok) return { ok: true, data: data as T }
    return { ok: false, status: res.status, error: typeof data?.error === 'string' ? data.error : null }
  } catch {
    return { ok: false, status: 0, error: null }
  }
}

// ── WhatsApp consent ─────────────────────────────────────────────────────────

export async function loadWhatsAppConsent(): Promise<Loaded<WaConsentState>> {
  const { status, body } = await getJson('/api/v1/me/whatsapp')
  if (status === 503 || body?.['ready'] === false) return { kind: 'not_ready' }
  if (status !== 200 || !body || typeof body['purposes'] !== 'object') return { kind: 'error' }
  return { kind: 'ready', data: body as unknown as WaConsentState }
}

export function saveWhatsAppConsent(purpose: WaConsentPurpose, optIn: boolean, source: WaConsentUpdate['source'], keepalive = false): Promise<Sent<WaConsentState>> {
  const update: WaConsentUpdate = { purpose, optIn, source, noticeVersion: WA_NOTICE_VERSION }
  return send<WaConsentState>('/api/v1/me/whatsapp', 'POST', update, keepalive)
}

// ── Notification preferences ─────────────────────────────────────────────────

export interface NotificationSettingsPayload {
  settings: NotificationSettings
  essentialCategories: NotificationCategory[]
}

export async function loadNotificationSettings(): Promise<Loaded<NotificationSettingsPayload>> {
  const { status, body } = await getJson('/api/v1/me/notification-preferences')
  if (status === 503 || body?.['ready'] === false) return { kind: 'not_ready' }
  if (status !== 200 || !body || typeof body['settings'] !== 'object' || !body['settings']) return { kind: 'error' }
  const s = body['settings'] as Partial<NotificationSettings>
  return {
    kind: 'ready',
    data: {
      settings: {
        preferences: Array.isArray(s.preferences) ? s.preferences : [],
        quietHours: s.quietHours ?? null,
        pausedUntil: s.pausedUntil ?? null,
        digestLeads: s.digestLeads === true,
      },
      essentialCategories: Array.isArray(body['essentialCategories']) ? (body['essentialCategories'] as NotificationCategory[]) : [],
    },
  }
}

export function saveNotificationSettings(settings: NotificationSettings): Promise<Sent<unknown>> {
  return send('/api/v1/me/notification-preferences', 'PUT', settings)
}

// ── DPDP requests ────────────────────────────────────────────────────────────

export async function loadPrivacyRequests(): Promise<Loaded<PrivacyRequestView[]>> {
  const { status, body } = await getJson('/api/v1/me/privacy-requests')
  if (body?.['ready'] === false) return { kind: 'not_ready' }
  if (status !== 200 || !Array.isArray(body?.['requests'])) return { kind: 'error' }
  return { kind: 'ready', data: body['requests'] as PrivacyRequestView[] }
}

export type PrivacyRequestSent =
  | { ok: true; request: PrivacyRequestView }
  | { ok: false; status: number; error: string | null; /** 409 already_open: when the open one is due. */ dueAt: string | null }

export async function createPrivacyRequest(input: PrivacyRequestCreate): Promise<PrivacyRequestSent> {
  try {
    const res = await fetch('/api/v1/me/privacy-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, source: 'web' }) })
    const d = (await res.json().catch(() => null)) as { request?: PrivacyRequestView; error?: unknown; dueAt?: unknown } | null
    if (res.ok && d?.request) return { ok: true, request: d.request }
    return { ok: false, status: res.status, error: typeof d?.error === 'string' ? d.error : null, dueAt: typeof d?.dueAt === 'string' ? d.dueAt : null }
  } catch {
    return { ok: false, status: 0, error: null, dueAt: null }
  }
}

// ── The WhatsApp box at signup / checkout ────────────────────────────────────
// The person ticks it before the account exists (the users row is written with the profile), so the choice waits in
// this tab's sessionStorage — it survives the refresh that follows sign-in at checkout — and is sent once the profile
// is saved. Fire-and-forget with a short retry; it never blocks sign-up. A notice that changed, a missing phone or a
// server that is not ready yet drops the pending choice (the settings screen and the home card ask again).

const PENDING_KEY = 'amc_wa_optin_pending'
const RETRY_MS = [0, 1500, 5000] as const

interface PendingOptIn { source: 'signup' | 'checkout'; noticeVersion: string; tries: number }

function readPending(): PendingOptIn | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY)
    const p = raw ? (JSON.parse(raw) as PendingOptIn) : null
    return p && (p.source === 'signup' || p.source === 'checkout') ? p : null
  } catch {
    return null
  }
}

/** The box was ticked (or unticked): remember it until the account exists. */
export function rememberWhatsAppOptIn(source: 'signup' | 'checkout', on: boolean): void {
  try {
    if (on) sessionStorage.setItem(PENDING_KEY, JSON.stringify({ source, noticeVersion: WA_NOTICE_VERSION, tries: 0 } satisfies PendingOptIn))
    else sessionStorage.removeItem(PENDING_KEY)
  } catch { /* private mode: the settings screen asks later */ }
}

/** True while a ticked box is waiting to be sent (the checkbox re-reads it after a refresh). */
export function hasPendingWhatsAppOptIn(): boolean {
  return readPending() !== null
}

let inFlight: Promise<void> | null = null

/** Send a remembered opt-in now that the account exists. Safe to call more than once; never throws. */
export function sendPendingWhatsAppOptIn(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    const pending = readPending()
    if (!pending || pending.noticeVersion !== WA_NOTICE_VERSION) { rememberWhatsAppOptIn('signup', false); return }
    for (const wait of RETRY_MS) {
      if (wait) await new Promise((r) => setTimeout(r, wait))
      const res = await saveWhatsAppConsent('transactional', true, pending.source, true)
      // Done, or a definite answer that retrying cannot change (notice changed, no phone, not ready, bad request).
      if (res.ok || [400, 401, 403, 409, 422, 503].includes(res.status)) { rememberWhatsAppOptIn(pending.source, false); return }
    }
    // Still failing (network / 5xx): keep it for the next page that calls this, at most three rounds in all.
    try {
      if (pending.tries >= 2) sessionStorage.removeItem(PENDING_KEY)
      else sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...pending, tries: pending.tries + 1 }))
    } catch { /* ignore */ }
  })().finally(() => { inFlight = null })
  return inFlight
}
