/**
 * Audit M30 — the shared contact fixtures. ONE table drives the storage masker
 * (redactContactInfo / stripContactInfo, packages/shared) and the output
 * contract (customerFacingText, packages/agent-core imports this file), so the
 * two can never drift apart again.
 *
 * `from` records which of the three old rule sets owned the case (every case
 * their tests carried is here), or `m30` for the new ones.
 */

export interface ContactCase {
  text: string
  /** The storage masker hides something (redactContactInfo.redacted). */
  mask: boolean
  /** The output contract refuses it with forbid ['contact', 'urls'] (identity numbers are refused but never masked). */
  refuse: boolean
  /** Substrings that must not survive masking. */
  hides?: readonly string[]
  from: 'rfq' | 'strip' | 'output' | 'intake' | 'm30'
}

const hit = (text: string, from: ContactCase['from'], hides: readonly string[] = []): ContactCase => ({ text, mask: true, refuse: true, hides, from })
const keep = (text: string, from: ContactCase['from']): ContactCase => ({ text, mask: false, refuse: false, from })
/** Identity numbers: refused in model output, left alone in human text. */
const identity = (text: string, from: ContactCase['from']): ContactCase => ({ text, mask: false, refuse: true, from })

export const CONTACT_CASES: readonly ContactCase[] = [
  // ── rfq.ts (redactContactInfo) — its unit tests ─────────────────────────────
  hit('call me on 9876543210 tomorrow', 'rfq', ['9876543210']),
  hit('reach me: +91 98765 43210', 'rfq', ['98765', '43210']),
  hit('reach me: +919876543210', 'rfq', ['9876543210']),
  hit('reach me: 98765-43210', 'rfq', ['98765']),
  hit('reach me: 9 8 7 6 5 4 3 2 1 0', 'rfq', ['9 8 7 6 5']),
  hit('mail me at ravi@example.com', 'rfq', ['ravi@example.com', '@']),
  hit('ravi.kumar+work@sub.domain.co.in ok?', 'rfq', ['@', 'domain']),
  hit('ravi@ex.com / 9876543210', 'rfq', ['ravi@ex.com', '9876543210']),
  hit('Call 9876543210 or mail a@b.co', 'rfq', ['9876543210', 'a@b.co']),
  keep('budget is 1500000 paise', 'rfq'),
  keep('incorporated in 2019, turnover 4500000', 'rfq'),
  identity('GSTIN 36AABCU9603R1ZM', 'rfq'),
  keep('I need monthly GST filing for my garments unit in Guntur.', 'rfq'),

  // ── quote-extraction.ts (stripContactInfo) — its unit tests ─────────────────
  hit('Call 9876543210 or ravi@upi or ravi@example.com for details, 5 days', 'strip', ['9876543210', 'ravi@upi', 'ravi@example.com']),
  hit('+91 98765 43210 anytime', 'strip', ['98765']),
  hit('dial 09876543210 after 6', 'strip', ['09876543210']),
  hit('UPI 98765@ybl or shop.name@okaxis', 'strip', ['98765@ybl', 'shop.name@okaxis']),
  keep('1200 sq ft at ₹450, 10-12 days', 'strip'),

  // ── output-policy.ts (CONTACT_PATTERNS) — the S2.1 contract tests ──────────
  hit('Call me on 9876543210 for the rate.', 'output', ['9876543210']),
  hit('Reach us at +91 98765 43210 anytime.', 'output', ['98765']),
  hit('Number: 98765-43210.', 'output', ['98765']),
  hit('Number: 98765.43210.', 'output', ['98765']),
  hit('मुझे ९८७६५४३२१० पर कॉल करें।', 'output', ['९८७६५४३२१०']),
  hit('నాకు ౯౮౭౬౫౪౩౨౧౦ కి కాల్ చేయండి.', 'output', ['౯౮౭౬౫౪౩౨౧౦']),
  hit('Write to owner@example.com with the PO.', 'output', ['owner@example.com']),
  hit('Send it to rajesh@ybl please.', 'output', ['rajesh@ybl']),
  hit('Ping me on telegram: @rajesh_traders_99', 'output', ['rajesh_traders_99']),
  hit('WhatsApp me on +91 90000 00001', 'output', ['90000 00001']),
  hit('See https://example.com/deal for the price list.', 'output', ['example.com']),
  hit('Visit www.rajeshtraders.in today.', 'output', ['rajeshtraders']),
  hit('Details at rajeshtraders.com now.', 'output', ['rajeshtraders']),
  hit('Call the buyer on 9876543210.', 'output', ['9876543210']),
  hit('See www.proof.in/photo', 'output', ['proof.in']),
  identity('Our GSTIN 36AAACR1234A1Z5 is on the invoice.', 'output'),
  identity('PAN AAACR1234A as printed.', 'output'),
  keep('GSTIN XXXXXXXXXXXA1Z5 as printed.', 'output'),
  keep('PAN XXXXXX234A.', 'output'),
  keep('Rs. 12,000 plus GST 18%, delivery in 10 days.', 'output'),
  keep('The total is ₹1,10,448 including tax.', 'output'),
  keep('Invoice KIS/2026-27/0418 dated 03/09/2026.', 'output'),
  keep('Deliver to Guntur 522001 by Friday.', 'output'),
  keep('In 2026 we need 1200 kg of MS angle.', 'output'),

  // ── intake.ts (clampDocumentExtract runs redactContactInfo) ─────────────────
  hit('call 9876543210 or mail a@b.com', 'intake', ['9876543210', 'a@b.com']),

  // ── M30: Indic digits (every script folds) ──────────────────────────────────
  hit('नंबर ९८७६५ ४३२१० है', 'm30', ['९८७६५', '४३२१०']),
  hit('ফোন ৯৮৭৬৫৪৩২১০', 'm30', ['৯৮৭৬৫৪৩২১০']), // Bengali
  hit('ફોન ૯૮૭૬૫૪૩૨૧૦', 'm30', ['૯૮૭૬૫૪૩૨૧૦']), // Gujarati
  hit('ਫੋਨ ੯੮੭੬੫੪੩੨੧੦', 'm30', ['੯੮੭੬੫੪੩੨੧੦']), // Gurmukhi
  hit('ଫୋନ ୯୮୭୬୫୪୩୨୧୦', 'm30', ['୯୮୭୬୫୪୩୨୧୦']), // Oriya
  hit('எண் ௯௮௭௬௫௪௩௨௧௦', 'm30', ['௯௮௭௬௫௪௩௨௧௦']), // Tamil
  hit('ಫೋನ್ ೯೮೭೬೫೪೩೨೧೦', 'm30', ['೯೮೭೬೫೪೩೨೧೦']), // Kannada
  hit('ഫോൺ ൯൮൭൬൫൪൩൨൧൦', 'm30', ['൯൮൭൬൫൪൩൨൧൦']), // Malayalam
  hit('فون ۹۸۷۶۵۴۳۲۱۰', 'm30', ['۹۸۷۶۵۴۳۲۱۰']), // Urdu (Extended Arabic-Indic)
  hit('mixed 98765 ४३२१०', 'm30', ['98765', '४३२१०']),
  hit('UPI ९८७६५४३२१०@ybl', 'm30', ['@ybl']),
  hit('fullwidth ９８７６５４３２１０', 'm30', ['９８７６５']),

  // ── M30: spaced, split, prefixed and hidden digits ──────────────────────────
  hit('2019 2020 2021 9876543210', 'm30', ['9876543210']), // the old left-aligned window missed this one
  hit('qty 12 then 9876543210', 'm30', ['9876543210']),
  hit('98 76 54 32 10', 'm30', ['98 76']),
  hit('987 654 3210', 'm30', ['987 654']),
  hit('(+91) 98765 43210', 'm30', ['98765']),
  hit('+91 - 98765 - 43210', 'm30', ['98765']),
  hit('+91 0 98765 43210', 'm30', ['98765']),
  hit('0091 98765 43210', 'm30', ['98765']),
  hit('91-98765-43210', 'm30', ['98765']),
  hit('98765​43210', 'm30', ['98765']), // zero-width space
  hit('98765­43210', 'm30', ['98765']), // soft hyphen
  hit('98765–43210', 'm30', ['98765']), // en dash
  hit('call 9876543210 1 time', 'm30', ['9876543210']),
  hit('landline 040-2345 6789', 'm30', ['2345 6789']),
  hit('office +91 40 2345 6789', 'm30', ['2345 6789']),
  hit('toll free 1800 123 4567', 'm30', ['123 4567']),

  // ── M30: spelled-out digits ─────────────────────────────────────────────────
  hit('nine eight seven six five four three two one zero', 'm30', ['nine eight seven']),
  hit('Nine, eight, seven, six, five, four, three, two, one, zero', 'm30', ['Nine, eight']),
  hit('98765 four three two one zero', 'm30', ['98765']),
  hit('nine eight double seven six five four three two one', 'm30', ['double seven']),
  hit('nau aath saat chhe paanch chaar teen do ek shunya', 'm30', ['nau aath']),
  hit('नौ आठ सात छह पांच चार तीन दो एक शून्य', 'm30', ['नौ आठ']),
  hit('తొమ్మిది ఎనిమిది ఏడు ఆరు ఐదు నాలుగు మూడు రెండు ఒకటి సున్నా', 'm30', ['తొమ్మిది ఎనిమిది']),
  hit('ஒன்பது எட்டு ஏழு ஆறு ஐந்து நான்கு மூன்று இரண்டு ஒன்று பூஜ்ஜியம்', 'm30', ['ஒன்பது எட்டு']),

  // ── M30: emails, UPI, links, handles ────────────────────────────────────────
  hit('ravi at gmail dot com', 'm30', ['gmail']),
  hit('ravi [at] gmail [dot] com', 'm30', ['gmail']),
  hit('ravi(at)gmail.com', 'm30', ['gmail']),
  hit('pay 9876543210@ybl', 'm30', ['9876543210']),
  hit('ravi@oksbi', 'm30', ['ravi@oksbi']),
  hit('wa.me/919876543210', 'm30', ['919876543210']),
  hit('t.me/rajesh_traders', 'm30', ['rajesh_traders']),
  hit('chat on https://wa.me/919876543210?text=hi', 'm30', ['919876543210']),
  hit('find us at instagram.com/rajesh.traders', 'm30', ['rajesh.traders']),
  hit('insta id: rajesh.traders', 'm30', ['rajesh.traders']),
  hit('DM @rajesh_traders for the rate', 'm30', ['@rajesh_traders']),
  hit('HTTPS://RAJESH.IN/rates', 'm30', ['RAJESH']),

  // ── M30: ordinary business text stays readable ──────────────────────────────
  keep('6 7 8 9', 'm30'),
  keep('e-way bill 391209876543', 'm30'), // a 12-digit identifier, not a phone
  keep('Order 1,50,000 units by 30/09/2026', 'm30'),
  keep('rate 450@kg, 500@pcs', 'm30'),
  keep('Price is fixed.In addition we deliver free.', 'm30'),
  keep('CA, M.Com, B.COM, LLB', 'm30'),
  keep('ASP.NET and VB.NET developers', 'm30'),
  keep('MS plate 12 mm, 450 per sq.in', 'm30'),
  keep('one or two revisions, done in three days', 'm30'),
  keep('Deliver at site by 10.30 on 24.09.2026', 'm30'),
  keep('HSN 7208 5190, GST 18 %, 2 5 0 kg', 'm30'),
  keep('Udyam UDYAM-TS-02-0012345 attached', 'm30'),
  keep('we do 2 visits a month', 'm30'),
]
