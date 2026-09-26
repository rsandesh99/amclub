import { WA_LOCALES, type WaLocale } from './whatsapp'

/**
 * ADR-030 §2 — every line the WhatsApp runtime sends on its own, without a model: the consent confirmations, the HELP
 * menu for everyone, the language switch, the data-request receipt, the recycled-number check. en / hi are reviewed;
 * te / ta are machine drafts — NATIVE REVIEW PENDING (the same rule as the app's te / ta drafts). The approved
 * templates for the lines that may go outside the 24-hour window are built from this copy in agent-core
 * `templates-system.ts`, so changing a line there means re-submitting that template to Meta.
 *
 * Button payloads are ours and are classified by id, never by their visible title: `wa:start`, `wa:stop`,
 * `wa:menu:<item>`, `wa:lang:<locale>`.
 */

export const WA_COPY_REVIEW: Record<WaLocale, 'reviewed' | 'native_review_pending'> = {
  en: 'reviewed',
  hi: 'reviewed',
  te: 'native_review_pending',
  ta: 'native_review_pending',
}

/** Mirrors apps/web/lib/legal/grievance.ts (the ONE place these facts live); the consent rig asserts they agree. */
export const WA_HELP_CONTACT = {
  email: 'support@amclub.in',
  phone: '+91 83411 15455',
  grievanceEmail: 'grievance@amclub.in',
  acknowledgeHours: 24,
} as const

// ── payloads ──────────────────────────────────────────────────────────────────

export const WA_MENU_ITEMS = ['open', 'track', 'requests', 'human', 'language', 'signup', 'stop'] as const
export type WaMenuItem = (typeof WA_MENU_ITEMS)[number]

/** The menu a number bound to an account gets, and the one an unknown number gets (no account data to show). */
export const WA_MENU_KNOWN: readonly WaMenuItem[] = ['track', 'requests', 'human', 'language', 'stop']
export const WA_MENU_UNKNOWN: readonly WaMenuItem[] = ['language', 'signup', 'human', 'stop']

export const WA_PAYLOAD_START = 'wa:start'
export const WA_PAYLOAD_STOP = 'wa:stop'
export const waMenuPayload = (item: WaMenuItem): string => `wa:menu:${item}`
export const waLangPayload = (locale: WaLocale): string => `wa:lang:${locale}`

export type WaSystemPayload =
  | { kind: 'start' }
  | { kind: 'stop' }
  | { kind: 'menu'; item: WaMenuItem }
  | { kind: 'lang'; locale: WaLocale }

/** A button payload of ours, or null (another agent's payload, or free text). Case-insensitive, trimmed. */
export function parseWaSystemPayload(payload: string | null | undefined): WaSystemPayload | null {
  const p = String(payload ?? '').trim().toLowerCase()
  if (!p.startsWith('wa:')) return null
  if (p === WA_PAYLOAD_START) return { kind: 'start' }
  if (p === WA_PAYLOAD_STOP) return { kind: 'stop' }
  const menu = /^wa:menu:([a-z]+)$/.exec(p)
  if (menu) return (WA_MENU_ITEMS as readonly string[]).includes(menu[1]!) ? { kind: 'menu', item: menu[1] as WaMenuItem } : null
  const lang = /^wa:lang:([a-z]{2})$/.exec(p)
  if (lang) return (WA_LOCALES as readonly string[]).includes(lang[1]!) ? { kind: 'lang', locale: lang[1] as WaLocale } : null
  return null
}

/** Each language named in itself, for the language list and the "language changed" line. */
export const WA_LANGUAGE_NAMES: Record<WaLocale, string> = { en: 'English', hi: 'हिंदी', te: 'తెలుగు', ta: 'தமிழ்' }

// ── copy ──────────────────────────────────────────────────────────────────────

