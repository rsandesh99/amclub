import type { WaLocale, WaTemplateCategory } from '@amclub/shared'
import type { WaTemplateRegistry, WaTemplateSpec, WaTemplateValues } from './template-types'
import type { WaTemplateComponents } from './types'
import { NOTIFY_TEMPLATES } from './templates-notify'
import { SYSTEM_TEMPLATES } from './templates-system'
import {
  BTN_APPLICATION,
  BTN_ASSISTANT,
  BTN_CONTINUE,
  BTN_DETAILS,
  BTN_ORDER,
  BTN_REQUEST,
  EX_ORDER,
  EX_PROVIDER_ORDER,
  EX_PROVIDER_RFQ,
  EX_RFQ,
  TAIL_DETAILS,
  TAIL_ORDER,
  TAIL_REQUEST,
  WA_DEFAULT_LINK_SUFFIX,
  WA_TEMPLATE_LANGUAGE,
  WA_URL_BUTTON_BASE,
  fixed,
  notice,
  urlButton,
} from './template-kit'

export { WA_DEFAULT_LINK_SUFFIX, WA_TEMPLATE_LANGUAGE, WA_URL_BUTTON_BASE, linkSuffix } from './template-kit'

/**
 * Template registry v2 (ADR-030 §3, audit B2). One entry per kind: the Meta name stem, the category, the locales
 * submitted, the body EXACTLY as submitted per locale, typed parameters and an optional URL button to our own domain.
 * `resolveTemplate` turns (kind, locale) into a (name, language) pair that exists — the locale's variant when it was
 * submitted, else the en name WITH the en language code (never an en name under another code: audit B2).
 * The approval list in docs/PRE_LAUNCH_CHECKLIST.md 1.3 is generated from here (`pnpm --filter @amclub/agent-core
 * templates:list`), so what is approved is provably what is sent.
 *
 * Meta rules the bodies follow: a body never starts or ends with a parameter, two parameters are never adjacent, the
 * fixed text is distinct per template (duplicates are rejected), and utility templates carry no promotional wording
 * (since Apr 2025 Meta re-categorises such a template as marketing — `template_category_update`).
 * Every kind here is `utility`; purpose (transactional / assistant) is decided per send by the caller.
 *
 * Telugu and Tamil bodies are machine drafts: native review pending before submission (ADR-030 build note).
 */

// ── the registry ─────────────────────────────────────────────────────────────

