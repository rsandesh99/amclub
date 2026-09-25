import { envelope, type Envelope } from '../untrusted/envelope'
import type { ChatImage, ChatParts } from '../llm/gateway'

/**
 * Prompt parts for `photo_plausibility@v1` — the payout dossier's photo review
 * (S1.4; audit M43 moved them here from the runtime). TRUSTED = platform facts
 * only: the category slug, the order kind and timestamps, and per image its
 * label (the order_documents id), claimed stage and upload time — each value
 * reduced to a fact alphabet, so no free text can ride in. UNTRUSTED = every
 * party-authored string as its own Envelope: the ORDER TITLE (written by the
 * buyer or the provider — it used to sit in a trusted line) and each milestone
 * note. A unit test asserts no party string reaches `trusted`.
 */

export interface PhotoPlausibilityPhoto {
  doc_id: string
  /** The CLAIMED stage (a milestone kind or a goods photo kind). */
  stage: string
  uploaded_at: string
  mime: string
  /** The provider's milestone note for this stage, when any (party text). */
  note: string | null
  /** A data: URL or a signed URL the model may fetch; null = no image part. */
  imageUrl: string | null
}

export interface PhotoPlausibilityPartsInput {
  order: {
    id: string
    kind: string
    category_slug: string | null
    /** Party-authored (buyer RFQ / provider package title) — goes ONLY into an Envelope. */
    title: string
    created_at: string
    completed_at: string | null
  }
  photos: readonly PhotoPlausibilityPhoto[]
}

/** A platform fact (slug, id, enum, ISO timestamp): anything outside the fact alphabet is dropped, never passed through. */
function fact(v: string | null | undefined, max = 80): string {
  const s = String(v ?? '').replace(/[^A-Za-z0-9_:.+-]/g, '').slice(0, max)
  return s || 'unknown'
}

export function buildPhotoPlausibilityParts(input: PhotoPlausibilityPartsInput): ChatParts {
  const o = input.order
  const trusted = [
    `Order category: ${fact(o.category_slug)}`,
    `Order kind: ${fact(o.kind, 20)}; placed ${fact(o.created_at, 40)}; completed ${o.completed_at ? fact(o.completed_at, 40) : 'not yet'}`,
    ...input.photos.map((p) => `Image ${fact(p.doc_id)}: claimed stage = ${fact(p.stage, 40)}; uploaded ${fact(p.uploaded_at, 40)}`),
  ]
  const untrusted: Envelope[] = []
  if (o.title && o.title.trim()) untrusted.push(envelope(o.title, { kind: 'order_title', id: fact(o.id) }))
  for (const p of input.photos) if (p.note && p.note.trim()) untrusted.push(envelope(p.note, { kind: 'milestone_note', id: fact(p.doc_id) }))
  const images: ChatImage[] = input.photos.filter((p) => !!p.imageUrl).map((p) => ({ url: p.imageUrl as string, mime: p.mime, label: fact(p.doc_id) }))
  return { trusted, untrusted, ...(images.length ? { images } : {}) }
}