export const WA_COPY_KEYS = [
  'menu_intro', 'menu_intro_unknown', 'menu_list_label',
  'item_open', 'item_track', 'item_requests', 'item_human', 'item_language', 'item_signup', 'item_stop',
  'button_start', 'button_start_again',
  'track_header', 'track_line', 'track_none', 'track_footer',
  'requests_header', 'requests_line', 'requests_none', 'requests_footer',
  'human_opened', 'human_contact',
  'report_received', 'report_received_unknown',
  'language_pick', 'language_changed',
  'data_received', 'data_what_access', 'data_what_erasure', 'data_unavailable',
  'signup_info', 'share_phone', 'rebind_confirm', 'join_needs_start',
  'opt_in_confirmed', 'opt_in_confirmed_unknown', 'opt_out_confirmed', 'holding',
] as const
export type WaCopyKey = (typeof WA_COPY_KEYS)[number]

type Copy = Record<WaCopyKey, string>

const en: Copy = {
  menu_intro: 'How can I help? Choose an option below.',
  menu_intro_unknown: 'Welcome to AMClub. This number is not linked to an AMClub account yet. Choose an option below.',
  menu_list_label: 'Options',
  item_open: 'Menu',
  item_track: 'Track my order',
  item_requests: 'My requests',
  item_human: 'Talk to a person',
  item_language: 'Language',
  item_signup: 'How to sign up',
  item_stop: 'Stop messages',
  button_start: 'Start',
  button_start_again: 'Start again',
  track_header: 'Your latest orders:',
  track_line: '{order_number}: {status}',
  track_none: 'You have no orders yet.',
  track_footer: 'All your orders: {url}',
  requests_header: 'Your latest requests:',
  requests_line: '{title}: {status}',
  requests_none: 'You have no requests yet.',
  requests_footer: 'All your requests: {url}',
  human_opened: 'Done. A person from our team will reply in this chat. Your reference is {ref}. We reply within {hours} hours.',
  human_contact: 'To talk to a person, email {email} or call {phone}. We reply within {hours} hours.',
  report_received: 'Thank you for reporting this. Your reference is {ref}; our team will look into it. AMClub never asks for your OTP, UPI PIN or card number, and never asks you to pay into a personal account.',
  report_received_unknown: 'Thank you for reporting this; our team will look into it. AMClub never asks for your OTP, UPI PIN or card number, and never asks you to pay into a personal account.',
  language_pick: 'Choose your language.',
  language_changed: 'Language changed to {language}. Reply MENU to see what I can do.',
  data_received: 'We have received your request for {what}. Your reference is {ref}. We will respond by {date}. Reply MENU for more options.',
  data_what_access: 'a copy of your data',
  data_what_erasure: 'deletion of your data',
  data_unavailable: 'We could not record your request here. Please email {email} and we will help you.',
  signup_info: 'Sign up at {url} with this phone number. Then reply START here to get your AMClub updates on WhatsApp.',
  share_phone: 'We cannot see your phone number in this chat, so we cannot link it to an AMClub account. Please message us from a WhatsApp account that shows your phone number, or email {email}.',
  rebind_confirm: 'This number is linked to an AMClub account that has not been used for a while. To confirm it is you, sign in at {url} and then message us again.',
  join_needs_start: 'To set up your AMClub profile here, first allow AMClub to message you on WhatsApp: tap Start, then send JOIN again.',
  opt_in_confirmed: 'You are subscribed to AMClub on WhatsApp: order, request and payment updates, and messages from your AMClub assistant. Reply STOP at any time to stop all WhatsApp messages, or MENU to see options.',
  opt_in_confirmed_unknown: 'You are subscribed to AMClub on WhatsApp. This number is not linked to an AMClub account yet: sign up at {url} with this phone number to get your updates here. Reply STOP at any time to stop all WhatsApp messages.',
  opt_out_confirmed: 'You will not get any more WhatsApp messages from AMClub. Order and payment updates will still reach you by SMS, email and in the app. Reply START to subscribe again.',
  holding: 'Thanks for your message. Reply MENU to see what I can do.',
}