/** The kinds this package sends or the web dispatcher sends today. NOTIFY_TEMPLATES / SYSTEM_TEMPLATES add the rest. */
export const CORE_TEMPLATES: WaTemplateRegistry = {
  // ── orders (a party of the order; values title / body / link from the notification) ──
  order_placed: notice('amc_order_placed', {
    en: 'AMClub: an order was placed.',
    hi: 'AMClub: एक ऑर्डर दिया गया है।',
    te: 'AMClub: ఒక ఆర్డర్ చేయబడింది.',
    ta: 'AMClub: ஒரு ஆர்டர் செய்யப்பட்டது.',
  }, TAIL_ORDER, BTN_ORDER, EX_PROVIDER_ORDER),
  order_accepted: notice('amc_order_accepted', {
    en: 'AMClub: your order was accepted.',
    hi: 'AMClub: आपका ऑर्डर स्वीकार कर लिया गया है।',
    te: 'AMClub: మీ ఆర్డర్ అంగీకరించబడింది.',
    ta: 'AMClub: உங்கள் ஆர்டர் ஏற்றுக்கொள்ளப்பட்டது.',
  }, TAIL_ORDER, BTN_ORDER, EX_ORDER),
  requirements_submitted: notice('amc_requirements_submitted', {
    en: 'AMClub: the buyer has shared the order requirements.',
    hi: 'AMClub: खरीदार ने ऑर्डर की ज़रूरतें भेज दी हैं।',
    te: 'AMClub: కొనుగోలుదారు ఆర్డర్ అవసరాలను పంపారు.',
    ta: 'AMClub: வாங்குபவர் ஆர்டர் தேவைகளைப் பகிர்ந்துள்ளார்.',
  }, TAIL_ORDER, BTN_ORDER, EX_PROVIDER_ORDER),
  order_in_progress: notice('amc_order_in_progress', {
    en: 'AMClub: work on your order is in progress.',
    hi: 'AMClub: आपके ऑर्डर पर काम चल रहा है।',
    te: 'AMClub: మీ ఆర్డర్ పని జరుగుతోంది.',
    ta: 'AMClub: உங்கள் ஆர்டரின் பணி நடைபெற்று வருகிறது.',
  }, TAIL_ORDER, BTN_ORDER, EX_ORDER),
  order_delivered: notice('amc_order_delivered', {
    en: 'AMClub: your order has been delivered.',
    hi: 'AMClub: आपका ऑर्डर डिलीवर कर दिया गया है।',
    te: 'AMClub: మీ ఆర్డర్ డెలివర్ చేయబడింది.',
    ta: 'AMClub: உங்கள் ஆர்டர் டெலிவரி செய்யப்பட்டது.',
  }, TAIL_ORDER, BTN_ORDER, EX_ORDER),
  order_completed: notice('amc_order_completed', {
    en: 'AMClub: an order is complete.',
    hi: 'AMClub: एक ऑर्डर पूरा हो गया है।',
    te: 'AMClub: ఒక ఆర్డర్ పూర్తయింది.',
    ta: 'AMClub: ஒரு ஆர்டர் நிறைவடைந்தது.',
  }, TAIL_ORDER, BTN_ORDER, EX_PROVIDER_ORDER),
  order_cancelled: notice('amc_order_cancelled', {
    en: 'AMClub: an order was cancelled.',
    hi: 'AMClub: एक ऑर्डर रद्द कर दिया गया है।',
    te: 'AMClub: ఒక ఆర్డర్ రద్దు చేయబడింది.',
    ta: 'AMClub: ஒரு ஆர்டர் ரத்து செய்யப்பட்டது.',
  }, TAIL_ORDER, BTN_ORDER, EX_PROVIDER_ORDER),
  order_auto_cancelled: notice('amc_order_auto_cancelled', {
    en: 'AMClub: an order was cancelled automatically because it was not accepted in time.',
    hi: 'AMClub: समय पर स्वीकार न होने के कारण एक ऑर्डर अपने-आप रद्द हो गया है।',
    te: 'AMClub: సమయానికి అంగీకరించనందున ఒక ఆర్డర్ స్వయంచాలకంగా రద్దయింది.',
    ta: 'AMClub: நேரத்தில் ஏற்கப்படாததால் ஒரு ஆர்டர் தானாக ரத்து செய்யப்பட்டது.',
  }, TAIL_ORDER, BTN_ORDER, EX_ORDER),
  order_disputed: notice('amc_order_disputed', {
    en: 'AMClub: an issue was raised on an order.',
    hi: 'AMClub: एक ऑर्डर पर समस्या दर्ज की गई है।',
    te: 'AMClub: ఒక ఆర్డర్‌పై సమస్య నమోదైంది.',
    ta: 'AMClub: ஒரு ஆர்டரில் சிக்கல் பதிவு செய்யப்பட்டது.',
  }, TAIL_ORDER, BTN_ORDER, EX_PROVIDER_ORDER),
  revision_requested: notice('amc_revision_requested', {
    en: 'AMClub: the buyer asked for a revision.',
    hi: 'AMClub: खरीदार ने बदलाव का अनुरोध किया है।',
    te: 'AMClub: కొనుగోలుదారు సవరణ కోరారు.',
    ta: 'AMClub: வாங்குபவர் திருத்தம் கோரியுள்ளார்.',
  }, TAIL_ORDER, BTN_ORDER, EX_PROVIDER_ORDER),
  milestone_added: notice('amc_milestone_added', {
    en: 'AMClub: a milestone was added to your order.',
    hi: 'AMClub: आपके ऑर्डर में एक पड़ाव जोड़ा गया है।',
    te: 'AMClub: మీ ఆర్డర్‌కు ఒక మైలురాయి జోడించబడింది.',
    ta: 'AMClub: உங்கள் ஆர்டரில் ஒரு மைல்கல் சேர்க்கப்பட்டது.',
  }, TAIL_ORDER, BTN_ORDER, EX_ORDER),
  // Reworded (ADR-030): "Rate your order / help others choose" reads as engagement marketing and Meta re-categorises
  // such utility templates; the fixed text now only states the order's status and what can be done on it.
  review_prompt: notice('amc_review_prompt', {
    en: 'AMClub: this order is complete, and a review can now be added for it.',
    hi: 'AMClub: यह ऑर्डर पूरा हो गया है और अब इसकी समीक्षा दी जा सकती है।',
    te: 'AMClub: ఈ ఆర్డర్ పూర్తయింది, ఇప్పుడు దీనికి సమీక్ష ఇవ్వవచ్చు.',
    ta: 'AMClub: இந்த ஆர்டர் நிறைவடைந்தது, இப்போது இதற்கு மதிப்பாய்வு சேர்க்கலாம்.',
  }, TAIL_ORDER, BTN_ORDER, EX_ORDER),
  // E8b — a new message on an order: the order number only (values title), NEVER the message text.
  order_message: fixed('amc_order_message', {
    en: 'AMClub: you have a new message on an order.\n\n{{1}}\n\nTap the button below to read it in AMClub.',
    hi: 'AMClub: एक ऑर्डर पर आपके लिए नया संदेश है।\n\n{{1}}\n\nइसे AMClub में पढ़ने के लिए नीचे दिया बटन दबाएँ।',
    te: 'AMClub: ఒక ఆర్డర్‌పై మీకు కొత్త సందేశం వచ్చింది.\n\n{{1}}\n\nదానిని AMClubలో చదవడానికి కింది బటన్‌ను నొక్కండి.',
    ta: 'AMClub: ஒரு ஆர்டரில் உங்களுக்குப் புதிய செய்தி வந்துள்ளது.\n\n{{1}}\n\nஅதை AMClub-இல் படிக்க கீழே உள்ள பொத்தானைத் தட்டவும்.',
  }, ['title'], { title: 'New message on order #A1B2', link: '/app/orders/9d1c2f0e' }, urlButton(BTN_ORDER)),

  // ── requests and quotes ──
  rfq_matched: notice('amc_rfq_matched', {
    en: 'AMClub: a new request matches your services.',
    hi: 'AMClub: एक नई रिक्वेस्ट आपकी सेवाओं से मेल खाती है।',
    te: 'AMClub: ఒక కొత్త రిక్వెస్ట్ మీ సేవలకు సరిపోతుంది.',
    ta: 'AMClub: ஒரு புதிய கோரிக்கை உங்கள் சேவைகளுடன் பொருந்துகிறது.',
  }, TAIL_REQUEST, BTN_REQUEST, EX_PROVIDER_RFQ),
  rfq_new_quote: notice('amc_rfq_new_quote', {
    en: 'AMClub: you received a new quote on your request.',
    hi: 'AMClub: आपकी रिक्वेस्ट पर एक नया कोटेशन आया है।',
    te: 'AMClub: మీ రిక్వెస్ట్‌పై కొత్త కొటేషన్ వచ్చింది.',
    ta: 'AMClub: உங்கள் கோரிக்கைக்கு ஒரு புதிய விலைப்புள்ளி வந்துள்ளது.',
  }, TAIL_REQUEST, BTN_REQUEST, EX_RFQ),
  rfq_providers_unavailable: notice('amc_rfq_unavailable', {
    en: 'AMClub: no provider is available for your request right now.',
    hi: 'AMClub: अभी आपकी रिक्वेस्ट के लिए कोई प्रदाता उपलब्ध नहीं है।',
    te: 'AMClub: ప్రస్తుతం మీ రిక్వెస్ట్‌కు ప్రొవైడర్ అందుబాటులో లేరు.',
    ta: 'AMClub: இப்போது உங்கள் கோரிக்கைக்கு எந்த வழங்குநரும் கிடைக்கவில்லை.',
  }, TAIL_REQUEST, BTN_REQUEST, EX_RFQ),
  quote_accepted: notice('amc_quote_accepted', {
    en: 'AMClub: the buyer accepted your quote.',
    hi: 'AMClub: खरीदार ने आपका कोटेशन स्वीकार किया है।',
    te: 'AMClub: కొనుగోలుదారు మీ కొటేషన్‌ను అంగీకరించారు.',
    ta: 'AMClub: வாங்குபவர் உங்கள் விலைப்புள்ளியை ஏற்றுக்கொண்டார்.',
  }, TAIL_REQUEST, BTN_REQUEST, EX_PROVIDER_RFQ),
  quote_declined: notice('amc_quote_declined', {
    en: 'AMClub: the buyer declined your quote.',
    hi: 'AMClub: खरीदार ने आपका कोटेशन अस्वीकार किया है।',
    te: 'AMClub: కొనుగోలుదారు మీ కొటేషన్‌ను తిరస్కరించారు.',
    ta: 'AMClub: வாங்குபவர் உங்கள் விலைப்புள்ளியை நிராகரித்தார்.',
  }, TAIL_REQUEST, BTN_REQUEST, EX_PROVIDER_RFQ),
  quote_message: notice('amc_quote_message', {
    en: 'AMClub: there is a new message about a quote.',
    hi: 'AMClub: एक कोटेशन पर नया संदेश आया है।',
    te: 'AMClub: ఒక కొటేషన్‌పై కొత్త సందేశం వచ్చింది.',
    ta: 'AMClub: ஒரு விலைப்புள்ளி பற்றி புதிய செய்தி வந்துள்ளது.',
  }, TAIL_REQUEST, BTN_REQUEST, EX_RFQ),
  rfq_question: notice('amc_rfq_question', {
    en: 'AMClub: a provider asked a question about your request.',
    hi: 'AMClub: एक प्रदाता ने आपकी रिक्वेस्ट के बारे में सवाल पूछा है।',
    te: 'AMClub: ఒక ప్రొవైడర్ మీ రిక్వెస్ట్ గురించి ప్రశ్న అడిగారు.',
    ta: 'AMClub: ஒரு வழங்குநர் உங்கள் கோரிக்கை பற்றி கேள்வி கேட்டுள்ளார்.',
  }, TAIL_REQUEST, BTN_REQUEST, EX_RFQ),
  rfq_answer: notice('amc_rfq_answer', {
    en: 'AMClub: the buyer answered a question on a request.',
    hi: 'AMClub: खरीदार ने एक रिक्वेस्ट पर सवाल का जवाब दिया है।',
    te: 'AMClub: కొనుగోలుదారు ఒక రిక్వెస్ట్‌పై ప్రశ్నకు సమాధానం ఇచ్చారు.',
    ta: 'AMClub: வாங்குபவர் ஒரு கோரிக்கையின் கேள்விக்குப் பதிலளித்துள்ளார்.',
  }, TAIL_REQUEST, BTN_REQUEST, EX_PROVIDER_RFQ),
  quote_revised: notice('amc_quote_revised', {
    en: 'AMClub: a provider revised their quote on your request.',
    hi: 'AMClub: एक प्रदाता ने आपकी रिक्वेस्ट पर अपना कोटेशन बदला है।',
    te: 'AMClub: ఒక ప్రొవైడర్ మీ రిక్వెస్ట్‌పై తమ కొటేషన్‌ను సవరించారు.',
    ta: 'AMClub: ஒரு வழங்குநர் உங்கள் கோரிக்கையில் தங்கள் விலைப்புள்ளியைத் திருத்தியுள்ளார்.',
  }, TAIL_REQUEST, BTN_REQUEST, EX_RFQ),

  // ── money ──
  payout_paid: notice('amc_payout_paid', {
    en: 'AMClub: a payout was sent to your bank account.',
    hi: 'AMClub: आपके बैंक खाते में भुगतान भेजा गया है।',
    te: 'AMClub: మీ బ్యాంక్ ఖాతాకు చెల్లింపు పంపబడింది.',
    ta: 'AMClub: உங்கள் வங்கிக் கணக்கிற்கு பணம் அனுப்பப்பட்டது.',
  }, TAIL_DETAILS, BTN_DETAILS, { title: 'Payout for order AMC-2417', body: '₹4,720.00 sent, UTR AXIS00012345.', link: '/partner/orders/9d1c2f0e' }),

  // ── disputes and ops (ops kinds go to the ops user's own opted-in phone) ──
  dispute_statement: notice('amc_dispute_statement', {
    en: 'AMClub: a statement was added to an open issue on an order.',
    hi: 'AMClub: एक ऑर्डर की खुली समस्या में बयान जोड़ा गया है।',
    te: 'AMClub: ఒక ఆర్డర్‌ సమస్యలో ఒక వివరణ జోడించబడింది.',
    ta: 'AMClub: ஒரு ஆர்டர் சிக்கலில் ஒரு விளக்கம் சேர்க்கப்பட்டது.',
  }, TAIL_ORDER, BTN_ORDER, EX_ORDER),
  dispute_triage_ready: notice('amc_dispute_triage_ready', {
    en: 'AMClub ops: a dispute summary is ready for review.',
    hi: 'AMClub ऑप्स: एक विवाद का सारांश समीक्षा के लिए तैयार है।',
    te: 'AMClub ఆప్స్: ఒక వివాద సారాంశం సమీక్షకు సిద్ధంగా ఉంది.',
    ta: 'AMClub ஆப்ஸ்: ஒரு சர்ச்சை சுருக்கம் மதிப்பாய்வுக்குத் தயாராக உள்ளது.',
  }, TAIL_DETAILS, BTN_DETAILS, { title: 'Dispute on AMC-2417', body: 'Both statements are in; the summary is ready.', link: '/admin/disputes/1f2e3d4c' }),
  payout_dossier_ready: notice('amc_payout_dossier_ready', {
    en: 'AMClub ops: a payout evidence file is ready for your decision.',
    hi: 'AMClub ऑप्स: एक भुगतान साक्ष्य फ़ाइल आपके निर्णय के लिए तैयार है।',
    te: 'AMClub ఆప్స్: ఒక చెల్లింపు సాక్ష్య ఫైల్ మీ నిర్ణయానికి సిద్ధంగా ఉంది.',
    ta: 'AMClub ஆப்ஸ்: ஒரு பணப்பரிமாற்ற ஆதாரக் கோப்பு உங்கள் முடிவுக்குத் தயாராக உள்ளது.',
  }, TAIL_DETAILS, BTN_DETAILS, { title: 'Payout for AMC-2417 on hold', body: 'Evidence checked; approve or hold on the web.', link: '/admin/payouts?dossier=7a8b9c0d' }),

  // ── S2.3 Support (the model never writes these; replies are shared copy) ──
  // support_reply: the out-of-window carrier for a support answer. values title (first line) / body (the reply).
  support_reply: fixed('amc_support_reply', {
    en: 'AMClub support has replied to your message.\n\nSubject: {{1}}\nReply: {{2}}\n\nReply to this message if you need more help.',
    hi: 'AMClub सहायता ने आपके संदेश का जवाब दिया है।\n\nविषय: {{1}}\nजवाब: {{2}}\n\nऔर मदद चाहिए तो इस संदेश का जवाब दें।',
    te: 'AMClub సహాయ బృందం మీ సందేశానికి సమాధానం ఇచ్చింది.\n\nవిషయం: {{1}}\nసమాధానం: {{2}}\n\nమరింత సహాయం కావాలంటే ఈ సందేశానికి జవాబు ఇవ్వండి.',
    ta: 'AMClub உதவிக் குழு உங்கள் செய்திக்குப் பதிலளித்துள்ளது.\n\nதலைப்பு: {{1}}\nபதில்: {{2}}\n\nமேலும் உதவி தேவைப்பட்டால் இந்தச் செய்திக்குப் பதிலளிக்கவும்.',
  }, ['title', 'body'], { title: 'Your order AMC-2417', body: 'It is in progress; the provider expects to deliver by 14 Oct.' }),
  support_escalated: fixed('amc_support_escalated', {
    en: 'AMClub support: your message has been passed to our team.\n\nStatus: {{1}}\n\nWe will reply here or in the AMClub app.',
    hi: 'AMClub सहायता: आपका संदेश हमारी टीम को भेज दिया गया है।\n\nस्थिति: {{1}}\n\nहम यहाँ या AMClub ऐप में जवाब देंगे।',
    te: 'AMClub సహాయం: మీ సందేశం మా బృందానికి పంపబడింది.\n\nస్థితి: {{1}}\n\nమేము ఇక్కడ లేదా AMClub యాప్‌లో సమాధానం ఇస్తాము.',
    ta: 'AMClub உதவி: உங்கள் செய்தி எங்கள் குழுவிற்கு அனுப்பப்பட்டுள்ளது.\n\nநிலை: {{1}}\n\nநாங்கள் இங்கே அல்லது AMClub செயலியில் பதிலளிப்போம்.',
  }, ['title'], { title: 'A person will contact you (T-8F3A)', link: '/app/support' }, urlButton(BTN_DETAILS)),
  support_ticket_opened: fixed('amc_support_ticket_opened', {
    en: 'AMClub ops: a new support ticket needs attention.\n\nSummary: {{1}}\n\nOpen the support queue to respond.',
    hi: 'AMClub ऑप्स: एक नए सपोर्ट टिकट पर ध्यान देना है।\n\nसारांश: {{1}}\n\nजवाब देने के लिए सपोर्ट कतार खोलें।',
    te: 'AMClub ఆప్స్: ఒక కొత్త సపోర్ట్ టికెట్‌ను చూడాలి.\n\nసారాంశం: {{1}}\n\nస్పందించడానికి సపోర్ట్ క్యూను తెరవండి.',
    ta: 'AMClub ஆப்ஸ்: ஒரு புதிய உதவிச் சீட்டுக்குக் கவனம் தேவை.\n\nசுருக்கம்: {{1}}\n\nபதிலளிக்க உதவி வரிசையைத் திறக்கவும்.',
  }, ['body'], { body: 'Buyer asks why order AMC-2417 is late.', link: '/admin/support?ticket=5e6f7a8b' }, urlButton(BTN_DETAILS)),
  support_resolved: fixed('amc_support_resolved', {
    en: 'AMClub support: your ticket has been resolved.\n\nNote from our team: {{1}}\n\nReply to this message if the problem continues.',
    hi: 'AMClub सहायता: आपका टिकट हल कर दिया गया है।\n\nहमारी टीम का नोट: {{1}}\n\nसमस्या बनी रहे तो इस संदेश का जवाब दें।',
    te: 'AMClub సహాయం: మీ టికెట్ పరిష్కరించబడింది.\n\nమా బృందం గమనిక: {{1}}\n\nసమస్య కొనసాగితే ఈ సందేశానికి జవాబు ఇవ్వండి.',
    ta: 'AMClub உதவி: உங்கள் சீட்டு தீர்க்கப்பட்டது.\n\nஎங்கள் குழுவின் குறிப்பு: {{1}}\n\nசிக்கல் தொடர்ந்தால் இந்தச் செய்திக்குப் பதிலளிக்கவும்.',
  }, ['body'], { body: 'The provider has delivered the files; please check the order.' }),
  order_nudge: fixed('amc_order_nudge', {
    en: 'AMClub: a reminder from the other party on your order.\n\n{{1}}\n\nTap the button below to open the order.',
    hi: 'AMClub: आपके ऑर्डर पर दूसरे पक्ष की ओर से एक रिमाइंडर।\n\n{{1}}\n\nऑर्डर खोलने के लिए नीचे दिया बटन दबाएँ।',
    te: 'AMClub: మీ ఆర్డర్‌పై అవతలి పక్షం నుండి ఒక రిమైండర్.\n\n{{1}}\n\nఆర్డర్‌ను తెరవడానికి కింది బటన్‌ను నొక్కండి.',
    ta: 'AMClub: உங்கள் ஆர்டர் குறித்து மற்றத் தரப்பிடமிருந்து ஒரு நினைவூட்டல்.\n\n{{1}}\n\nஆர்டரைத் திறக்க கீழே உள்ள பொத்தானைத் தட்டவும்.',
  }, ['body'], { body: 'The buyer is waiting for an update on order AMC-2417.', link: '/partner/orders/9d1c2f0e' }, urlButton(BTN_ORDER)),
  rfq_nudge: fixed('amc_rfq_nudge', {
    en: 'AMClub: a reminder about a request you are part of.\n\n{{1}}\n\nTap the button below to open the request.',
    hi: 'AMClub: जिस रिक्वेस्ट से आप जुड़े हैं, उसके बारे में एक रिमाइंडर।\n\n{{1}}\n\nरिक्वेस्ट खोलने के लिए नीचे दिया बटन दबाएँ।',
    te: 'AMClub: మీరు భాగమైన ఒక రిక్వెస్ట్ గురించి రిమైండర్.\n\n{{1}}\n\nరిక్వెస్ట్‌ను తెరవడానికి కింది బటన్‌ను నొక్కండి.',
    ta: 'AMClub: நீங்கள் தொடர்புடைய ஒரு கோரிக்கை பற்றிய நினைவூட்டல்.\n\n{{1}}\n\nகோரிக்கையைத் திறக்க கீழே உள்ள பொத்தானைத் தட்டவும்.',
  }, ['body'], { body: 'The buyer is waiting for quotes on "GST registration for a new shop".', link: '/partner/rfqs/4b7e11aa' }, urlButton(BTN_REQUEST)),

  // ── S2.2 / S2.4 Digital Munshi (provider; purpose assistant) ──
  munshi_draft: fixed('amc_munshi_draft', {
    en: 'AMClub assistant: a draft quote is ready for the request "{{1}}" at {{2}}.\n\nOpen AMClub to approve, edit or skip it. Nothing is sent to the buyer without your approval.',
    hi: 'AMClub असिस्टेंट: रिक्वेस्ट "{{1}}" के लिए {{2}} का ड्राफ्ट कोटेशन तैयार है।\n\nइसे मंज़ूर करने, बदलने या छोड़ने के लिए AMClub खोलें। आपकी मंज़ूरी के बिना खरीदार को कुछ नहीं भेजा जाता।',
    te: 'AMClub అసిస్టెంట్: రిక్వెస్ట్ "{{1}}" కోసం {{2}} ధరతో డ్రాఫ్ట్ కొటేషన్ సిద్ధంగా ఉంది.\n\nదానిని ఆమోదించడానికి, మార్చడానికి లేదా వదిలేయడానికి AMClub తెరవండి. మీ ఆమోదం లేకుండా కొనుగోలుదారుకు ఏదీ పంపబడదు.',
    ta: 'AMClub உதவியாளர்: "{{1}}" கோரிக்கைக்கு {{2}} விலையில் வரைவு விலைப்புள்ளி தயாராக உள்ளது.\n\nஅதை ஒப்புக்கொள்ள, மாற்ற அல்லது தவிர்க்க AMClub-ஐத் திறக்கவும். உங்கள் ஒப்புதல் இல்லாமல் வாங்குபவருக்கு எதுவும் அனுப்பப்படாது.',
  }, ['title', 'price'], { title: 'GST registration for a new shop', price: '₹3,500 · 5d' }),
  munshi_window_warning: fixed('amc_munshi_window_warning', {
    en: 'AMClub assistant: the quote window for the request "{{1}}" closes in about {{2}} hours.\n\nOpen AMClub to send or skip your quote.',
    hi: 'AMClub असिस्टेंट: रिक्वेस्ट "{{1}}" पर कोटेशन भेजने का समय लगभग {{2}} घंटे में खत्म होगा।\n\nकोटेशन भेजने या छोड़ने के लिए AMClub खोलें।',
    te: 'AMClub అసిస్టెంట్: రిక్వెస్ట్ "{{1}}"కు కొటేషన్ పంపే సమయం సుమారు {{2}} గంటల్లో ముగుస్తుంది.\n\nకొటేషన్ పంపడానికి లేదా వదిలేయడానికి AMClub తెరవండి.',
    ta: 'AMClub உதவியாளர்: "{{1}}" கோரிக்கைக்கான விலைப்புள்ளி நேரம் சுமார் {{2}} மணி நேரத்தில் முடிவடையும்.\n\nவிலைப்புள்ளியை அனுப்ப அல்லது தவிர்க்க AMClub-ஐத் திறக்கவும்.',
  }, ['title', 'hours'], { title: 'GST registration for a new shop', hours: '6' }),
  munshi_reply_draft: fixed('amc_munshi_reply_draft', {
    en: 'AMClub assistant: a draft reply is ready for the buyer\'s message on "{{1}}".\n\nOpen AMClub to approve, edit or skip it. Nothing is sent without your approval.',
    hi: 'AMClub असिस्टेंट: "{{1}}" पर खरीदार के संदेश का ड्राफ्ट जवाब तैयार है।\n\nइसे मंज़ूर करने, बदलने या छोड़ने के लिए AMClub खोलें। आपकी मंज़ूरी के बिना कुछ नहीं भेजा जाता।',
    te: 'AMClub అసిస్టెంట్: "{{1}}"పై కొనుగోలుదారు సందేశానికి డ్రాఫ్ట్ సమాధానం సిద్ధంగా ఉంది.\n\nదానిని ఆమోదించడానికి, మార్చడానికి లేదా వదిలేయడానికి AMClub తెరవండి. మీ ఆమోదం లేకుండా ఏదీ పంపబడదు.',
    ta: 'AMClub உதவியாளர்: "{{1}}" பற்றிய வாங்குபவரின் செய்திக்கு வரைவுப் பதில் தயாராக உள்ளது.\n\nஅதை ஒப்புக்கொள்ள, மாற்ற அல்லது தவிர்க்க AMClub-ஐத் திறக்கவும். உங்கள் ஒப்புதல் இல்லாமல் எதுவும் அனுப்பப்படாது.',
  }, ['title'], { title: 'GST registration for a new shop' }),
  munshi_result: fixed('amc_munshi_result', {
    en: 'AMClub assistant update on your draft:\n\n{{1}}\n\nOpen AMClub for the details.',
    hi: 'आपके ड्राफ्ट पर AMClub असिस्टेंट का अपडेट:\n\n{{1}}\n\nविवरण के लिए AMClub खोलें।',
    te: 'మీ డ్రాఫ్ట్‌పై AMClub అసిస్టెంట్ అప్‌డేట్:\n\n{{1}}\n\nవివరాల కోసం AMClub తెరవండి.',
    ta: 'உங்கள் வரைவு குறித்து AMClub உதவியாளரின் புதுப்பிப்பு:\n\n{{1}}\n\nவிவரங்களுக்கு AMClub-ஐத் திறக்கவும்.',
  }, ['line'], { line: 'Your quote was sent to the buyer.' }),
  // Reworded (ADR-030): a "grow your business" nudge is marketing to Meta; the fixed text is now a weekly note about
  // the provider's own account. The line itself is fixed shared copy (growthNudgeLine), never model text.
  munshi_growth: fixed('amc_munshi_growth', {
    en: 'AMClub weekly account note for your provider profile:\n\n{{1}}\n\nOpen your AMClub provider profile for the details.',
    hi: 'आपकी प्रदाता प्रोफ़ाइल के लिए AMClub का साप्ताहिक खाता नोट:\n\n{{1}}\n\nविवरण के लिए अपनी AMClub प्रदाता प्रोफ़ाइल खोलें।',
    te: 'మీ ప్రొవైడర్ ప్రొఫైల్‌కు AMClub వారపు ఖాతా గమనిక:\n\n{{1}}\n\nవివరాల కోసం మీ AMClub ప్రొవైడర్ ప్రొఫైల్ తెరవండి.',
    ta: 'உங்கள் வழங்குநர் சுயவிவரத்திற்கான AMClub வாராந்திரக் கணக்குக் குறிப்பு:\n\n{{1}}\n\nவிவரங்களுக்கு உங்கள் AMClub வழங்குநர் சுயவிவரத்தைத் திறக்கவும்.',
  }, ['line'], { line: 'Your GSTIN is not verified yet.' }),

  // ── S3.1 the procurement agent outside the window (buyer; purpose assistant): one line + the assistant link ──
  procurement_update: fixed('amc_procurement_update', {
    en: 'AMClub assistant, about your request:\n\n{{1}}\n\nTap the button below to continue in the assistant.',
    hi: 'आपकी रिक्वेस्ट के बारे में AMClub असिस्टेंट:\n\n{{1}}\n\nअसिस्टेंट में आगे बढ़ने के लिए नीचे दिया बटन दबाएँ।',
    te: 'మీ రిక్వెస్ట్ గురించి AMClub అసిస్టెంట్:\n\n{{1}}\n\nఅసిస్టెంట్‌లో కొనసాగడానికి కింది బటన్‌ను నొక్కండి.',
    ta: 'உங்கள் கோரிக்கை பற்றி AMClub உதவியாளர்:\n\n{{1}}\n\nஉதவியாளரில் தொடர கீழே உள்ள பொத்தானைத் தட்டவும்.',
  }, ['line'], { line: 'Three quotes are in for your GST registration request.', link: '/app/assistant' }, urlButton(BTN_ASSISTANT, 'app/assistant')),

  // ── S1.6 the onboarding interview (provider; purpose assistant) ──
  onboarding_start: fixed('amc_onboarding_start', {
    en: 'Hello {{1}}, this is the AMClub assistant. Your provider profile interview has started.\n\nReply to this message to continue.',
    hi: 'नमस्ते {{1}}, मैं AMClub असिस्टेंट हूँ। आपकी प्रदाता प्रोफ़ाइल का इंटरव्यू शुरू हो गया है।\n\nआगे बढ़ने के लिए इस संदेश का जवाब दें।',
    te: 'నమస్తే {{1}}, నేను AMClub అసిస్టెంట్. మీ ప్రొవైడర్ ప్రొఫైల్ ఇంటర్వ్యూ మొదలైంది.\n\nకొనసాగడానికి ఈ సందేశానికి జవాబు ఇవ్వండి.',
    ta: 'வணக்கம் {{1}}, நான் AMClub உதவியாளர். உங்கள் வழங்குநர் சுயவிவர நேர்காணல் தொடங்கியது.\n\nதொடர இந்தச் செய்திக்குப் பதிலளிக்கவும்.',
  }, ['name'], { name: 'Ravi' }),
  onboarding_resume: fixed('amc_onboarding_resume', {
    en: 'AMClub assistant: your provider profile interview is waiting at "{{1}}".\n\nReply to this message to continue here, or tap the button below to continue on the web.',
    hi: 'AMClub असिस्टेंट: आपकी प्रदाता प्रोफ़ाइल का इंटरव्यू "{{1}}" पर रुका है।\n\nयहीं जारी रखने के लिए इस संदेश का जवाब दें, या वेब पर जारी रखने के लिए नीचे दिया बटन दबाएँ।',
    te: 'AMClub అసిస్టెంట్: మీ ప్రొవైడర్ ప్రొఫైల్ ఇంటర్వ్యూ "{{1}}" వద్ద ఆగి ఉంది.\n\nఇక్కడే కొనసాగడానికి ఈ సందేశానికి జవాబు ఇవ్వండి, లేదా వెబ్‌లో కొనసాగడానికి కింది బటన్‌ను నొక్కండి.',
    ta: 'AMClub உதவியாளர்: உங்கள் வழங்குநர் சுயவிவர நேர்காணல் "{{1}}" இல் காத்திருக்கிறது.\n\nஇங்கேயே தொடர இந்தச் செய்திக்குப் பதிலளிக்கவும், அல்லது இணையத்தில் தொடர கீழே உள்ள பொத்தானைத் தட்டவும்.',
  }, ['step'], { step: 'Your services', link: '/partner/onboarding?session=2c3d4e5f' }, urlButton(BTN_CONTINUE, 'partner/onboarding')),
  onboarding_draft_ready: fixed('amc_onboarding_draft_ready', {
    en: 'AMClub assistant: the draft provider profile for {{1}} is ready.\n\nReply to this message to review and confirm it.',
    hi: 'AMClub असिस्टेंट: {{1}} की ड्राफ्ट प्रदाता प्रोफ़ाइल तैयार है।\n\nइसे देखने और पुष्टि करने के लिए इस संदेश का जवाब दें।',
    te: 'AMClub అసిస్టెంట్: {{1}} కోసం డ్రాఫ్ట్ ప్రొవైడర్ ప్రొఫైల్ సిద్ధంగా ఉంది.\n\nదానిని చూసి నిర్ధారించడానికి ఈ సందేశానికి జవాబు ఇవ్వండి.',
    ta: 'AMClub உதவியாளர்: {{1}}-க்கான வரைவு வழங்குநர் சுயவிவரம் தயாராக உள்ளது.\n\nஅதைப் பார்த்து உறுதிப்படுத்த இந்தச் செய்திக்குப் பதிலளிக்கவும்.',
  }, ['name'], { name: 'Ravi Tax Consultants' }),
  onboarding_expired: fixed('amc_onboarding_expired', {
    en: 'AMClub assistant: your provider profile interview on WhatsApp has timed out.\n\nTap the button below to finish your profile on the web.',
    hi: 'AMClub असिस्टेंट: WhatsApp पर आपकी प्रदाता प्रोफ़ाइल के इंटरव्यू का समय समाप्त हो गया है।\n\nवेब पर प्रोफ़ाइल पूरी करने के लिए नीचे दिया बटन दबाएँ।',
    te: 'AMClub అసిస్టెంట్: WhatsAppలో మీ ప్రొవైడర్ ప్రొఫైల్ ఇంటర్వ్యూ సమయం ముగిసింది.\n\nవెబ్‌లో మీ ప్రొఫైల్ పూర్తి చేయడానికి కింది బటన్‌ను నొక్కండి.',
    ta: 'AMClub உதவியாளர்: WhatsApp-இல் உங்கள் வழங்குநர் சுயவிவர நேர்காணலின் நேரம் முடிந்தது.\n\nஇணையத்தில் உங்கள் சுயவிவரத்தை முடிக்க கீழே உள்ள பொத்தானைத் தட்டவும்.',
  }, [], { link: '/partner/onboarding?session=2c3d4e5f' }, urlButton(BTN_CONTINUE, 'partner/onboarding')),
  // Reworded (ADR-030): "Your profile is 2 steps from done — finish now" is a re-engagement nudge; the fixed text now
  // states the application's status (saved, not submitted) and links to it.
  onboarding_stalled: fixed('amc_onboarding_stalled', {
    en: 'AMClub: your provider application is saved but not submitted yet.\n\nStatus: {{1}}\n\nTap the button below to open your application.',
    hi: 'AMClub: आपका प्रदाता आवेदन सेव है, पर अभी जमा नहीं हुआ है।\n\nस्थिति: {{1}}\n\nअपना आवेदन खोलने के लिए नीचे दिया बटन दबाएँ।',
    te: 'AMClub: మీ ప్రొవైడర్ దరఖాస్తు సేవ్ అయింది, కానీ ఇంకా సమర్పించలేదు.\n\nస్థితి: {{1}}\n\nమీ దరఖాస్తును తెరవడానికి కింది బటన్‌ను నొక్కండి.',
    ta: 'AMClub: உங்கள் வழங்குநர் விண்ணப்பம் சேமிக்கப்பட்டுள்ளது, ஆனால் இன்னும் சமர்ப்பிக்கப்படவில்லை.\n\nநிலை: {{1}}\n\nஉங்கள் விண்ணப்பத்தைத் திறக்க கீழே உள்ள பொத்தானைத் தட்டவும்.',
  }, ['title'], { title: '2 steps left: bank details and documents', link: '/partner/onboarding?step=bank' }, urlButton(BTN_APPLICATION, 'partner/onboarding')),

  // ── E9b licence reminders (buyer; dark behind obligations_enabled) ──
  // Reworded (ADR-030): "Renew with a verified provider" sells a service; the fixed text is now a reminder about a
  // licence the buyer saved, and the button should open that licence (the web passes the link).
  licence_renewal_due: fixed('amc_licence_renewal_due', {
    en: 'AMClub reminder for a licence saved in your account:\n\n{{1}}\n\nTap the button below for the details.',
    hi: 'आपके खाते में सेव किए गए एक लाइसेंस के लिए AMClub रिमाइंडर:\n\n{{1}}\n\nविवरण के लिए नीचे दिया बटन दबाएँ।',
    te: 'మీ ఖాతాలో సేవ్ చేసిన ఒక లైసెన్స్ కోసం AMClub రిమైండర్:\n\n{{1}}\n\nవివరాల కోసం కింది బటన్‌ను నొక్కండి.',
    ta: 'உங்கள் கணக்கில் சேமிக்கப்பட்ட ஒரு உரிமத்திற்கான AMClub நினைவூட்டல்:\n\n{{1}}\n\nவிவரங்களுக்கு கீழே உள்ள பொத்தானைத் தட்டவும்.',
  }, ['title'], { title: 'Your FSSAI licence expires on 14 Nov', link: '/app/licences' }, urlButton(BTN_DETAILS)),
}

