/**
 * Documents Agent v1 (MART_DESIGN.md §5) — "the paperwork does itself".
 * From the order record alone it drafts (a) the AMC buyer tax-invoice
 * summary, (b) the e-way bill Part A data, (c) the seller payout advice.
 * Deterministic assembly — every value is copied from the order, the
 * profiles and the config; nothing is invented and no model is required.
 * The admin confirms or corrects in the dossier; confirmation writes
 * ai_decisions('documents_draft') with proposed vs final. Never files
 * anything externally (the e-way bill generator integration is M3).
 */
import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'
import { getEwayBillThresholdPaise, getTdsConfig } from './config'

type Admin = Awaited<ReturnType<typeof createAdminClient>>
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DocumentsDraft {
  order_id: string
  order_number: string
  invoice: {
    supplier: { name: string; gstin: string | null; state: string | null }
    buyer: { name: string; gstin: string | null; state: string | null; address: string | null }
    place_of_supply: string | null
    /** IGST when supplier and buyer states differ, else CGST+SGST split. */
    tax_type: 'IGST' | 'CGST_SGST' | 'unknown'
    lines: { description: string; hsn: string; qty: number; unit: string; rate_paise: number; taxable_paise: number; gst_rate_bps: number; gst_paise: number }[]
    taxable_paise: number
    gst_paise: number
    total_paise: number
    existing_invoice_numbers: string[]
  }
  eway_bill: {
    required: boolean
    threshold_paise: number
    consignment_value_paise: number
    supply_type: 'Outward'
    sub_type: 'Supply'
    document_type: 'Tax Invoice'
    from: { gstin: string | null; name: string; state: string | null; pincode: string | null }
    to: { gstin: string | null; name: string; state: string | null; pincode: string | null; address: string | null }
    items: { hsn: string; description: string; qty: number; unit: string; taxable_paise: number; gst_rate_bps: number }[]
    transport: { transporter_name: string | null; vehicle_number: string | null; eway_bill_number: string | null }
    missing: string[]
  }
  payout_advice: {
    seller: string
    gross_paise: number
    commission_paise: number
    commission_bps: number
    tds: { section: string; rate_bps: number; applies: boolean; amount_paise: number }
    net_paise: number
    release_conditions: string[]
    text: string
  }
  warnings: string[]
}