const hi: Copy = {
  menu_intro: 'मैं कैसे मदद करूँ? नीचे से एक विकल्प चुनें।',
  menu_intro_unknown: 'AMClub में आपका स्वागत है। यह नंबर अभी किसी AMClub खाते से जुड़ा नहीं है। नीचे से एक विकल्प चुनें।',
  menu_list_label: 'विकल्प',
  item_open: 'मेनू',
  item_track: 'ऑर्डर ट्रैक करें',
  item_requests: 'मेरी रिक्वेस्ट',
  item_human: 'किसी से बात करें',
  item_language: 'भाषा',
  item_signup: 'साइन अप कैसे करें',
  item_stop: 'संदेश बंद करें',
  button_start: 'शुरू करें',
  button_start_again: 'फिर से शुरू करें',
  track_header: 'आपके हाल के ऑर्डर:',
  track_line: '{order_number}: {status}',
  track_none: 'आपका अभी कोई ऑर्डर नहीं है।',
  track_footer: 'आपके सभी ऑर्डर: {url}',
  requests_header: 'आपकी हाल की रिक्वेस्ट:',
  requests_line: '{title}: {status}',
  requests_none: 'आपकी अभी कोई रिक्वेस्ट नहीं है।',
  requests_footer: 'आपकी सभी रिक्वेस्ट: {url}',
  human_opened: 'हो गया। हमारी टीम का एक व्यक्ति इसी चैट में जवाब देगा। आपका संदर्भ नंबर {ref} है। हम {hours} घंटे के भीतर जवाब देते हैं।',
  human_contact: 'किसी व्यक्ति से बात करने के लिए {email} पर ईमेल करें या {phone} पर कॉल करें। हम {hours} घंटे के भीतर जवाब देते हैं।',
  report_received: 'रिपोर्ट करने के लिए धन्यवाद। आपका संदर्भ नंबर {ref} है; हमारी टीम इसकी जाँच करेगी। AMClub कभी भी आपका OTP, UPI PIN या कार्ड नंबर नहीं माँगता, और कभी किसी निजी खाते में भुगतान करने को नहीं कहता।',
  report_received_unknown: 'रिपोर्ट करने के लिए धन्यवाद; हमारी टीम इसकी जाँच करेगी। AMClub कभी भी आपका OTP, UPI PIN या कार्ड नंबर नहीं माँगता, और कभी किसी निजी खाते में भुगतान करने को नहीं कहता।',
  language_pick: 'अपनी भाषा चुनें।',
  language_changed: 'भाषा बदलकर {language} कर दी गई है। मैं क्या कर सकता हूँ, यह देखने के लिए MENU लिखें।',
  data_received: 'हमें {what} के लिए आपका अनुरोध मिल गया है। आपका संदर्भ नंबर {ref} है। हम {date} तक जवाब देंगे। और विकल्पों के लिए MENU लिखें।',
  data_what_access: 'आपके डेटा की कॉपी',
  data_what_erasure: 'आपका डेटा हटाने',
  data_unavailable: 'हम आपका अनुरोध यहाँ दर्ज नहीं कर सके। कृपया {email} पर ईमेल करें, हम आपकी मदद करेंगे।',
  signup_info: 'इसी फ़ोन नंबर से {url} पर साइन अप करें। फिर WhatsApp पर AMClub के अपडेट पाने के लिए यहाँ START लिखें।',
  share_phone: 'इस चैट में हमें आपका फ़ोन नंबर नहीं दिख रहा, इसलिए हम इसे किसी AMClub खाते से नहीं जोड़ सकते। कृपया ऐसे WhatsApp खाते से संदेश भेजें जिसमें आपका फ़ोन नंबर दिखता हो, या {email} पर ईमेल करें।',
  rebind_confirm: 'यह नंबर एक ऐसे AMClub खाते से जुड़ा है जिसका कुछ समय से उपयोग नहीं हुआ है। यह पुष्टि करने के लिए कि यह आप ही हैं, {url} पर साइन इन करें और फिर हमें दोबारा संदेश भेजें।',
  join_needs_start: 'यहाँ अपनी AMClub प्रोफ़ाइल बनाने के लिए, पहले AMClub को WhatsApp पर संदेश भेजने की अनुमति दें: शुरू करें पर टैप करें, फिर दोबारा JOIN भेजें।',
  opt_in_confirmed: 'आपने WhatsApp पर AMClub की सदस्यता ले ली है: ऑर्डर, रिक्वेस्ट और भुगतान के अपडेट, और आपके AMClub असिस्टेंट के संदेश। सभी WhatsApp संदेश बंद करने के लिए कभी भी STOP लिखें, या विकल्प देखने के लिए MENU लिखें।',
  opt_in_confirmed_unknown: 'आपने WhatsApp पर AMClub की सदस्यता ले ली है। यह नंबर अभी किसी AMClub खाते से जुड़ा नहीं है: अपने अपडेट यहाँ पाने के लिए इसी फ़ोन नंबर से {url} पर साइन अप करें। सभी WhatsApp संदेश बंद करने के लिए कभी भी STOP लिखें।',
  opt_out_confirmed: 'अब आपको AMClub से कोई WhatsApp संदेश नहीं मिलेगा। ऑर्डर और भुगतान के अपडेट SMS, ईमेल और ऐप में मिलते रहेंगे। फिर से सदस्यता लेने के लिए START लिखें।',
  holding: 'आपके संदेश के लिए धन्यवाद। मैं क्या कर सकता हूँ, यह देखने के लिए MENU लिखें।',
}

