import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'
import type { MilestoneKind } from '@amclub/shared'
import { createNotification } from './create'

type Admin = Awaited<ReturnType<typeof createAdminClient>>
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Resolve both parties' user ids for an order (for notification targeting). */
async function parties(admin: Admin, order: any): Promise<{ msmeUserId: string | null; providerUserId: string | null }> {
  const [{ data: m }, { data: p }] = await Promise.all([
    admin.from('msme_profiles').select('user_id').eq('id', order.msme_id).maybeSingle(),
    admin.from('provider_profiles').select('user_id').eq('id', order.provider_id).maybeSingle(),
  ])
  return { msmeUserId: m?.user_id ?? null, providerUserId: p?.user_id ?? null }
}

const ref = (o: any): string => o.order_number ?? o.title ?? 'your order'

/**
 * Order placed (payment captured → order materialised). Notifies the provider
 * ("new order, please accept") and confirms to the buyer. Best-effort.
 */
export async function notifyOrderPlaced(admin: Admin, orderId: string): Promise<void> {
  const { data: order } = await admin.from('orders').select('*').eq('id', orderId).maybeSingle()
  if (!order) return
  const { msmeUserId, providerUserId } = await parties(admin, order)
  const r = ref(order)
  if (providerUserId) {
    await createNotification(admin, {
      userId: providerUserId,
      kind: 'order_placed',
      titleI18n: { en: 'New order received', hi: 'नया ऑर्डर मिला' },
      bodyI18n: { en: `Order ${r} is awaiting your acceptance.`, hi: `ऑर्डर ${r} आपकी स्वीकृति की प्रतीक्षा में है।` },
      link: `/partner/orders/${orderId}`,
      channels: ['email', 'sms', 'whatsapp'],
    })
  }
  if (msmeUserId) {
    await createNotification(admin, {
      userId: msmeUserId,
      kind: 'order_placed',
      titleI18n: { en: 'Payment received — order placed', hi: 'भुगतान प्राप्त — ऑर्डर दर्ज' },
      bodyI18n: { en: `Your order ${r} is placed.`, hi: `आपका ऑर्डर ${r} दर्ज हो गया है।` },
      link: `/app/orders/${orderId}`,
      channels: ['email'],
    })
  }
}

interface EventCopy {
  to: 'msme' | 'provider'
  kind: string
  en: { title: string; body: string }
  hi: { title: string; body: string }
  channels: string[]
}

/** Per-action notification copy + recipient. One place; mirrors §3.7 actions. */
function copyFor(action: string, r: string): EventCopy | null {
  switch (action) {
    case 'accept':
      return { to: 'msme', kind: 'order_accepted', channels: ['email', 'sms'],
        en: { title: 'Provider accepted your order', body: `Submit your requirements to start ${r}.` },
        hi: { title: 'प्रदाता ने आपका ऑर्डर स्वीकार किया', body: `${r} शुरू करने के लिए अपनी आवश्यकताएँ जमा करें।` } }
    case 'submit_requirements':
      return { to: 'provider', kind: 'requirements_submitted', channels: ['email'],
        en: { title: 'Requirements submitted', body: `The buyer submitted requirements for ${r}.` },
        hi: { title: 'आवश्यकताएँ जमा की गईं', body: `खरीदार ने ${r} के लिए आवश्यकताएँ जमा कीं।` } }
    case 'start':
      return { to: 'msme', kind: 'order_in_progress', channels: ['email'],
        en: { title: 'Work has started', body: `Your provider started work on ${r}.` },
        hi: { title: 'काम शुरू हो गया', body: `आपके प्रदाता ने ${r} पर काम शुरू कर दिया।` } }
    case 'deliver':
      return { to: 'msme', kind: 'order_delivered', channels: ['email', 'sms'],
        en: { title: 'Delivery ready for review', body: `Review and accept the delivery for ${r}.` },
        hi: { title: 'डिलीवरी समीक्षा के लिए तैयार', body: `${r} की डिलीवरी की समीक्षा करें और स्वीकार करें।` } }
    case 'accept_delivery':
      return { to: 'provider', kind: 'order_completed', channels: ['email', 'sms'],
        en: { title: 'Order completed', body: `${r} is complete — your payout is scheduled.` },
        hi: { title: 'ऑर्डर पूर्ण', body: `${r} पूर्ण हुआ — आपका भुगतान निर्धारित है।` } }
    case 'request_revision':
      return { to: 'provider', kind: 'revision_requested', channels: ['email'],
        en: { title: 'Revision requested', body: `The buyer requested a revision on ${r}.` },
        hi: { title: 'संशोधन का अनुरोध', body: `खरीदार ने ${r} पर संशोधन का अनुरोध किया।` } }
    case 'resume':
      return { to: 'msme', kind: 'order_in_progress', channels: ['email'],
        en: { title: 'Revision in progress', body: `Your provider is working on the revision for ${r}.` },
        hi: { title: 'संशोधन जारी', body: `आपका प्रदाता ${r} के संशोधन पर काम कर रहा है।` } }
    case 'cancel':
      return { to: 'provider', kind: 'order_cancelled', channels: ['email'],
        en: { title: 'Order cancelled by buyer', body: `${r} was cancelled by the buyer.` },
        hi: { title: 'खरीदार ने ऑर्डर रद्द किया', body: `${r} खरीदार द्वारा रद्द कर दिया गया।` } }
    default:
      return null
  }
}

