import type { WaTemplateRegistry, WaTemplateSpec, WaTemplateValues } from './template-types'

/**
 * ADR-030 §4 — templates for notification kinds added with the notification registry (refunds, reminders, dispute
 * outcomes, verification, pools …). Merged into WA_TEMPLATES by templates.ts. Owned by the notifications work.
 *
 * Every body is fixed text with typed parameters from the dispatcher's values (ref = order number, amount = server-
 * formatted from paise, deadline = IST, title = the request / pool title …), utility category, no promotional words,
 * never starting or ending with a parameter, and a URL button whose only dynamic part is the path to the exact screen
 * on our own domain (`app/orders/<id>`, from the notification's link).
 *
 * en and hi are reviewed copy. te and ta are machine drafts — NATIVE REVIEW REQUIRED before they are submitted to Meta
 * (docs/PRE_LAUNCH_CHECKLIST.md 1.3); until a variant is approved the send path falls back to en with the en code.
 */

const s = (v: string | null | undefined): string => String(v ?? '').trim()
/** The screen the button opens: the notification's own path (never another domain). */
const path = (v: WaTemplateValues): string | null => s(v['path']) || null

const VIEW_ORDER = { en: 'View order', hi: 'ऑर्डर देखें', te: 'ఆర్డర్ చూడండి', ta: 'ஆர்டரைப் பார்க்க' }
const OPEN_REQUEST = { en: 'Open request', hi: 'अनुरोध खोलें', te: 'అభ్యర్థన తెరవండి', ta: 'கோரிக்கையைத் திற' }
const OPEN_AMCLUB = { en: 'Open AMClub', hi: 'AMClub खोलें', te: 'AMClub తెరవండి', ta: 'AMClub-ஐத் திற' }
const PAY_NOW = { en: 'Pay your share', hi: 'अपना हिस्सा दें', te: 'మీ వాటా చెల్లించండి', ta: 'பங்கைச் செலுத்து' }
const VIEW_GROUP = { en: 'View group buy', hi: 'ग्रुप बाय देखें', te: 'గ్రూప్ కొనుగోలు చూడండి', ta: 'குழு வாங்குதல்' }

function tpl(kind: string, spec: Omit<WaTemplateSpec, 'stem' | 'category' | 'locales'>): WaTemplateSpec {
  return { stem: `amc_${kind}`, category: 'utility', locales: ['en', 'hi', 'te', 'ta'], ...spec }
}