// te — machine draft, native review pending
const te: Copy = {
  menu_intro: 'నేను ఎలా సహాయం చేయగలను? కింద ఒక ఎంపికను ఎంచుకోండి.',
  menu_intro_unknown: 'AMClub కి స్వాగతం. ఈ నంబర్ ఇంకా ఏ AMClub ఖాతాకు లింక్ కాలేదు. కింద ఒక ఎంపికను ఎంచుకోండి.',
  menu_list_label: 'ఎంపికలు',
  item_open: 'మెనూ',
  item_track: 'ఆర్డర్ ట్రాక్ చేయండి',
  item_requests: 'నా అభ్యర్థనలు',
  item_human: 'వ్యక్తితో మాట్లాడండి',
  item_language: 'భాష',
  item_signup: 'సైన్ అప్ ఎలా చేయాలి',
  item_stop: 'సందేశాలు ఆపండి',
  button_start: 'ప్రారంభించండి',
  button_start_again: 'మళ్లీ ప్రారంభించండి',
  track_header: 'మీ తాజా ఆర్డర్లు:',
  track_line: '{order_number}: {status}',
  track_none: 'మీకు ఇంకా ఆర్డర్లు లేవు.',
  track_footer: 'మీ అన్ని ఆర్డర్లు: {url}',
  requests_header: 'మీ తాజా అభ్యర్థనలు:',
  requests_line: '{title}: {status}',
  requests_none: 'మీకు ఇంకా అభ్యర్థనలు లేవు.',
  requests_footer: 'మీ అన్ని అభ్యర్థనలు: {url}',
  human_opened: 'సరే. మా బృందంలోని ఒక వ్యక్తి ఈ చాట్‌లోనే సమాధానం ఇస్తారు. మీ రిఫరెన్స్ {ref}. మేము {hours} గంటల్లో సమాధానం ఇస్తాము.',
  human_contact: 'ఒక వ్యక్తితో మాట్లాడటానికి {email} కు ఈమెయిల్ చేయండి లేదా {phone} కు కాల్ చేయండి. మేము {hours} గంటల్లో సమాధానం ఇస్తాము.',
  report_received: 'రిపోర్ట్ చేసినందుకు ధన్యవాదాలు. మీ రిఫరెన్స్ {ref}; మా బృందం దీన్ని పరిశీలిస్తుంది. AMClub ఎప్పుడూ మీ OTP, UPI PIN లేదా కార్డ్ నంబర్ అడగదు, వ్యక్తిగత ఖాతాకు చెల్లించమని ఎప్పుడూ అడగదు.',
  report_received_unknown: 'రిపోర్ట్ చేసినందుకు ధన్యవాదాలు; మా బృందం దీన్ని పరిశీలిస్తుంది. AMClub ఎప్పుడూ మీ OTP, UPI PIN లేదా కార్డ్ నంబర్ అడగదు, వ్యక్తిగత ఖాతాకు చెల్లించమని ఎప్పుడూ అడగదు.',
  language_pick: 'మీ భాషను ఎంచుకోండి.',
  language_changed: 'భాష {language} కు మార్చబడింది. నేను ఏమి చేయగలనో చూడటానికి MENU అని పంపండి.',
  data_received: 'మాకు మీ అభ్యర్థన అందింది: {what}. మీ రిఫరెన్స్ {ref}. మేము {date} లోగా సమాధానం ఇస్తాము. మరిన్ని ఎంపికల కోసం MENU అని పంపండి.',
  data_what_access: 'మీ డేటా కాపీ',
  data_what_erasure: 'మీ డేటా తొలగింపు',
  data_unavailable: 'మీ అభ్యర్థనను ఇక్కడ నమోదు చేయలేకపోయాము. దయచేసి {email} కు ఈమెయిల్ చేయండి, మేము సహాయం చేస్తాము.',
  signup_info: 'ఇదే ఫోన్ నంబర్‌తో {url} లో సైన్ అప్ చేయండి. తర్వాత WhatsApp లో AMClub అప్‌డేట్‌లు పొందడానికి ఇక్కడ START అని పంపండి.',
  share_phone: 'ఈ చాట్‌లో మీ ఫోన్ నంబర్ మాకు కనిపించడం లేదు, కాబట్టి దీన్ని AMClub ఖాతాకు లింక్ చేయలేము. మీ ఫోన్ నంబర్ కనిపించే WhatsApp ఖాతా నుండి సందేశం పంపండి, లేదా {email} కు ఈమెయిల్ చేయండి.',
  rebind_confirm: 'ఈ నంబర్ కొంతకాలంగా ఉపయోగించని AMClub ఖాతాకు లింక్ అయి ఉంది. ఇది మీరేనని నిర్ధారించడానికి {url} లో సైన్ ఇన్ చేసి, మళ్లీ మాకు సందేశం పంపండి.',
  join_needs_start: 'ఇక్కడ మీ AMClub ప్రొఫైల్ సెటప్ చేయడానికి, ముందుగా WhatsApp లో మీకు సందేశాలు పంపడానికి AMClub కు అనుమతి ఇవ్వండి: ప్రారంభించండి నొక్కి, తర్వాత మళ్లీ JOIN పంపండి.',
  opt_in_confirmed: 'మీరు WhatsApp లో AMClub కు సబ్‌స్క్రైబ్ అయ్యారు: ఆర్డర్, అభ్యర్థన మరియు చెల్లింపు అప్‌డేట్‌లు, మీ AMClub అసిస్టెంట్ సందేశాలు. అన్ని WhatsApp సందేశాలు ఆపడానికి ఎప్పుడైనా STOP అని, ఎంపికల కోసం MENU అని పంపండి.',
  opt_in_confirmed_unknown: 'మీరు WhatsApp లో AMClub కు సబ్‌స్క్రైబ్ అయ్యారు. ఈ నంబర్ ఇంకా AMClub ఖాతాకు లింక్ కాలేదు: మీ అప్‌డేట్‌లు ఇక్కడ పొందడానికి ఇదే ఫోన్ నంబర్‌తో {url} లో సైన్ అప్ చేయండి. అన్ని WhatsApp సందేశాలు ఆపడానికి ఎప్పుడైనా STOP అని పంపండి.',
  opt_out_confirmed: 'ఇకపై మీకు AMClub నుండి WhatsApp సందేశాలు రావు. ఆర్డర్ మరియు చెల్లింపు అప్‌డేట్‌లు SMS, ఈమెయిల్ మరియు యాప్‌లో వస్తూనే ఉంటాయి. మళ్లీ సబ్‌స్క్రైబ్ చేయడానికి START అని పంపండి.',
  holding: 'మీ సందేశానికి ధన్యవాదాలు. నేను ఏమి చేయగలనో చూడటానికి MENU అని పంపండి.',
}