/**
 * Notify the counterparty after a buyer/provider-driven order transition.
 * `accept_delivery` also fires the review prompt to the buyer (separately).
 */
export async function notifyOrderTransition(admin: Admin, order: any, action: string): Promise<void> {
  const c = copyFor(action, ref(order))
  if (!c) {
    if (action === 'raise_dispute') await notifyDispute(admin, order)
    return
  }
  const { msmeUserId, providerUserId } = await parties(admin, order)
  const userId = c.to === 'msme' ? msmeUserId : providerUserId
  if (userId) {
    await createNotification(admin, {
      userId,
      kind: c.kind,
      titleI18n: { en: c.en.title, hi: c.hi.title },
      bodyI18n: { en: c.en.body, hi: c.hi.body },
      link: c.to === 'msme' ? `/app/orders/${order.id}` : `/partner/orders/${order.id}`,
      channels: c.channels,
    })
  }
  if (action === 'accept_delivery') await notifyReviewPrompt(admin, order)
}

async function notifyDispute(admin: Admin, order: any): Promise<void> {
  const { msmeUserId, providerUserId } = await parties(admin, order)
  const both = [msmeUserId, providerUserId].filter(Boolean) as string[]
  for (const userId of both) {
    await createNotification(admin, {
      userId,
      kind: 'order_disputed',
      titleI18n: { en: 'A dispute was opened', hi: 'एक विवाद खोला गया' },
      bodyI18n: { en: `A dispute was opened on ${ref(order)}. Our team will review it.`, hi: `${ref(order)} पर विवाद खोला गया। हमारी टीम इसकी समीक्षा करेगी।` },
      link: userId === msmeUserId ? `/app/orders/${order.id}` : `/partner/orders/${order.id}`,
      channels: ['email'],
    })
  }
}

const MILESTONE_LABELS: Record<MilestoneKind, { en: string; hi: string }> = {
  accepted: { en: 'Provider accepted', hi: 'प्रदाता ने स्वीकार किया' },
  site_or_materials: { en: 'Reached site / materials ready', hi: 'साइट पर पहुँचे / सामग्री तैयार' },
  in_progress: { en: 'Work in progress', hi: 'काम जारी है' },
  work_complete: { en: 'Work complete', hi: 'काम पूरा हुआ' },
}

/** Services evidence engine (S0.3): notify the buyer on each milestone. Best-effort.
 *  WhatsApp is added once S0.5 lands (email + in-app for now). */
export async function notifyMilestone(admin: Admin, order: any, kind: MilestoneKind): Promise<void> {
  const { msmeUserId } = await parties(admin, order)
  if (!msmeUserId) return
  const l = MILESTONE_LABELS[kind]
  await createNotification(admin, {
    userId: msmeUserId,
    kind: 'milestone_added',
    titleI18n: { en: `Update: ${l.en}`, hi: `अपडेट: ${l.hi}` },
    bodyI18n: { en: `${ref(order)}: ${l.en}.`, hi: `${ref(order)}: ${l.hi}।` },
    link: `/app/orders/${order.id}`,
    channels: ['email'],
  })
}