/** Every template: the ones above, the notification kinds (templates-notify.ts) and the system kinds (templates-system.ts). */
export const WA_TEMPLATES: WaTemplateRegistry = { ...CORE_TEMPLATES, ...NOTIFY_TEMPLATES, ...SYSTEM_TEMPLATES }

export interface ResolvedTemplate {
  /** The Meta template name that exists for `language`. */
  name: string
  /** The Meta language code it was approved under. */
  language: string
  /** The locale whose body is sent (the requested one, or en). */
  locale: WaLocale
  category: WaTemplateCategory
  spec: WaTemplateSpec
}

/**
 * (kind, locale) → the (name, language) pair that exists. The locale's variant only when it was submitted
 * (`spec.locales` and a body); otherwise the en name WITH the en language code — never an en name under another
 * language code (audit B2: Meta addresses a template by name AND language). Unknown kind → null.
 */
export function resolveTemplate(kind: string, locale: WaLocale, registry: WaTemplateRegistry = WA_TEMPLATES): ResolvedTemplate | null {
  const spec = registry[kind]
  if (!spec) return null
  const loc: WaLocale = spec.locales.includes(locale) && typeof spec.body[locale] === 'string' ? locale : 'en'
  return { name: `${spec.stem}_${loc}`, language: WA_TEMPLATE_LANGUAGE[loc], locale: loc, category: spec.category, spec }
}