// ta — machine draft, native review pending
const ta: Copy = {
  menu_intro: 'நான் எப்படி உதவலாம்? கீழே ஒரு விருப்பத்தைத் தேர்ந்தெடுக்கவும்.',
  menu_intro_unknown: 'AMClub-க்கு வரவேற்கிறோம். இந்த எண் இன்னும் எந்த AMClub கணக்குடனும் இணைக்கப்படவில்லை. கீழே ஒரு விருப்பத்தைத் தேர்ந்தெடுக்கவும்.',
  menu_list_label: 'விருப்பங்கள்',
  item_open: 'மெனு',
  item_track: 'ஆர்டரைக் கண்காணி',
  item_requests: 'என் கோரிக்கைகள்',
  item_human: 'ஒருவரிடம் பேசுங்கள்',
  item_language: 'மொழி',
  item_signup: 'பதிவு செய்வது எப்படி',
  item_stop: 'செய்திகளை நிறுத்து',
  button_start: 'தொடங்கு',
  button_start_again: 'மீண்டும் தொடங்கு',
  track_header: 'உங்கள் சமீபத்திய ஆர்டர்கள்:',
  track_line: '{order_number}: {status}',
  track_none: 'உங்களிடம் இன்னும் ஆர்டர்கள் இல்லை.',
  track_footer: 'உங்கள் அனைத்து ஆர்டர்களும்: {url}',
  requests_header: 'உங்கள் சமீபத்திய கோரிக்கைகள்:',
  requests_line: '{title}: {status}',
  requests_none: 'உங்களிடம் இன்னும் கோரிக்கைகள் இல்லை.',
  requests_footer: 'உங்கள் அனைத்து கோரிக்கைகளும்: {url}',
  human_opened: 'சரி. எங்கள் குழுவில் ஒருவர் இதே உரையாடலில் பதில் அளிப்பார். உங்கள் குறிப்பு எண் {ref}. நாங்கள் {hours} மணி நேரத்திற்குள் பதில் அளிப்போம்.',
  human_contact: 'ஒருவரிடம் பேச {email} க்கு மின்னஞ்சல் அனுப்பவும் அல்லது {phone} ஐ அழைக்கவும். நாங்கள் {hours} மணி நேரத்திற்குள் பதில் அளிப்போம்.',
  report_received: 'புகாரளித்ததற்கு நன்றி. உங்கள் குறிப்பு எண் {ref}; எங்கள் குழு இதைப் பார்க்கும். AMClub உங்கள் OTP, UPI PIN அல்லது கார்டு எண்ணை ஒருபோதும் கேட்காது, தனிப்பட்ட கணக்கில் பணம் செலுத்தச் சொல்லாது.',
  report_received_unknown: 'புகாரளித்ததற்கு நன்றி; எங்கள் குழு இதைப் பார்க்கும். AMClub உங்கள் OTP, UPI PIN அல்லது கார்டு எண்ணை ஒருபோதும் கேட்காது, தனிப்பட்ட கணக்கில் பணம் செலுத்தச் சொல்லாது.',
  language_pick: 'உங்கள் மொழியைத் தேர்ந்தெடுக்கவும்.',
  language_changed: 'மொழி {language} ஆக மாற்றப்பட்டது. நான் என்ன செய்ய முடியும் என்பதைப் பார்க்க MENU என அனுப்பவும்.',
  data_received: 'உங்கள் கோரிக்கை கிடைத்தது: {what}. உங்கள் குறிப்பு எண் {ref}. {date} க்குள் பதில் அளிப்போம். மேலும் விருப்பங்களுக்கு MENU என அனுப்பவும்.',
  data_what_access: 'உங்கள் தரவின் நகல்',
  data_what_erasure: 'உங்கள் தரவை நீக்குதல்',
  data_unavailable: 'உங்கள் கோரிக்கையை இங்கே பதிவு செய்ய முடியவில்லை. {email} க்கு மின்னஞ்சல் அனுப்பவும், நாங்கள் உதவுவோம்.',
  signup_info: 'இதே தொலைபேசி எண்ணுடன் {url} இல் பதிவு செய்யவும். பிறகு WhatsApp இல் AMClub புதுப்பிப்புகளைப் பெற இங்கே START என அனுப்பவும்.',
  share_phone: 'இந்த உரையாடலில் உங்கள் தொலைபேசி எண் எங்களுக்குத் தெரியவில்லை, எனவே இதை AMClub கணக்குடன் இணைக்க முடியாது. உங்கள் தொலைபேசி எண் தெரியும் WhatsApp கணக்கிலிருந்து செய்தி அனுப்பவும், அல்லது {email} க்கு மின்னஞ்சல் அனுப்பவும்.',
  rebind_confirm: 'இந்த எண் சிறிது காலமாகப் பயன்படுத்தப்படாத AMClub கணக்குடன் இணைக்கப்பட்டுள்ளது. இது நீங்கள்தான் என்பதை உறுதிப்படுத்த {url} இல் உள்நுழைந்து, பிறகு மீண்டும் செய்தி அனுப்பவும்.',
  join_needs_start: 'இங்கே உங்கள் AMClub சுயவிவரத்தை அமைக்க, முதலில் WhatsApp இல் உங்களுக்குச் செய்தி அனுப்ப AMClub-க்கு அனுமதி கொடுங்கள்: தொடங்கு என்பதைத் தட்டி, பிறகு மீண்டும் JOIN அனுப்பவும்.',
  opt_in_confirmed: 'WhatsApp இல் AMClub-க்கு நீங்கள் பதிவு செய்துள்ளீர்கள்: ஆர்டர், கோரிக்கை மற்றும் கட்டணப் புதுப்பிப்புகள், உங்கள் AMClub உதவியாளரின் செய்திகள். அனைத்து WhatsApp செய்திகளையும் நிறுத்த எப்போது வேண்டுமானாலும் STOP என்றும், விருப்பங்களுக்கு MENU என்றும் அனுப்பவும்.',
  opt_in_confirmed_unknown: 'WhatsApp இல் AMClub-க்கு நீங்கள் பதிவு செய்துள்ளீர்கள். இந்த எண் இன்னும் AMClub கணக்குடன் இணைக்கப்படவில்லை: உங்கள் புதுப்பிப்புகளை இங்கே பெற இதே தொலைபேசி எண்ணுடன் {url} இல் பதிவு செய்யவும். அனைத்து WhatsApp செய்திகளையும் நிறுத்த எப்போது வேண்டுமானாலும் STOP என அனுப்பவும்.',
  opt_out_confirmed: 'இனி AMClub இலிருந்து உங்களுக்கு WhatsApp செய்திகள் வராது. ஆர்டர் மற்றும் கட்டணப் புதுப்பிப்புகள் SMS, மின்னஞ்சல் மற்றும் ஆப்பில் தொடர்ந்து வரும். மீண்டும் பதிவு செய்ய START என அனுப்பவும்.',
  holding: 'உங்கள் செய்திக்கு நன்றி. நான் என்ன செய்ய முடியும் என்பதைப் பார்க்க MENU என அனுப்பவும்.',
}