/** Prompt the buyer to review a completed order. */
export async function notifyReviewPrompt(admin: Admin, order: any): Promise<void> {
  const { msmeUserId } = await parties(admin, order)
  if (!msmeUserId) return
  await createNotification(admin, {
    userId: msmeUserId,
    kind: 'review_prompt',
    titleI18n: { en: 'How was your experience?', hi: 'आपका अनुभव कैसा रहा?' },
    bodyI18n: { en: `Leave a review for ${ref(order)}.`, hi: `${ref(order)} के लिए समीक्षा छोड़ें।` },
    link: `/app/orders/${order.id}`,
    channels: ['email'],
  })
}

/** System: order auto-cancelled (24h no-accept) → refunded. Notify buyer. */
export async function notifyAutoCancelled(admin: Admin, order: any): Promise<void> {
  const { msmeUserId } = await parties(admin, order)
  if (!msmeUserId) return
  await createNotification(admin, {
    userId: msmeUserId,
    kind: 'order_auto_cancelled',
    titleI18n: { en: 'Order cancelled & refunded', hi: 'ऑर्डर रद्द और धनवापसी' },
    bodyI18n: { en: `${ref(order)} was not accepted in time and has been fully refunded.`, hi: `${ref(order)} समय पर स्वीकार नहीं हुआ और पूरी धनवापसी कर दी गई है।` },
    link: `/app/orders/${order.id}`,
    channels: ['email', 'sms'],
  })
}

/** System: delivered order auto-accepted (72h) → completed. Notify both + prompt review. */
export async function notifyAutoAccepted(admin: Admin, order: any): Promise<void> {
  const { providerUserId } = await parties(admin, order)
  if (providerUserId) {
    await createNotification(admin, {
      userId: providerUserId,
      kind: 'order_completed',
      titleI18n: { en: 'Order auto-completed', hi: 'ऑर्डर स्वतः पूर्ण' },
      bodyI18n: { en: `${ref(order)} was auto-accepted after 72h — payout scheduled.`, hi: `${ref(order)} 72 घंटे बाद स्वतः स्वीकार — भुगतान निर्धारित।` },
      link: `/partner/orders/${order.id}`,
      channels: ['email'],
    })
  }
  await notifyReviewPrompt(admin, order)
}

/** Provider payout marked paid (payouts cron). */
export async function notifyPayoutPaid(admin: Admin, providerId: string, amountPaise: number, orderId: string): Promise<void> {
  const { data: p } = await admin.from('provider_profiles').select('user_id').eq('id', providerId).maybeSingle()
  if (!p?.user_id) return
  const rupees = (amountPaise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })
  await createNotification(admin, {
    userId: p.user_id,
    kind: 'payout_paid',
    titleI18n: { en: 'Payout sent', hi: 'भुगतान भेजा गया' },
    bodyI18n: { en: `₹${rupees} has been transferred to your bank account.`, hi: `₹${rupees} आपके बैंक खाते में स्थानांतरित कर दिए गए हैं।` },
    link: orderId ? `/partner/orders/${orderId}` : `/partner/earnings`,
    channels: ['email', 'sms'],
  })
}

/** Provider replied to a buyer's review. Notify the buyer. */
export async function notifyReviewReply(admin: Admin, review: any): Promise<void> {
  const { data: m } = await admin.from('msme_profiles').select('user_id').eq('id', review.msme_id).maybeSingle()
  if (!m?.user_id) return
  await createNotification(admin, {
    userId: m.user_id,
    kind: 'review_reply',
    titleI18n: { en: 'The provider replied to your review', hi: 'प्रदाता ने आपकी समीक्षा का उत्तर दिया' },
    bodyI18n: { en: 'See the provider’s response to your review.', hi: 'अपनी समीक्षा पर प्रदाता की प्रतिक्रिया देखें।' },
    link: `/app/orders/${review.order_id}`,
    channels: ['email'],
  })
}
/* eslint-enable @typescript-eslint/no-explicit-any */
