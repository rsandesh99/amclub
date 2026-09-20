import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { orderEvidenceSchema, type OrderEvidence } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
import { requireToolScope } from '@/lib/agent/scope'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { getGoodsDossier } from '@/lib/mart/release'

/**
 * GET /api/v1/admin/orders/[id]/evidence (S1.4 §4a) — the ONE read the
 * Payout-Evidence agent performs, under the founder's delegated ops token.
 * An ORDINARY admin read (requireAdmin; NOT agentApiGate — it is not an agent
 * surface, so it stays 200 for admins while AGENT_ENABLED=false). The scope
 * check is a no-op for human sessions and refuses a delegated token whose
 * grant does not include read_order_evidence. Milestone notes are returned
 * verbatim: the agent envelopes them (untrusted). Signed URLs last 15 min.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const BUCKET = 'order-documents'
const SIGNED_TTL_SEC = 15 * 60

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error
  const scope = await requireToolScope('read_order_evidence')
  if (scope) return scope
  const rl = await enforce(limiters.authed, `admin-evidence:${gate.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const { id } = await params
  const admin = await createAdminClient()
  const { data: ord } = await admin.from('orders').select('*').eq('id', id).maybeSingle()
  if (!ord) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const kind: 'service' | 'goods' = ord.kind === 'goods' ? 'goods' : 'service'

  const [{ data: payments }, { data: payout }, { data: disputes }, { data: events }, { data: providerRow }, { data: bank }, { data: msmeRow }] = await Promise.all([
    admin.from('payments').select('id, status, amount_paise, razorpay_order_id, created_at, updated_at').eq('order_id', id).order('created_at', { ascending: true }),
    admin.from('payouts').select('id, status, amount_paise, scheduled_for').eq('order_id', id).maybeSingle(),
    admin.from('disputes').select('id, status, reason, created_at').eq('order_id', id),
    admin.from('order_events').select('event, actor_id, created_at').eq('order_id', id).order('created_at', { ascending: true }),
    admin.from('provider_profiles').select('id, status, user_id').eq('id', ord.provider_id).maybeSingle(),
    admin.from('provider_bank_accounts').select('penny_drop_verified, razorpay_route_account_id').eq('provider_id', ord.provider_id).maybeSingle(),
    admin.from('msme_profiles').select('user_id').eq('id', ord.msme_id).maybeSingle(),
  ])

  // Accepted terms: the frozen checkout session behind the captured payment.
  const rzpOrderId = (payments ?? []).map((p: any) => p.razorpay_order_id).find((x: any) => !!x) ?? null
  const { data: session } = rzpOrderId
    ? await admin.from('checkout_sessions').select('source, price_paise, total_paise, commission_paise, provider_earning_paise').eq('razorpay_order_id', rzpOrderId).maybeSingle()
    : { data: null }
  const accepted = session
    ? {
        source: session.source === 'quote' || session.source === 'package' ? (session.source as 'quote' | 'package') : null,
        price_paise: num(session.price_paise),
        total_paise: num(session.total_paise),
        commission_paise: num(session.commission_paise),
        provider_earning_paise: num(session.provider_earning_paise),
      }
    : null

  // Category slug: package → category, or quote → rfq → category; goods lines carry their own.
  const category_slug = await categorySlug(admin, ord)

  // Services milestones with their photo (signed).
  const { data: ms } = await admin
    .from('order_milestones')
    .select('kind, note, created_at, photo_doc_id')
    .eq('order_id', id)
    .not('kind', 'is', null)
    .order('sort', { ascending: true })
  const photoIds = (ms ?? []).map((m: any) => m.photo_doc_id).filter((x: any): x is string => !!x)

  // Goods evidence (dispatch/delivery photos) from the goods dossier reader.
  const goods = kind === 'goods' ? await getGoodsDossier(admin, ord) : null
  const goodsDocIds = goods?.evidenceDocIds ?? []

  const allDocIds = [...new Set([...photoIds, ...goodsDocIds])]
  const { data: docs } = allDocIds.length ? await admin.from('order_documents').select('id, file_url, mime, kind, created_at').in('id', allDocIds) : { data: [] }
  const signedDocs = new Map<string, { signed_url: string | null; mime: string; kind: string; uploaded_at: string }>()
  await Promise.all(
    ((docs ?? []) as any[]).map(async (d) => {
      const { data: signed } = await admin.storage.from(BUCKET).createSignedUrl(d.file_url, SIGNED_TTL_SEC)
      signedDocs.set(d.id, { signed_url: signed?.signedUrl ?? null, mime: d.mime, kind: d.kind, uploaded_at: d.created_at })
    }),
  )

  const milestones = (ms ?? []).map((m: any) => {
    const doc = m.photo_doc_id ? signedDocs.get(m.photo_doc_id) : null
    return {
      kind: m.kind,
      note: m.note ?? null,
      created_at: m.created_at,
      photo: m.photo_doc_id && doc ? { doc_id: m.photo_doc_id, signed_url: doc.signed_url, mime: doc.mime, uploaded_at: doc.uploaded_at } : null,
    }
  })

  const providerUserId = providerRow?.user_id ?? null
  const msmeUserId = msmeRow?.user_id ?? null
  const actorIds = [...new Set((events ?? []).map((e: any) => e.actor_id).filter((x: any): x is string => !!x && x !== providerUserId && x !== msmeUserId))]
  const { data: actors } = actorIds.length ? await admin.from('users').select('id, roles').in('id', actorIds) : { data: [] }
  const adminIds = new Set(((actors ?? []) as any[]).filter((u) => (u.roles ?? []).includes('admin') || (u.roles ?? []).includes('ops')).map((u) => u.id))
  const roleOf = (actorId: string | null): OrderEvidence['events'][number]['actor_role'] => {
    if (!actorId) return 'system'
    if (actorId === msmeUserId) return 'msme'
    if (actorId === providerUserId) return 'provider'
    if (adminIds.has(actorId)) return 'admin'
    return 'unknown'
  }

  const payload: OrderEvidence = {
    order: {
      id: ord.id,
      kind,
      status: ord.status,
      order_number: ord.order_number,
      category_slug,
      title: ord.title,
      created_at: ord.created_at,
      completed_at: ord.completed_at ?? null,
      total_paise: num(ord.total_paise) ?? 0,
      provider_earning_paise: num(ord.provider_earning_paise) ?? 0,
      provider_id: ord.provider_id,
      msme_id: ord.msme_id,
    },
    accepted,
    payments: (payments ?? []).map((p: any) => ({
      id: p.id,
      status: p.status,
      amount_paise: num(p.amount_paise) ?? 0,
      captured_at: p.status === 'captured' ? (p.updated_at ?? p.created_at ?? null) : null,
    })),
    payout: payout ? { id: payout.id, status: payout.status, amount_paise: num(payout.amount_paise) ?? 0, scheduled_for: payout.scheduled_for ?? null } : null,
    provider: {
      id: ord.provider_id,
      status: providerRow?.status ?? 'unknown',
      bank_verified: !!bank?.penny_drop_verified,
      route_account_present: !!bank?.razorpay_route_account_id,
    },
    disputes: (disputes ?? []).map((d: any) => ({ id: d.id, status: d.status, reason: d.reason, opened_at: d.created_at })),
    milestones,
    goods_evidence: goods
      ? {
          dispatched_at: goods.dispatchedAt,
          delivered_photo_at: goods.deliveredPhotoAt,
          buyer_received_at: goods.buyerReceivedAt,
          auto_accepted_at: goods.autoAcceptedAt,
          return_opened_at: goods.returnOpenedAt,
          return_resolved_at: goods.returnResolvedAt,
          return_window_hours: goods.returnWindowHours,
          gate: { ok: goods.gate.ok, reasons: [...goods.gate.reasons] },
          photos: goodsDocIds
            .map((docId) => {
              const d = signedDocs.get(docId)
              return d ? { doc_id: docId, kind: d.kind, signed_url: d.signed_url, mime: d.mime, uploaded_at: d.uploaded_at } : null
            })
            .filter((x): x is NonNullable<typeof x> => !!x),
        }
      : null,
    events: (events ?? []).map((e: any) => ({ event: e.event, created_at: e.created_at, actor_role: roleOf(e.actor_id ?? null) })),
  }

  // Producer-side contract check: a shape drift fails loudly here, not in the agent.
  const parsed = orderEvidenceSchema.safeParse(payload)
  if (!parsed.success) {
    console.error('[admin/orders/evidence] contract drift', parsed.error.flatten())
    return NextResponse.json({ error: 'evidence_contract_error' }, { status: 500 })
  }
  return NextResponse.json(parsed.data, { headers: NO_STORE })
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

async function categorySlug(admin: Awaited<ReturnType<typeof createAdminClient>>, ord: any): Promise<string | null> {
  if (ord.kind === 'goods') {
    const line = Array.isArray(ord.line_items) ? ord.line_items.find((l: any) => l?.category_slug) : null
    return line?.category_slug ?? null
  }
  let categoryId: string | null = null
  if (ord.package_id) {
    const { data } = await admin.from('packages').select('category_id').eq('id', ord.package_id).maybeSingle()
    categoryId = data?.category_id ?? null
  } else if (ord.quote_id) {
    const { data: q } = await admin.from('quotes').select('rfq_id').eq('id', ord.quote_id).maybeSingle()
    if (q?.rfq_id) {
      const { data: r } = await admin.from('rfqs').select('category_id').eq('id', q.rfq_id).maybeSingle()
      categoryId = r?.category_id ?? null
    }
  }
  if (!categoryId) return null
  const { data: c } = await admin.from('categories').select('slug').eq('id', categoryId).maybeSingle()
  return c?.slug ?? null
}
/* eslint-enable @typescript-eslint/no-explicit-any */