/** The send's variable parts for a resolved template: ordered body params, the URL-button suffix, quick replies. */
export function templateComponents(spec: WaTemplateSpec, values: WaTemplateValues): WaTemplateComponents {
  return {
    body: spec.params(values),
    urlButton: spec.urlButton ? { index: 0, suffix: spec.urlButton.suffix(values) ?? WA_DEFAULT_LINK_SUFFIX } : null,
    ...(spec.quickReplies?.length ? { quickReplies: spec.quickReplies.map((q, i) => ({ index: i + (spec.urlButton ? 1 : 0), payload: q.id })) } : {}),
  }
}

/**
 * @deprecated Use `resolveTemplate` (it also returns the language code). Kept for callers outside the transport
 * (apps/web/lib/notifications/channels.ts, verify-onboarding) until they move to `sendWhatsApp`.
 */
export function templateFor(kind: string, locale: WaLocale): ResolvedTemplate | null {
  return resolveTemplate(kind, locale)
}

/** Every approved template name (stem × submitted locale), for the checklist and the eval. */
export function allTemplateNames(registry: WaTemplateRegistry = WA_TEMPLATES): string[] {
  const out = new Set<string>()
  for (const spec of Object.values(registry)) for (const l of spec.locales) if (spec.body[l]) out.add(`${spec.stem}_${l}`)
  return [...out].sort()
}