export const NOTIFY_TEMPLATES: WaTemplateRegistry = {
  // ── orders ──────────────────────────────────────────────────────────────────
  order_auto_accepted: tpl('order_auto_accepted', {
    body: {
      en: 'The delivery for order {{1}} was accepted automatically after 72 hours, and the order is complete. You can rate the work in the app.',
      hi: 'ऑर्डर {{1}} की डिलीवरी 72 घंटे बाद अपने-आप स्वीकार हो गई और ऑर्डर पूरा हो गया। आप ऐप में काम को रेटिंग दे सकते हैं।',
      te: 'ఆర్డర్ {{1}} డెలివరీ 72 గంటల తర్వాత ఆటోమేటిక్‌గా ఆమోదించబడింది, ఆర్డర్ పూర్తయింది. మీరు యాప్‌లో పనికి రేటింగ్ ఇవ్వవచ్చు.',
      ta: 'ஆர்டர் {{1}} டெலிவரி 72 மணி நேரத்துக்குப் பிறகு தானாக ஏற்கப்பட்டது, ஆர்டர் நிறைவடைந்தது. செயலியில் வேலையை மதிப்பிடலாம்.',
    },
    params: (v) => [s(v['ref'])],
    urlButton: { label: VIEW_ORDER, suffix: path },
  }),
  goods_dispatched: tpl('goods_dispatched', {
    body: {
      en: 'Your order {{1}} has been dispatched. We will tell you when it is delivered.',
      hi: 'आपका ऑर्डर {{1}} भेज दिया गया है। डिलीवर होने पर हम आपको बताएँगे।',
      te: 'మీ ఆర్డర్ {{1}} పంపబడింది. డెలివరీ అయినప్పుడు మేము మీకు తెలియజేస్తాము.',
      ta: 'உங்கள் ஆர்டர் {{1}} அனுப்பப்பட்டது. டெலிவரி ஆனதும் உங்களுக்குத் தெரிவிப்போம்.',
    },
    params: (v) => [s(v['ref'])],
    urlButton: { label: VIEW_ORDER, suffix: path },
  }),
  goods_delivered: tpl('goods_delivered', {
    body: {
      en: 'Your order {{1}} was delivered. Check it and confirm receipt, or open a return, by {{2}}. After that it is accepted automatically.',
      hi: 'आपका ऑर्डर {{1}} डिलीवर हो गया है। {{2}} तक इसे जाँचकर मिलने की पुष्टि करें या वापसी खोलें। उसके बाद इसे अपने-आप स्वीकार मान लिया जाएगा।',
      te: 'మీ ఆర్డర్ {{1}} డెలివరీ అయింది. {{2}} లోపు దాన్ని తనిఖీ చేసి అందినట్లు నిర్ధారించండి లేదా రిటర్న్ తెరవండి. ఆ తర్వాత అది ఆటోమేటిక్‌గా ఆమోదించబడుతుంది.',
      ta: 'உங்கள் ஆர்டர் {{1}} டெலிவரி ஆனது. {{2}}-க்குள் அதைச் சரிபார்த்து பெற்றதை உறுதிசெய்யுங்கள் அல்லது திருப்பியளிப்பைத் திறக்கவும். அதன் பிறகு அது தானாக ஏற்கப்படும்.',
    },
    params: (v) => [s(v['ref']), s(v['deadline'])],
    urlButton: { label: VIEW_ORDER, suffix: path },
  }),
  dispute_resolved: tpl('dispute_resolved', {
    // {{2}} is the notification's own body (the outcome and amounts, already in the recipient's language).
    body: {
      en: 'The dispute on order {{1}} is resolved. {{2}} Open the order for the details.',
      hi: 'ऑर्डर {{1}} पर विवाद का निपटारा हो गया है। {{2}} पूरी जानकारी के लिए ऑर्डर खोलें।',
      te: 'ఆర్డర్ {{1}}పై వివాదం పరిష్కరించబడింది. {{2}} వివరాల కోసం ఆర్డర్ తెరవండి.',
      ta: 'ஆர்டர் {{1}}-இல் சர்ச்சை தீர்க்கப்பட்டது. {{2}} விவரங்களுக்கு ஆர்டரைத் திறக்கவும்.',
    },
    params: (v) => [s(v['ref']), s(v['body'])],
    urlButton: { label: VIEW_ORDER, suffix: path },
  }),
  order_duplicate_payment: tpl('order_duplicate_payment', {
    body: {
      en: 'You paid twice for the same request, so order {{1}} is cancelled and refunded in full. Your other order is not affected.',
      hi: 'आपने एक ही अनुरोध के लिए दो बार भुगतान किया, इसलिए ऑर्डर {{1}} रद्द करके पूरा रिफ़ंड किया जा रहा है। आपके दूसरे ऑर्डर पर कोई असर नहीं है।',
      te: 'మీరు ఒకే అభ్యర్థనకు రెండుసార్లు చెల్లించారు, కాబట్టి ఆర్డర్ {{1}} రద్దు చేసి పూర్తిగా రీఫండ్ చేస్తున్నాము. మీ మరో ఆర్డర్‌పై ప్రభావం లేదు.',
      ta: 'ஒரே கோரிக்கைக்கு இரண்டு முறை பணம் செலுத்தினீர்கள், எனவே ஆர்டர் {{1}} ரத்து செய்யப்பட்டு முழுமையாகத் திருப்பி அளிக்கப்படுகிறது. உங்கள் மற்ற ஆர்டர் பாதிக்கப்படாது.',
    },
    params: (v) => [s(v['ref'])],
    urlButton: { label: VIEW_ORDER, suffix: path },
  }),
  payment_refunded_no_order: tpl('payment_refunded_no_order', {
    body: {
      en: 'We received your payment of {{1}} but no order could be placed, so we are refunding it in full. Your bank usually shows it within 5–7 working days.',
      hi: 'हमें आपका {{1}} का भुगतान मिला, लेकिन कोई ऑर्डर नहीं बन सका, इसलिए हम इसका पूरा रिफ़ंड कर रहे हैं। आमतौर पर यह 5–7 कार्यदिवसों में आपके बैंक खाते में दिखता है।',
      te: 'మీ {{1}} చెల్లింపు మాకు అందింది, కానీ ఆర్డర్ నమోదు కాలేదు, కాబట్టి పూర్తిగా రీఫండ్ చేస్తున్నాము. సాధారణంగా 5–7 పని దినాల్లో మీ బ్యాంక్‌లో కనిపిస్తుంది.',
      ta: 'உங்கள் {{1}} பணம் கிடைத்தது, ஆனால் ஆர்டர் பதிவாகவில்லை, எனவே முழுமையாகத் திருப்பி அளிக்கிறோம். பொதுவாக 5–7 வேலை நாட்களில் உங்கள் வங்கியில் தெரியும்.',
    },
    params: (v) => [s(v['amount'])],
    urlButton: { label: OPEN_AMCLUB, suffix: path },
  }),
  // AMC Mart pools (M1).
  pool_met: tpl('pool_met', {
    body: {
      en: 'The group buy {{1}} reached its minimum. Pay your share by {{2}} to confirm your order.',
      hi: 'ग्रुप बाय {{1}} का न्यूनतम पूरा हो गया है। ऑर्डर पक्का करने के लिए {{2}} तक अपने हिस्से का भुगतान करें।',
      te: 'గ్రూప్ కొనుగోలు {{1}} కనీస పరిమాణం చేరింది. మీ ఆర్డర్ నిర్ధారించడానికి {{2}} లోపు మీ వాటా చెల్లించండి.',
      ta: 'குழு வாங்குதல் {{1}} குறைந்தபட்ச அளவை எட்டியது. உங்கள் ஆர்டரை உறுதிசெய்ய {{2}}-க்குள் உங்கள் பங்கைச் செலுத்துங்கள்.',
    },
    params: (v) => [s(v['title']), s(v['deadline'])],
    urlButton: { label: PAY_NOW, suffix: path },
  }),
  pool_unmet: tpl('pool_unmet', {
    body: {
      en: 'The group buy {{1}} closed short of its minimum quantity. Nothing is charged and your commitment is released.',
      hi: 'ग्रुप बाय {{1}} न्यूनतम मात्रा से कम पर बंद हुआ। कोई शुल्क नहीं लिया गया और आपकी प्रतिबद्धता मुक्त कर दी गई है।',
      te: 'గ్రూప్ కొనుగోలు {{1}} కనీస పరిమాణం కంటే తక్కువతో ముగిసింది. ఏమీ వసూలు చేయలేదు, మీ నిబద్ధత విడుదల చేయబడింది.',
      ta: 'குழு வாங்குதல் {{1}} குறைந்தபட்ச அளவுக்குக் குறைவாக முடிந்தது. எதுவும் வசூலிக்கப்படவில்லை, உங்கள் உறுதிமொழி விடுவிக்கப்பட்டது.',
    },
    params: (v) => [s(v['title'])],
    urlButton: { label: VIEW_GROUP, suffix: path },
  }),
  pool_cancelled: tpl('pool_cancelled', {
    body: {
      en: 'The group buy {{1}} was cancelled. Nothing is charged.',
      hi: 'ग्रुप बाय {{1}} रद्द कर दिया गया। कोई शुल्क नहीं लिया गया।',
      te: 'గ్రూప్ కొనుగోలు {{1}} రద్దయింది. ఏమీ వసూలు చేయలేదు.',
      ta: 'குழு வாங்குதல் {{1}} ரத்து செய்யப்பட்டது. எதுவும் வசூலிக்கப்படவில்லை.',
    },
    params: (v) => [s(v['title'])],
    urlButton: { label: VIEW_GROUP, suffix: path },
  }),
  pool_defaulted: tpl('pool_defaulted', {
    body: {
      en: 'Your share of the group buy {{1}} was not paid inside the window, so the commitment has lapsed and is noted on your buyer record.',
      hi: 'ग्रुप बाय {{1}} में आपके हिस्से का भुगतान समय सीमा में नहीं हुआ, इसलिए प्रतिबद्धता समाप्त हो गई है और यह आपके खरीदार रिकॉर्ड में दर्ज है।',
      te: 'గ్రూప్ కొనుగోలు {{1}}లో మీ వాటా గడువులో చెల్లించబడలేదు, కాబట్టి నిబద్ధత ముగిసింది, ఇది మీ కొనుగోలుదారు రికార్డులో నమోదైంది.',
      ta: 'குழு வாங்குதல் {{1}}-இல் உங்கள் பங்கு காலக்கெடுவுக்குள் செலுத்தப்படவில்லை, எனவே உறுதிமொழி காலாவதியானது, இது உங்கள் வாங்குபவர் பதிவில் பதிவாகியுள்ளது.',
    },
    params: (v) => [s(v['title'])],
    urlButton: { label: VIEW_GROUP, suffix: path },
  }),
  pool_met_seller: tpl('pool_met_seller', {
    body: {
      en: 'Your group buy {{1}} reached its minimum: {{2}} buyers committed {{3}}. Their orders arrive as they pay over the next two days.',
      hi: 'आपका ग्रुप बाय {{1}} न्यूनतम तक पहुँच गया: {{2}} खरीदारों ने {{3}} की प्रतिबद्धता दी है। अगले दो दिनों में भुगतान होते ही उनके ऑर्डर आएँगे।',
      te: 'మీ గ్రూప్ కొనుగోలు {{1}} కనీస పరిమాణం చేరింది: {{2}} కొనుగోలుదారులు {{3}}కు నిబద్ధత ఇచ్చారు. వచ్చే రెండు రోజుల్లో వారు చెల్లించినప్పుడు ఆర్డర్లు వస్తాయి.',
      ta: 'உங்கள் குழு வாங்குதல் {{1}} குறைந்தபட்ச அளவை எட்டியது: {{2}} வாங்குபவர்கள் {{3}}-க்கு உறுதியளித்தனர். அடுத்த இரண்டு நாட்களில் அவர்கள் பணம் செலுத்தும்போது ஆர்டர்கள் வரும்.',
    },
    params: (v) => [s(v['title']), s(v['members']), `${s(v['qty'])} ${s(v['unit'])}`.trim()],
    urlButton: { label: OPEN_AMCLUB, suffix: path },
  }),
  pool_ordered: tpl('pool_ordered', {
    body: {
      en: 'Group buy {{1}}: {{2}} paid orders totalling {{3}} are waiting for you to accept and dispatch.',
      hi: 'ग्रुप बाय {{1}}: {{2}} भुगतान किए गए ऑर्डर (कुल {{3}}) आपकी स्वीकृति और डिस्पैच का इंतज़ार कर रहे हैं।',
      te: 'గ్రూప్ కొనుగోలు {{1}}: {{2}} చెల్లించిన ఆర్డర్లు (మొత్తం {{3}}) మీ అంగీకారం, డిస్పాచ్ కోసం వేచి ఉన్నాయి.',
      ta: 'குழு வாங்குதல் {{1}}: {{2}} பணம் செலுத்தப்பட்ட ஆர்டர்கள் (மொத்தம் {{3}}) நீங்கள் ஏற்று அனுப்பக் காத்திருக்கின்றன.',
    },
    params: (v) => [s(v['title']), s(v['members']), `${s(v['qty'])} ${s(v['unit'])}`.trim()],
    urlButton: { label: OPEN_AMCLUB, suffix: path },
  }),

  // ── payments ────────────────────────────────────────────────────────────────
  payout_held: tpl('payout_held', {
    body: {
      en: 'Your payout of {{1}} for order {{2}} is on hold: {{3}}. It is released once this is cleared.',
      hi: 'आपका {{1}} का भुगतान (ऑर्डर {{2}}) रोका गया है: {{3}}। यह दूर होते ही भुगतान जारी कर दिया जाएगा।',
      te: 'మీ {{1}} చెల్లింపు (ఆర్డర్ {{2}}) నిలిపివేయబడింది: {{3}}. ఇది పరిష్కారమైన వెంటనే విడుదల చేయబడుతుంది.',
      ta: 'உங்கள் {{1}} பேஅவுட் (ஆர்டர் {{2}}) நிறுத்தி வைக்கப்பட்டுள்ளது: {{3}}. இது தீர்ந்ததும் விடுவிக்கப்படும்.',
    },
    params: (v) => [s(v['amount']), s(v['ref']), s(v['reasons'])],
    urlButton: { label: VIEW_ORDER, suffix: path },
  }),
  refund_processed: tpl('refund_processed', {
    body: {
      en: 'Your refund of {{1}} for order {{2}} has been processed. Your bank usually shows it within 5–7 working days.',
      hi: 'आपका {{1}} का रिफ़ंड (ऑर्डर {{2}}) प्रोसेस हो गया है। आमतौर पर यह 5–7 कार्यदिवसों में आपके बैंक खाते में दिखता है।',
      te: 'మీ {{1}} రీఫండ్ (ఆర్డర్ {{2}}) ప్రాసెస్ అయింది. సాధారణంగా 5–7 పని దినాల్లో మీ బ్యాంక్‌లో కనిపిస్తుంది.',
      ta: 'உங்கள் {{1}} பணத்திருப்பம் (ஆர்டர் {{2}}) செயலாக்கப்பட்டது. பொதுவாக 5–7 வேலை நாட்களில் உங்கள் வங்கியில் தெரியும்.',
    },
    params: (v) => [s(v['amount']), s(v['ref'])],
    urlButton: { label: VIEW_ORDER, suffix: path },
  }),
  refund_failed: tpl('refund_failed', {
    body: {
      en: 'The refund of {{1}} for order {{2}} did not go through at the bank. Our team is sending it again; you do not need to do anything.',
      hi: 'आपका {{1}} का रिफ़ंड (ऑर्डर {{2}}) बैंक में पूरा नहीं हो सका। हमारी टीम इसे दोबारा भेज रही है; आपको कुछ करने की ज़रूरत नहीं है।',
      te: 'మీ {{1}} రీఫండ్ (ఆర్డర్ {{2}}) బ్యాంక్‌లో పూర్తి కాలేదు. మా బృందం దాన్ని మళ్లీ పంపుతోంది; మీరు ఏమీ చేయాల్సిన అవసరం లేదు.',
      ta: 'உங்கள் {{1}} பணத்திருப்பம் (ஆர்டர் {{2}}) வங்கியில் நிறைவடையவில்லை. எங்கள் குழு அதை மீண்டும் அனுப்புகிறது; நீங்கள் எதுவும் செய்ய வேண்டியதில்லை.',
    },
    params: (v) => [s(v['amount']), s(v['ref'])],
    urlButton: { label: VIEW_ORDER, suffix: path },
  }),

  // ── requests ────────────────────────────────────────────────────────────────
  rfq_digest: tpl('rfq_digest', {
    body: {
      en: 'New requests matching your services on AMClub: {{1}}. Open the app to quote.',
      hi: 'AMClub पर आपकी सेवाओं से मेल खाते नए अनुरोध: {{1}}। कोटेशन देने के लिए ऐप खोलें।',
      te: 'AMClubలో మీ సేవలకు సరిపోయే కొత్త అభ్యర్థనలు: {{1}}. కొటేషన్ ఇవ్వడానికి యాప్ తెరవండి.',
      ta: 'AMClub-இல் உங்கள் சேவைகளுக்குப் பொருந்தும் புதிய கோரிக்கைகள்: {{1}}. மேற்கோள் கொடுக்க செயலியைத் திறக்கவும்.',
    },
    params: (v) => [s(v['count'])],
    urlButton: { label: OPEN_REQUEST, suffix: path },
  }),
  quote_withdrawn: tpl('quote_withdrawn', {
    body: {
      en: 'A provider withdrew their quote on your request "{{1}}". Your other quotes are not affected.',
      hi: 'एक प्रदाता ने आपके अनुरोध "{{1}}" पर अपना कोटेशन वापस ले लिया। आपके दूसरे कोटेशन पर कोई असर नहीं है।',
      te: 'ఒక ప్రొవైడర్ మీ అభ్యర్థన "{{1}}"పై తమ కొటేషన్‌ను ఉపసంహరించుకున్నారు. మీ ఇతర కొటేషన్లపై ప్రభావం లేదు.',
      ta: 'ஒரு வழங்குநர் உங்கள் கோரிக்கை "{{1}}"-இல் தங்கள் மேற்கோளைத் திரும்பப் பெற்றார். உங்கள் மற்ற மேற்கோள்கள் பாதிக்கப்படாது.',
    },
    params: (v) => [s(v['title'])],
    urlButton: { label: OPEN_REQUEST, suffix: path },
  }),

  // ── reminders ───────────────────────────────────────────────────────────────
  order_accept_reminder: tpl('order_accept_reminder', {
    body: {
      en: 'Order {{1}} is waiting for you to accept. Accept it within {{2}} hours or it is cancelled and the buyer is refunded.',
      hi: 'ऑर्डर {{1}} आपकी स्वीकृति का इंतज़ार कर रहा है। इसे {{2}} घंटे में स्वीकार करें, नहीं तो यह रद्द हो जाएगा और खरीदार को रिफ़ंड मिल जाएगा।',
      te: 'ఆర్డర్ {{1}} మీ అంగీకారం కోసం వేచి ఉంది. దాన్ని {{2}} గంటల్లో అంగీకరించండి, లేకపోతే అది రద్దయి కొనుగోలుదారుకు రీఫండ్ అవుతుంది.',
      ta: 'ஆர்டர் {{1}} உங்கள் ஏற்புக்காகக் காத்திருக்கிறது. {{2}} மணி நேரத்துக்குள் ஏற்கவும், இல்லையெனில் அது ரத்தாகி வாங்குபவருக்குப் பணம் திருப்பி அளிக்கப்படும்.',
    },
    params: (v) => [s(v['ref']), s(v['hours'])],
    urlButton: { label: VIEW_ORDER, suffix: path },
  }),
  order_review_reminder: tpl('order_review_reminder', {
    body: {
      en: 'Please check the delivery for order {{1}} by {{2}}. After that it is accepted automatically.',
      hi: 'कृपया ऑर्डर {{1}} की डिलीवरी {{2}} तक जाँच लें। उसके बाद इसे अपने-आप स्वीकार मान लिया जाएगा।',
      te: 'దయచేసి ఆర్డర్ {{1}} డెలివరీని {{2}} లోపు తనిఖీ చేయండి. ఆ తర్వాత అది ఆటోమేటిక్‌గా ఆమోదించబడుతుంది.',
      ta: 'தயவுசெய்து ஆர்டர் {{1}} டெலிவரியை {{2}}-க்குள் சரிபார்க்கவும். அதன் பிறகு அது தானாக ஏற்கப்படும்.',
    },
    params: (v) => [s(v['ref']), s(v['deadline'])],
    urlButton: { label: VIEW_ORDER, suffix: path },
  }),
  rfq_expiring_reminder: tpl('rfq_expiring_reminder', {
    body: {
      en: 'Your request "{{1}}" has {{2}} quotes waiting and closes in {{3}} hours. Compare and accept one before it closes.',
      hi: 'आपके अनुरोध "{{1}}" पर {{2}} कोटेशन इंतज़ार कर रहे हैं और यह {{3}} घंटे में बंद हो जाएगा। बंद होने से पहले तुलना करके एक स्वीकार करें।',
      te: 'మీ అభ్యర్థన "{{1}}"పై {{2}} కొటేషన్లు వేచి ఉన్నాయి, ఇది {{3}} గంటల్లో ముగుస్తుంది. ముగిసేలోపు పోల్చి ఒకటి అంగీకరించండి.',
      ta: 'உங்கள் கோரிக்கை "{{1}}"-இல் {{2}} மேற்கோள்கள் காத்திருக்கின்றன, இது {{3}} மணி நேரத்தில் முடியும். முடிவதற்குள் ஒப்பிட்டு ஒன்றை ஏற்கவும்.',
    },
    params: (v) => [s(v['title']), s(v['count']), s(v['hours'])],
    urlButton: { label: OPEN_REQUEST, suffix: path },
  }),
  pool_pay_reminder: tpl('pool_pay_reminder', {
    body: {
      en: 'Reminder: pay your share of the group buy {{1}} by {{2}} to confirm your order, or your commitment lapses.',
      hi: 'याद दिलाना: ऑर्डर पक्का करने के लिए ग्रुप बाय {{1}} में अपने हिस्से का भुगतान {{2}} तक करें, नहीं तो आपकी प्रतिबद्धता समाप्त हो जाएगी।',
      te: 'గుర్తు చేస్తున్నాము: మీ ఆర్డర్ నిర్ధారించడానికి గ్రూప్ కొనుగోలు {{1}}లో మీ వాటాను {{2}} లోపు చెల్లించండి, లేకపోతే మీ నిబద్ధత ముగుస్తుంది.',
      ta: 'நினைவூட்டல்: உங்கள் ஆர்டரை உறுதிசெய்ய குழு வாங்குதல் {{1}}-இல் உங்கள் பங்கை {{2}}-க்குள் செலுத்துங்கள், இல்லையெனில் உங்கள் உறுதிமொழி காலாவதியாகும்.',
    },
    params: (v) => [s(v['title']), s(v['deadline'])],
    urlButton: { label: PAY_NOW, suffix: path },
  }),

  // ── account ─────────────────────────────────────────────────────────────────
  provider_verified: tpl('provider_verified', {
    body: {
      en: 'Your AMClub provider profile is approved. You can now receive orders; check your listings in the app.',
      hi: 'आपकी AMClub प्रदाता प्रोफ़ाइल स्वीकृत हो गई है। अब आप ऑर्डर ले सकते हैं; ऐप में अपनी लिस्टिंग देखें।',
      te: 'మీ AMClub ప్రొవైడర్ ప్రొఫైల్ ఆమోదించబడింది. ఇప్పుడు మీరు ఆర్డర్లు పొందవచ్చు; యాప్‌లో మీ లిస్టింగ్‌లను చూడండి.',
      ta: 'உங்கள் AMClub வழங்குநர் சுயவிவரம் அங்கீகரிக்கப்பட்டது. இப்போது ஆர்டர்களைப் பெறலாம்; செயலியில் உங்கள் பட்டியல்களைப் பாருங்கள்.',
    },
    params: () => [],
    urlButton: { label: OPEN_AMCLUB, suffix: path },
  }),
  provider_rejected: tpl('provider_rejected', {
    body: {
      en: 'Your AMClub provider application was not approved. Reason: {{1}}. You can correct this and apply again.',
      hi: 'आपका AMClub प्रदाता आवेदन स्वीकृत नहीं हुआ। कारण: {{1}}। इसे ठीक करके आप फिर से आवेदन कर सकते हैं।',
      te: 'మీ AMClub ప్రొవైడర్ దరఖాస్తు ఆమోదించబడలేదు. కారణం: {{1}}. దీన్ని సరిచేసి మళ్లీ దరఖాస్తు చేయవచ్చు.',
      ta: 'உங்கள் AMClub வழங்குநர் விண்ணப்பம் அங்கீகரிக்கப்படவில்லை. காரணம்: {{1}}. இதைச் சரிசெய்து மீண்டும் விண்ணப்பிக்கலாம்.',
    },
    params: (v) => [s(v['reason'])],
    urlButton: { label: OPEN_AMCLUB, suffix: path },
  }),
  provider_needs_info: tpl('provider_needs_info', {
    body: {
      en: 'We need a little more to verify your AMClub provider application: {{1}}. Please update it in the app.',
      hi: 'आपके AMClub प्रदाता आवेदन के सत्यापन के लिए हमें थोड़ी और जानकारी चाहिए: {{1}}। कृपया इसे ऐप में अपडेट करें।',
      te: 'మీ AMClub ప్రొవైడర్ దరఖాస్తు ధృవీకరణకు మాకు మరికొంత సమాచారం కావాలి: {{1}}. దయచేసి యాప్‌లో దాన్ని అప్‌డేట్ చేయండి.',
      ta: 'உங்கள் AMClub வழங்குநர் விண்ணப்பத்தைச் சரிபார்க்க இன்னும் சில தகவல்கள் தேவை: {{1}}. தயவுசெய்து செயலியில் புதுப்பிக்கவும்.',
    },
    params: (v) => [s(v['reason'])],
    urlButton: { label: OPEN_AMCLUB, suffix: path },
  }),
}

/** The notification kinds this file owns (the web dispatcher's new kinds with WhatsApp in their defaults). */
export const NOTIFY_TEMPLATE_KINDS = Object.keys(NOTIFY_TEMPLATES)
