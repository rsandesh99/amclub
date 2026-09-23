import 'server-only'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { isValidGstin } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

const BUCKET = 'invoices'
// StandardFonts can't encode ₹ — use "INR " in PDFs.
const inr = (paise: number) => 'INR ' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })

interface Line {
  label: string
  value: string
}

async function buildPdf(title: string, header: Record<string, string>, lines: Line[], totalLabel: string, totalValue: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595, 842])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const green = rgb(0.106, 0.302, 0.243)
  let y = 800

  page.drawText('AMClub', { x: 50, y, size: 22, font: bold, color: green })
  page.drawText(title, { x: 50, y: y - 26, size: 13, font: bold })
  y -= 70

  for (const [k, v] of Object.entries(header)) {
    page.drawText(`${k}:`, { x: 50, y, size: 10, font: bold })
    page.drawText(v, { x: 180, y, size: 10, font })
    y -= 18
  }
  y -= 12
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 1, color: rgb(0.8, 0.8, 0.8) })
  y -= 24

  for (const line of lines) {
    page.drawText(line.label, { x: 50, y, size: 11, font })
    page.drawText(line.value, { x: 400, y, size: 11, font })
    y -= 22
  }
  y -= 6
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 1, color: rgb(0.8, 0.8, 0.8) })
  y -= 26
  page.drawText(totalLabel, { x: 50, y, size: 13, font: bold })
  page.drawText(totalValue, { x: 400, y, size: 13, font: bold, color: green })

  page.drawText('Provisional GST structure (SAC 9985/9997) — pending CA sign-off. TEST MODE.', {
    x: 50, y: 40, size: 8, font, color: rgb(0.5, 0.5, 0.5),
  })
  return pdf.save()
}

/**
 * Generate the buyer invoice + platform commission invoice for a completed
 * order, store both in private Storage, and record `invoices` rows. Idempotent:
 * skips a kind whose invoice already exists.
 */
export async function generateInvoices(admin: Admin, orderId: string): Promise<{ buyer?: string; commission?: string }> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const { data: order } = await admin.from('orders').select('*').eq('id', orderId).maybeSingle()
  if (!order) return {}
  const { data: provider } = await admin.from('provider_profiles').select('display_name, gstin, state').eq('id', order.provider_id).maybeSingle()
  const { data: msme } = await admin.from('msme_profiles').select('business_name, gstin, state').eq('id', order.msme_id).maybeSingle()
  // The GSTIN the buyer typed at checkout is frozen on the checkout session
  // (checkout_sessions.gst_invoice, linked by order_id when materialised) and
  // wins over the profile GSTIN; the profile is the fallback. Re-validated
  // here so a malformed legacy value never lands on a tax invoice.
  const { data: session } = await admin.from('checkout_sessions').select('gst_invoice').eq('order_id', orderId).limit(1).maybeSingle()
  const typed = (session?.gst_invoice ?? null) as { gstin?: string; businessName?: string } | null
  const typedGstin = typed?.gstin?.trim().toUpperCase()
  const buyerGstin: string | null = typedGstin && isValidGstin(typedGstin) ? typedGstin : (msme?.gstin ?? null)
  const buyerName: string = (typedGstin && isValidGstin(typedGstin) && typed?.businessName?.trim()) || msme?.business_name || 'Buyer'
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const { data: existing } = await admin.from('invoices').select('kind').eq('order_id', orderId)
  const have = new Set((existing ?? []).map((i) => i.kind))
  const out: { buyer?: string; commission?: string } = {}

  // Buyer invoice — service from provider to buyer.
  // AMC Mart (kind='goods'): generated in AMC's name (merchant-of-record
  // interim, MART_DESIGN.md §2) with one HSN line per item; seller invoices
  // are recorded INBOUND against the order at dispatch, never generated here.
  if (!have.has('buyer_invoice')) {
    const number = `INV-${order.order_number}-B`
    const goods = order.kind === 'goods'
    const goodsLines: Line[] = goods
      ? ((order.line_items ?? []) as { name: string; qty: number; unit: string; hsn_code: string; gst_rate_bps: number; line_taxable_paise: number; line_gst_paise: number }[]).flatMap((l) => [
          { label: `${l.qty} ${l.unit} ${l.name} (HSN ${l.hsn_code})`, value: inr(l.line_taxable_paise) },
          { label: `  GST ${l.gst_rate_bps / 100}%`, value: inr(l.line_gst_paise) },
        ])
      : []
    const bytes = await buildPdf(
      goods ? 'Tax Invoice (Buyer) — Goods' : 'Tax Invoice (Buyer)',
      {
        'Invoice No': number,
        'Order': order.order_number,
        'From': goods ? 'AMClub (Swathisri Infra Projects Pvt Ltd)' : (provider?.display_name ?? 'Provider'),
        'To': buyerName,
        'Buyer GSTIN': buyerGstin ?? '—',
        ...(goods ? { 'Supplied by': provider?.display_name ?? 'Seller' } : {}),
      },
      goods
        ? [...goodsLines, { label: 'Taxable value', value: inr(order.price_paise) }, { label: 'Total GST', value: inr(order.gst_paise) }]
        : [
            { label: order.title, value: inr(order.price_paise) },
            { label: 'Discount', value: '- ' + inr(order.discount_paise) },
            { label: 'Taxable value', value: inr(order.price_paise - order.discount_paise) },
            { label: 'GST (18%)', value: inr(order.gst_paise) },
          ],
      'Total payable',
      inr(order.total_paise),
    )
    const path = `${orderId}/buyer-${number}.pdf`
    await admin.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf', upsert: true })
    await admin.from('invoices').insert({
      order_id: orderId, number, kind: 'buyer_invoice', pdf_url: path,
      gstin_snapshot: { buyer: buyerGstin, provider: provider?.gstin ?? null, buyer_source: buyerGstin && buyerGstin === typedGstin ? 'checkout' : 'profile' },
      totals: { total_paise: order.total_paise, gst_paise: order.gst_paise },
    })
    out.buyer = path
  }

  // Commission invoice — platform's commission to provider.
  if (!have.has('commission_invoice')) {
    const number = `INV-${order.order_number}-C`
    const commissionGst = Math.round((order.commission_paise * 1800) / 10000)
    const bytes = await buildPdf(
      'Tax Invoice (Platform Commission)',
      {
        'Invoice No': number,
        'Order': order.order_number,
        'From': 'AMClub (Platform)',
        'To': provider?.display_name ?? 'Provider',
        'Provider GSTIN': provider?.gstin ?? '—',
      },
      [
        { label: `Commission (${order.commission_bps / 100}%)`, value: inr(order.commission_paise) },
        { label: 'GST on commission (18%)', value: inr(commissionGst) },
      ],
      'Total commission',
      inr(order.commission_paise + commissionGst),
    )
    const path = `${orderId}/commission-${number}.pdf`
    await admin.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf', upsert: true })
    await admin.from('invoices').insert({
      order_id: orderId, number, kind: 'commission_invoice', pdf_url: path,
      gstin_snapshot: { provider: provider?.gstin ?? null },
      totals: { commission_paise: order.commission_paise, commission_gst_paise: commissionGst },
    })
    out.commission = path
  }

  return out
}
