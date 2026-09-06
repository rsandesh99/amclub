'use client'

/**
 * Offline evidence queue (FRONTEND.md §5 — "never lose a capture").
 * Captured files are written to IndexedDB FIRST, then uploaded; on failure
 * (weak signal, tab killed) they stay queued and retry on `online`, on the
 * next page load, or on a manual tap. Visible state comes from `subscribe`.
 * No dependency: a 60-line IndexedDB wrapper is smaller than any library.
 */
export interface QueuedUpload {
  id: string
  /** Where the multipart POST goes (e.g. /api/v1/orders/<id>/documents). */
  endpoint: string
  /** Extra form fields sent alongside `file` (e.g. { kind: 'delivery_photo' }). */
  fields: Record<string, string>
  fileName: string
  mime: string
  blob: Blob
  createdAt: number
  attempts: number
  lastError?: string
}

const DB = 'amc-upload-queue'
const STORE = 'uploads'
type Listener = (items: QueuedUpload[]) => void
const listeners = new Set<Listener>()
let flushing = false

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const r = fn(db.transaction(STORE, mode).objectStore(STORE))
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

export async function listQueued(): Promise<QueuedUpload[]> {
  if (typeof indexedDB === 'undefined') return []
  try { return (await tx<QueuedUpload[]>('readonly', (s) => s.getAll())).sort((a, b) => a.createdAt - b.createdAt) } catch { return [] }
}
async function notify() { const items = await listQueued(); listeners.forEach((l) => l(items)) }
export function subscribe(l: Listener): () => void {
  listeners.add(l)
  void notify()
  return () => listeners.delete(l)
}

/** Persist first, then try once. Resolves with the server response id when it uploaded now, null when queued. */
export async function enqueueUpload(input: { endpoint: string; fields: Record<string, string>; file: File }): Promise<{ id: string | null; queuedId: string }> {
  const item: QueuedUpload = {
    id: crypto.randomUUID(), endpoint: input.endpoint, fields: input.fields, fileName: input.file.name, mime: input.file.type,
    blob: input.file, createdAt: Date.now(), attempts: 0,
  }
  try { await tx('readwrite', (s) => s.put(item)) } catch { /* private mode: proceed without persistence */ }
  await notify()
  const id = await attempt(item)
  return { id, queuedId: item.id }
}

async function attempt(item: QueuedUpload): Promise<string | null> {
  const fd = new FormData()
  for (const [k, v] of Object.entries(item.fields)) fd.append(k, v)
  fd.append('file', new File([item.blob], item.fileName, { type: item.mime }))
  try {
    const res = await fetch(item.endpoint, { method: 'POST', body: fd })
    if (res.ok) {
      const d = (await res.json().catch(() => ({}))) as { id?: string }
      try { await tx('readwrite', (s) => s.delete(item.id)) } catch { /* ignore */ }
      await notify()
      return d.id ?? null
    }
    // 4xx = the server rejected the file itself; keep the row so the user sees why, but stop retrying.
    const d = (await res.json().catch(() => ({}))) as { error?: unknown }
    item.attempts += 1
    item.lastError = typeof d.error === 'string' ? d.error : `HTTP ${res.status}`
    if (res.status >= 400 && res.status < 500) item.attempts = 99
  } catch (e) {
    item.attempts += 1
    item.lastError = e instanceof Error ? e.message : 'network'
  }
  try { await tx('readwrite', (s) => s.put(item)) } catch { /* ignore */ }
  await notify()
  return null
}

/** Retry everything retryable. Called on `online`, on mount, and from the retry chip. */
export async function flushQueue(onUploaded?: (item: QueuedUpload, id: string | null) => void): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    for (const item of await listQueued()) {
      if (item.attempts >= 99) continue
      const id = await attempt(item)
      if (id !== null) onUploaded?.(item, id)
    }
  } finally { flushing = false }
}

export async function discardQueued(id: string): Promise<void> {
  try { await tx('readwrite', (s) => s.delete(id)) } catch { /* ignore */ }
  await notify()
}