/** One row of the approval list (PRE_LAUNCH_CHECKLIST 1.3): what is submitted to Meta for one (name, language). */
export interface WaTemplateApprovalRow {
  kind: string
  name: string
  language: string
  category: WaTemplateCategory
  body: string
  /** The body filled with the spec's example values (Meta asks for samples). */
  sample: string
  button: { type: 'url'; label: string; url: string; example: string } | null
  quickReplies: string[]
}

export function templateApprovalList(registry: WaTemplateRegistry = WA_TEMPLATES): WaTemplateApprovalRow[] {
  const rows: WaTemplateApprovalRow[] = []
  for (const kind of Object.keys(registry).sort()) {
    const spec = registry[kind]!
    for (const l of spec.locales) {
      const body = spec.body[l]
      if (!body) continue
      const ex = spec.example ?? {}
      const params = spec.params(ex)
      const sample = body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => params[Number(n) - 1] || `{{${n}}}`)
      rows.push({
        kind,
        name: `${spec.stem}_${l}`,
        language: WA_TEMPLATE_LANGUAGE[l],
        category: spec.category,
        body,
        sample,
        button: spec.urlButton
          ? { type: 'url', label: spec.urlButton.label[l] ?? spec.urlButton.label.en, url: `${WA_URL_BUTTON_BASE}{{1}}`, example: spec.urlButton.suffix(ex) ?? WA_DEFAULT_LINK_SUFFIX }
          : null,
        quickReplies: (spec.quickReplies ?? []).map((q) => q.label[l] ?? q.label.en),
      })
    }
  }
  return rows
}