function inr(p: number): string {
  return `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export async function draftDocuments(admin: Admin, orderId: string): Promise<DocumentsDraft | null> {
  const { data: order } = await admin.from('orders').select('*').eq('id', orderId).maybeSingle()
  if (!order || order.kind !== 'goods') return null
  const [{ data: msme }, { data: seller }, { data: invoices }, { data: dispatch }, threshold, tds] = await Promise.all([
    admin.from('msme_profiles').select('business_name, gstin, state, city, pincode').eq('id', order.msme_id).maybeSingle(),
    admin.from('provider_profiles').select('legal_name, display_name, gstin, state, city').eq('id', order.provider_id).maybeSingle(),
    admin.from('invoices').select('number, kind').eq('order_id', orderId),
    admin.from('order_events').select('payload').eq('order_id', orderId).eq('event', 'dispatched').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    getEwayBillThresholdPaise(admin),
    getTdsConfig(admin),
  ])
  const lines = ((order.line_items ?? []) as any[]).map((li) => ({
    description: li.name,
    hsn: li.hsn_code,
    qty: Number(li.qty),
    unit: li.unit,
    rate_paise: Number(li.tier_unit_price_paise),
    taxable_paise: Number(li.line_taxable_paise),
    gst_rate_bps: Number(li.gst_rate_bps),
    gst_paise: Number(li.line_gst_paise),
  }))
  const deliv = (order.delivery_snapshot ?? {}) as any
  const gstInv = (order.gst_invoice ?? {}) as any
  const buyerGstin = gstInv.gstin ?? msme?.gstin ?? null
  const buyerState = deliv.state ?? msme?.state ?? null
  const sellerState = seller?.state ?? null
  const taxType = sellerState && buyerState ? (sellerState === buyerState ? 'CGST_SGST' : 'IGST') : 'unknown'
  const warnings: string[] = []
  if (!seller?.gstin) warnings.push('seller_gstin_missing')
  if (!buyerGstin) warnings.push('buyer_gstin_missing_b2c_invoice')
  if (taxType === 'unknown') warnings.push('place_of_supply_unknown')
  const consignment = Number(order.total_paise)
  const dp = (dispatch?.payload ?? {}) as any
  const ewayRequired = consignment >= threshold
  const missing: string[] = []
  if (ewayRequired) {
    if (!dp.transporter_name && !dp.vehicle_number) missing.push('transport_details')
    if (!seller?.gstin) missing.push('supplier_gstin')
    if (!deliv.pincode) missing.push('destination_pincode')
  }
  const gross = Number(order.price_paise)
  const commission = Number(order.commission_paise)
  const tdsApplies = tds.rate_bps > 0 && gross >= tds.threshold_paise
  const tdsAmount = tdsApplies ? Math.round((gross * tds.rate_bps) / 10000) : 0
  const net = Number(order.provider_earning_paise) - tdsAmount
  const sellerName = seller?.legal_name ?? seller?.display_name ?? ''
  const conditions = ['delivery_photo_present', 'buyer_receipt_or_72h', 'return_window_closed', 'no_open_return']
  return {
    order_id: orderId,
    order_number: order.order_number,
    invoice: {
      supplier: { name: sellerName, gstin: seller?.gstin ?? null, state: sellerState },
      buyer: { name: gstInv.businessName ?? msme?.business_name ?? deliv.contact_name ?? '', gstin: buyerGstin, state: buyerState, address: gstInv.address ?? deliv.address ?? null },
      place_of_supply: buyerState,
      tax_type: taxType,
      lines,
      taxable_paise: Number(order.price_paise),
      gst_paise: Number(order.gst_paise),
      total_paise: consignment,
      existing_invoice_numbers: (invoices ?? []).map((i: any) => `${i.kind}:${i.number}`),
    },
    eway_bill: {
      required: ewayRequired,
      threshold_paise: threshold,
      consignment_value_paise: consignment,
      supply_type: 'Outward',
      sub_type: 'Supply',
      document_type: 'Tax Invoice',
      from: { gstin: seller?.gstin ?? null, name: sellerName, state: sellerState, pincode: null },
      to: { gstin: buyerGstin, name: msme?.business_name ?? deliv.contact_name ?? '', state: buyerState, pincode: deliv.pincode ?? msme?.pincode ?? null, address: deliv.address ?? null },
      items: lines.map((l) => ({ hsn: l.hsn, description: l.description, qty: l.qty, unit: l.unit, taxable_paise: l.taxable_paise, gst_rate_bps: l.gst_rate_bps })),
      transport: { transporter_name: dp.transporter_name ?? null, vehicle_number: dp.vehicle_number ?? null, eway_bill_number: dp.eway_bill_number ?? null },
      missing,
    },
    payout_advice: {
      seller: sellerName,
      gross_paise: gross,
      commission_paise: commission,
      commission_bps: Number(order.commission_bps),
      tds: { section: tds.section, rate_bps: tds.rate_bps, applies: tdsApplies, amount_paise: tdsAmount },
      net_paise: net,
      release_conditions: conditions,
      text:
        `Payout advice — order ${order.order_number}. Taxable ${inr(gross)}; AMC commission ${inr(commission)} (${Number(order.commission_bps) / 100}%); ` +
        (tdsApplies ? `TDS u/s ${tds.section} ${inr(tdsAmount)}; ` : `TDS not applicable (${tds.section}, threshold ${inr(tds.threshold_paise)}); `) +
        `net to ${sellerName}: ${inr(net)}. Release only when the goods gate passes (${conditions.join(', ')}).`,
    },
    warnings,
  }
}