export const WA_COPY: Record<WaLocale, Copy> = { en, hi, te, ta }

/** Fill `{slots}` in a line; a missing slot renders empty (never a raw placeholder). A missing locale line → en. */
export function waCopy(key: WaCopyKey, locale: WaLocale, slots: Record<string, string | number | null | undefined> = {}): string {
  const line = WA_COPY[locale]?.[key] || WA_COPY.en[key]
  return line.replace(/\{([a-z_]+)\}/g, (_, name: string) => {
    const v = slots[name]
    return v === undefined || v === null ? '' : String(v)
  })
}

/** The `{slot}` names a line uses, in order of first appearance. */
export function waCopySlots(key: WaCopyKey, locale: WaLocale = 'en'): string[] {
  const out: string[] = []
  for (const m of (WA_COPY[locale]?.[key] ?? '').matchAll(/\{([a-z_]+)\}/g)) if (!out.includes(m[1]!)) out.push(m[1]!)
  return out
}

/** Menu rows: the payload id and the visible title (Meta: ≤ 24 characters for a list row, ≤ 20 for a reply button). */
export function waMenuRows(items: readonly WaMenuItem[], locale: WaLocale): Array<{ id: string; title: string }> {
  return items.map((item) => ({ id: waMenuPayload(item), title: waCopy(`item_${item}` as WaCopyKey, locale) }))
}

export function waLanguageRows(): Array<{ id: string; title: string }> {
  return WA_LOCALES.map((l) => ({ id: waLangPayload(l), title: WA_LANGUAGE_NAMES[l] }))
}