// ── deprecated keyword sets (shared `classifyWaKeyword` replaces them; audit B4) ──────────────────────────────────
// Kept only while apps/agent-runtime/src/whatsapp/inbound.ts (the dispatcher) and verify-onboarding still import them.

/** @deprecated Greetings are not consent (audit B4). Use shared `classifyWaKeyword`. */
export const WA_OPT_IN_KEYWORDS: ReadonlySet<string> = new Set([
  'start', 'yes', 'ok', 'hi', 'hello', 'namaste',
  'शुरू', 'हाँ', 'हां', 'नमस्ते',
  'ప్రారంభం', 'అవును', 'నమస్తే',
])
/** @deprecated Use shared `classifyWaKeyword` (intent `join`). */
export const ONBOARDING_KEYWORDS: ReadonlySet<string> = new Set(['join', 'onboard', 'जुड़ें', 'చేరండి'])
/** @deprecated "no" / "cancel" are not an opt-out (audit B4). Use shared `classifyWaKeyword`. */
export const WA_OPT_OUT_KEYWORDS: ReadonlySet<string> = new Set([
  'stop', 'unsubscribe', 'no', 'cancel',
  'बंद', 'रोकें', 'नहीं',
  'ఆపు', 'వద్దు',
])
/** @deprecated Use shared `classifyWaKeyword`. */
export function classifyKeyword(text: string | null): 'opt_in' | 'opt_out' | 'onboard' | null {
  if (!text) return null
  const t = text.trim().toLowerCase().normalize('NFKC')
  if (WA_OPT_OUT_KEYWORDS.has(t)) return 'opt_out'
  if (ONBOARDING_KEYWORDS.has(t)) return 'onboard'
  if (WA_OPT_IN_KEYWORDS.has(t)) return 'opt_in'
  return null
}

/**
 * @deprecated ADR-030 §2: consent decides — every business-initiated WhatsApp needs the purpose's opt-in, so no kind
 * is sendable without it. Always empty; kept only so apps/web/lib/notifications/channels.ts compiles until it sends
 * through `sendWhatsApp`.
 */
export const WA_ALWAYS_ALLOWED_KINDS: ReadonlySet<string> = new Set()
