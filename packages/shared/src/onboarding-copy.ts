import { CATEGORIES, CATEGORY_SLUGS, type CategorySlug } from './categories'
import type { OnboardingLocale, OnboardingStep } from './onboarding'

/**
 * Interview copy for the Onboarding agent (S1.6), in en | hi | te, keyed by
 * message id. The runtime renders from this table because next-intl does not
 * exist there; the model never writes a message the provider sees except the
 * draft summary lines, which are rendered from the schema-validated draft.
 * `{name}` tokens are replaced by `onboardingCopy(id, locale, params)`; a
 * test asserts every id exists in all three locales and no `{{` survives.
 */

export type OnboardingCopyId =
  | 'welcome'
  | 'ask_language'
  | 'ask_business_name'
  | 'bad_business_name'
  | 'ask_gstin'
  | 'bad_gstin'
  | 'ask_udyam'
  | 'bad_udyam'
  | 'ask_categories'
  | 'categories_picked'
  | 'categories_need_one'
  | 'categories_full'
  | 'ask_capability'
  | 'answer_too_short'
  | 'voice_failed_type_instead'
  | 'ask_photos'
  | 'photo_received'
  | 'photos_full'
  | 'drafting_wait'
  | 'draft_intro'
  | 'draft_uncertain'
  | 'draft_buttons_hint'
  | 'review_buttons_reminder'
  | 'revise_ask'
  | 'revise_cap'
  | 'confirm_failed'
  | 'handoff'
  | 'failed_continue_web'
  | 'expired'
  | 'not_stated'
  | 'btn_confirm'
  | 'btn_revise'
  | 'btn_done'
  | 'btn_skip'
  | 'btn_lang_en'
  | 'btn_lang_hi'
  | 'btn_lang_te'
  | 'list_choose'
  | 'summary_profile'
  | 'summary_package'
  | 'summary_price'
  | 'summary_delivery'
  | 'days_n'
  | `step.${OnboardingStep}`
  | `cat.${CategorySlug}`
  | `cap.${CategorySlug}.1`
  | `cap.${CategorySlug}.2`
  | `cap.${CategorySlug}.3`

type Copy = Record<OnboardingLocale, string>

const CORE: Record<Exclude<OnboardingCopyId, `step.${string}` | `cat.${string}` | `cap.${string}`>, Copy> = {
  welcome: {
    en: 'Welcome to AMClub, {name}! I will ask a few short questions to set up your provider profile. It takes about 10 minutes. You can type or send voice notes.',
    hi: 'AMClub में आपका स्वागत है, {name}! आपकी प्रोवाइडर प्रोफ़ाइल बनाने के लिए मैं कुछ छोटे सवाल पूछूँगा। इसमें लगभग 10 मिनट लगेंगे। आप टाइप कर सकते हैं या वॉइस नोट भेज सकते हैं।',
    te: 'AMClubకి స్వాగతం, {name}! మీ ప్రొవైడర్ ప్రొఫైల్ సిద్ధం చేయడానికి కొన్ని చిన్న ప్రశ్నలు అడుగుతాను. సుమారు 10 నిమిషాలు పడుతుంది. మీరు టైప్ చేయవచ్చు లేదా వాయిస్ నోట్ పంపవచ్చు.',
  },
  ask_language: {
    en: 'Which language should we continue in?',
    hi: 'हम किस भाषा में आगे बढ़ें?',
    te: 'మనం ఏ భాషలో కొనసాగుదాం?',
  },
  ask_business_name: {
    en: 'What is the name of your business, as buyers should see it?',
    hi: 'आपके व्यवसाय का नाम क्या है, जैसा खरीदार देखें?',
    te: 'కొనుగోలుదారులు చూడాల్సినట్లుగా మీ వ్యాపారం పేరు ఏమిటి?',
  },
  bad_business_name: {
    en: 'Please send the business name as text, 2 to 100 characters.',
    hi: 'कृपया व्यवसाय का नाम टेक्स्ट में भेजें, 2 से 100 अक्षर।',
    te: 'దయచేసి వ్యాపారం పేరును టెక్స్ట్‌గా పంపండి, 2 నుండి 100 అక్షరాలు.',
  },
  ask_gstin: {
    en: 'Please type your 15-character GSTIN exactly as on your GST certificate. We only check the format here; verification happens on the website.',
    hi: 'कृपया अपना 15 अक्षरों का GSTIN वैसे ही टाइप करें जैसा GST प्रमाणपत्र पर है। यहाँ हम सिर्फ़ फ़ॉर्मैट जाँचते हैं; सत्यापन वेबसाइट पर होगा।',
    te: 'దయచేసి మీ GST సర్టిఫికెట్‌లో ఉన్నట్లే 15 అక్షరాల GSTINని టైప్ చేయండి. ఇక్కడ మేము ఫార్మాట్ మాత్రమే తనిఖీ చేస్తాము; ధృవీకరణ వెబ్‌సైట్‌లో జరుగుతుంది.',
  },
  bad_gstin: {
    en: 'That does not look like a GSTIN. It has 15 characters, for example 29ABCDE1234F1Z5. Please try again.',
    hi: 'यह GSTIN जैसा नहीं लगता। इसमें 15 अक्षर होते हैं, जैसे 29ABCDE1234F1Z5। कृपया फिर से भेजें।',
    te: 'ఇది GSTIN లాగా లేదు. ఇందులో 15 అక్షరాలు ఉంటాయి, ఉదాహరణకు 29ABCDE1234F1Z5. దయచేసి మళ్ళీ ప్రయత్నించండి.',
  },
  ask_udyam: {
    en: 'Do you have an Udyam registration number (UDYAM-XX-00-0000000)? Type it, or tap Skip.',
    hi: 'क्या आपके पास उद्यम पंजीकरण संख्या है (UDYAM-XX-00-0000000)? टाइप करें, या Skip दबाएँ।',
    te: 'మీకు ఉద్యమ్ రిజిస్ట్రేషన్ నంబర్ ఉందా (UDYAM-XX-00-0000000)? టైప్ చేయండి, లేదా Skip నొక్కండి.',
  },
  bad_udyam: {
    en: 'That does not look like an Udyam number (UDYAM-XX-00-0000000). Type it again or tap Skip.',
    hi: 'यह उद्यम संख्या जैसी नहीं लगती (UDYAM-XX-00-0000000)। फिर से टाइप करें या Skip दबाएँ।',
    te: 'ఇది ఉద్యమ్ నంబర్ లాగా లేదు (UDYAM-XX-00-0000000). మళ్ళీ టైప్ చేయండి లేదా Skip నొక్కండి.',
  },
  ask_categories: {
    en: 'Which services do you offer? Choose up to {max}, one at a time, then tap Done.',
    hi: 'आप कौन सी सेवाएँ देते हैं? एक-एक करके अधिकतम {max} चुनें, फिर Done दबाएँ।',
    te: 'మీరు ఏ సేవలు అందిస్తారు? ఒక్కొక్కటిగా గరిష్టంగా {max} ఎంచుకోండి, తరువాత Done నొక్కండి.',
  },
  categories_picked: {
    en: 'Added {category} ({n} of {max}). Pick another or tap Done.',
    hi: '{category} जोड़ा गया ({max} में से {n})। और चुनें या Done दबाएँ।',
    te: '{category} జోడించబడింది ({max}లో {n}). మరొకటి ఎంచుకోండి లేదా Done నొక్కండి.',
  },
  categories_need_one: {
    en: 'Please choose at least one service first.',
    hi: 'कृपया पहले कम से कम एक सेवा चुनें।',
    te: 'దయచేసి ముందుగా కనీసం ఒక సేవను ఎంచుకోండి.',
  },
  categories_full: {
    en: 'You have chosen {max} services. Moving on.',
    hi: 'आपने {max} सेवाएँ चुन ली हैं। आगे बढ़ते हैं।',
    te: 'మీరు {max} సేవలు ఎంచుకున్నారు. ముందుకు వెళ్దాం.',
  },
  ask_capability: {
    en: '{category} · question {n} of {total}\n{question}\nSend a voice note or type your answer.',
    hi: '{category} · सवाल {n}/{total}\n{question}\nवॉइस नोट भेजें या जवाब टाइप करें।',
    te: '{category} · ప్రశ్న {n}/{total}\n{question}\nవాయిస్ నోట్ పంపండి లేదా జవాబు టైప్ చేయండి.',
  },
  answer_too_short: {
    en: 'Please answer in a few words, or send a voice note.',
    hi: 'कृपया कुछ शब्दों में जवाब दें, या वॉइस नोट भेजें।',
    te: 'దయచేసి కొన్ని పదాల్లో జవాబు ఇవ్వండి, లేదా వాయిస్ నోట్ పంపండి.',
  },
  voice_failed_type_instead: {
    en: 'Sorry, I could not hear that voice note. Please type the answer instead.',
    hi: 'माफ़ कीजिए, वह वॉइस नोट सुना नहीं जा सका। कृपया जवाब टाइप करें।',
    te: 'క్షమించండి, ఆ వాయిస్ నోట్ వినలేకపోయాను. దయచేసి జవాబు టైప్ చేయండి.',
  },
  ask_photos: {
    en: 'Send up to {max} photos of your workshop, office or past work. When done, tap Skip or Done.',
    hi: 'अपनी वर्कशॉप, ऑफ़िस या पिछले काम की अधिकतम {max} फ़ोटो भेजें। हो जाए तो Skip या Done दबाएँ।',
    te: 'మీ వర్క్‌షాప్, ఆఫీసు లేదా గత పని ఫోటోలు గరిష్టంగా {max} పంపండి. అయిపోయాక Skip లేదా Done నొక్కండి.',
  },
  photo_received: {
    en: 'Got it ({n} of {max}). Send more or tap Done.',
    hi: 'मिल गई ({max} में से {n})। और भेजें या Done दबाएँ।',
    te: 'అందింది ({max}లో {n}). ఇంకా పంపండి లేదా Done నొక్కండి.',
  },
  photos_full: {
    en: 'That is {max} photos, thank you.',
    hi: '{max} फ़ोटो हो गईं, धन्यवाद।',
    te: '{max} ఫోటోలు అయ్యాయి, ధన్యవాదాలు.',
  },
  drafting_wait: {
    en: 'Thank you. Preparing your profile draft, one moment…',
    hi: 'धन्यवाद। आपकी प्रोफ़ाइल का ड्राफ़्ट तैयार हो रहा है, एक क्षण…',
    te: 'ధన్యవాదాలు. మీ ప్రొఫైల్ డ్రాఫ్ట్ సిద్ధం అవుతోంది, ఒక్క క్షణం…',
  },
  draft_intro: {
    en: 'Here is the draft from your answers. Nothing is published yet.',
    hi: 'आपके जवाबों से बना ड्राफ़्ट यह रहा। अभी कुछ भी प्रकाशित नहीं हुआ है।',
    te: 'మీ జవాబుల నుండి తయారైన డ్రాఫ్ట్ ఇదిగో. ఇంకా ఏమీ ప్రచురించబడలేదు.',
  },
  draft_uncertain: {
    en: 'I was not sure about: {fields}. You can fix these on the website.',
    hi: 'मुझे इनके बारे में पक्का नहीं था: {fields}। आप इन्हें वेबसाइट पर ठीक कर सकते हैं।',
    te: 'వీటి గురించి నాకు ఖచ్చితంగా తెలియలేదు: {fields}. వీటిని మీరు వెబ్‌సైట్‌లో సరిచేయవచ్చు.',
  },
  draft_buttons_hint: {
    en: 'Does this look right?',
    hi: 'क्या यह सही लग रहा है?',
    te: 'ఇది సరిగ్గా ఉందా?',
  },
  review_buttons_reminder: {
    en: 'Please use the buttons below to confirm or change the draft.',
    hi: 'कृपया ड्राफ़्ट की पुष्टि करने या बदलने के लिए नीचे के बटन इस्तेमाल करें।',
    te: 'డ్రాఫ్ట్‌ను నిర్ధారించడానికి లేదా మార్చడానికి దయచేసి క్రింది బటన్లను ఉపయోగించండి.',
  },
  revise_ask: {
    en: 'What should change? Tell me in a message or a voice note.',
    hi: 'क्या बदलना चाहिए? मुझे मैसेज या वॉइस नोट में बताएँ।',
    te: 'ఏమి మార్చాలి? మెసేజ్ లేదా వాయిస్ నోట్‌లో చెప్పండి.',
  },
  revise_cap: {
    en: 'I have prepared two drafts already. Please finish the changes on the website: {link}',
    hi: 'मैं पहले ही दो ड्राफ़्ट बना चुका हूँ। कृपया बाकी बदलाव वेबसाइट पर करें: {link}',
    te: 'నేను ఇప్పటికే రెండు డ్రాఫ్ట్‌లు సిద్ధం చేశాను. దయచేసి మిగిలిన మార్పులు వెబ్‌సైట్‌లో చేయండి: {link}',
  },
  confirm_failed: {
    en: 'I could not record your confirmation just now. Please tap the button again in a moment.',
    hi: 'अभी आपकी पुष्टि दर्ज नहीं हो सकी। कृपया थोड़ी देर में बटन फिर दबाएँ।',
    te: 'ఇప్పుడు మీ నిర్ధారణను నమోదు చేయలేకపోయాను. దయచేసి కాసేపటి తరువాత బటన్ మళ్ళీ నొక్కండి.',
  },
  handoff: {
    en: 'Thank you! Your draft is saved. Finish on the website — it is prefilled; you only need to verify your GSTIN and bank and accept the terms: {link}',
    hi: 'धन्यवाद! आपका ड्राफ़्ट सहेज लिया गया है। वेबसाइट पर पूरा करें — जानकारी पहले से भरी है; आपको बस GSTIN और बैंक सत्यापित करना है और शर्तें स्वीकार करनी हैं: {link}',
    te: 'ధన్యవాదాలు! మీ డ్రాఫ్ట్ సేవ్ అయింది. వెబ్‌సైట్‌లో పూర్తి చేయండి — వివరాలు ముందే నింపి ఉంటాయి; మీరు GSTIN, బ్యాంక్ ధృవీకరించి నిబంధనలు అంగీకరిస్తే చాలు: {link}',
  },
  failed_continue_web: {
    en: 'Sorry, I could not finish the draft. Your answers are saved — please continue on the website: {link}',
    hi: 'माफ़ कीजिए, ड्राफ़्ट पूरा नहीं हो सका। आपके जवाब सुरक्षित हैं — कृपया वेबसाइट पर जारी रखें: {link}',
    te: 'క్షమించండి, డ్రాఫ్ట్ పూర్తి చేయలేకపోయాను. మీ జవాబులు సేవ్ అయ్యాయి — దయచేసి వెబ్‌సైట్‌లో కొనసాగించండి: {link}',
  },
  expired: {
    en: 'This WhatsApp setup has expired. You can finish on the website any time: {link}',
    hi: 'यह WhatsApp सेटअप समाप्त हो गया है। आप वेबसाइट पर कभी भी पूरा कर सकते हैं: {link}',
    te: 'ఈ WhatsApp సెటప్ గడువు ముగిసింది. మీరు ఎప్పుడైనా వెబ్‌సైట్‌లో పూర్తి చేయవచ్చు: {link}',
  },
  not_stated: { en: 'not stated', hi: 'नहीं बताया', te: 'చెప్పలేదు' },
  btn_confirm: { en: 'Looks right', hi: 'सही है', te: 'సరిగ్గా ఉంది' },
  btn_revise: { en: 'Change something', hi: 'कुछ बदलें', te: 'ఏదైనా మార్చాలి' },
  btn_done: { en: 'Done', hi: 'Done', te: 'Done' },
  btn_skip: { en: 'Skip', hi: 'Skip', te: 'Skip' },
  btn_lang_en: { en: 'English', hi: 'English', te: 'English' },
  btn_lang_hi: { en: 'हिंदी', hi: 'हिंदी', te: 'हिंदी' },
  btn_lang_te: { en: 'తెలుగు', hi: 'తెలుగు', te: 'తెలుగు' },
  list_choose: { en: 'Choose', hi: 'चुनें', te: 'ఎంచుకోండి' },
  summary_profile: {
    en: 'Business: {display_name}\nLegal name: {legal_name}\nCity: {city}, {state}\nLanguages: {languages}\nServices: {categories}\nAbout: {about}',
    hi: 'व्यवसाय: {display_name}\nकानूनी नाम: {legal_name}\nशहर: {city}, {state}\nभाषाएँ: {languages}\nसेवाएँ: {categories}\nपरिचय: {about}',
    te: 'వ్యాపారం: {display_name}\nచట్టపరమైన పేరు: {legal_name}\nనగరం: {city}, {state}\nభాషలు: {languages}\nసేవలు: {categories}\nపరిచయం: {about}',
  },
  summary_package: {
    en: 'Listing {n}: {title} ({category})\nIncludes: {scope}\nDelivers: {deliverables}',
    hi: 'लिस्टिंग {n}: {title} ({category})\nशामिल: {scope}\nडिलीवरी: {deliverables}',
    te: 'లిస్టింగ్ {n}: {title} ({category})\nఉంటాయి: {scope}\nఅందిస్తారు: {deliverables}',
  },
  summary_price: { en: 'Price: {price}', hi: 'कीमत: {price}', te: 'ధర: {price}' },
  summary_delivery: { en: 'Delivery: {days}', hi: 'डिलीवरी: {days}', te: 'డెలివరీ: {days}' },
  days_n: { en: '{n} days', hi: '{n} दिन', te: '{n} రోజులు' },
}

const STEP_LABELS: Record<OnboardingStep, Copy> = {
  language: { en: 'language', hi: 'भाषा', te: 'భాష' },
  business_name: { en: 'business name', hi: 'व्यवसाय का नाम', te: 'వ్యాపారం పేరు' },
  gstin: { en: 'GSTIN', hi: 'GSTIN', te: 'GSTIN' },
  udyam: { en: 'Udyam number', hi: 'उद्यम संख्या', te: 'ఉద్యమ్ నంబర్' },
  categories: { en: 'services', hi: 'सेवाएँ', te: 'సేవలు' },
  capabilities: { en: 'your work', hi: 'आपका काम', te: 'మీ పని' },
  photos: { en: 'photos', hi: 'फ़ोटो', te: 'ఫోటోలు' },
  drafting: { en: 'draft', hi: 'ड्राफ़्ट', te: 'డ్రాఫ్ట్' },
  review: { en: 'review', hi: 'समीक्षा', te: 'సమీక్ష' },
  confirmed: { en: 'confirmed', hi: 'पुष्टि हो गई', te: 'నిర్ధారించబడింది' },
  handed_off: { en: 'website', hi: 'वेबसाइट', te: 'వెబ్‌సైట్' },
  abandoned: { en: 'expired', hi: 'समाप्त', te: 'గడువు ముగిసింది' },
  failed: { en: 'failed', hi: 'विफल', te: 'విఫలమైంది' },
}

/** Category names: en/hi from CATEGORIES.name_i18n; te added here (S1.6). */
const CATEGORY_TE: Record<CategorySlug, string> = {
  'company-registrations': 'కంపెనీ & రిజిస్ట్రేషన్లు',
  'tax-accounting': 'పన్ను & అకౌంటింగ్',
  legal: 'చట్టపరమైన సేవలు',
  'hr-staffing': 'HR & స్టాఫింగ్',
  'finance-facilitation': 'ఫైనాన్స్ సహాయం',
  'digital-marketing': 'డిజిటల్ మార్కెటింగ్',
  'web-tech': 'వెబ్ & టెక్',
  'government-licensing': 'ప్రభుత్వ లైసెన్సింగ్',
}

const CAPABILITY_COPY: Record<CategorySlug, [Copy, Copy, Copy]> = {
  'company-registrations': [
    { en: 'Which registrations do you handle most (Pvt Ltd, LLP, OPC, GST, Udyam, FSSAI, IEC)?', hi: 'आप कौन से पंजीकरण सबसे ज़्यादा करते हैं (Pvt Ltd, LLP, OPC, GST, उद्यम, FSSAI, IEC)?', te: 'మీరు ఏ రిజిస్ట్రేషన్లు ఎక్కువగా చేస్తారు (Pvt Ltd, LLP, OPC, GST, ఉద్యమ్, FSSAI, IEC)?' },
    { en: 'How many days does a typical registration take with you, and what does the client need to give you?', hi: 'आपके साथ एक सामान्य पंजीकरण में कितने दिन लगते हैं, और क्लाइंट को क्या देना होता है?', te: 'మీతో ఒక సాధారణ రిజిస్ట్రేషన్‌కు ఎన్ని రోజులు పడుతుంది, క్లయింట్ మీకు ఏమి ఇవ్వాలి?' },
    { en: 'What do you usually charge for your most common registration, if you want to state a price?', hi: 'अगर आप कीमत बताना चाहें, तो अपने सबसे आम पंजीकरण के लिए आप आमतौर पर कितना लेते हैं?', te: 'ధర చెప్పాలనుకుంటే, మీ అత్యంత సాధారణ రిజిస్ట్రేషన్‌కు సాధారణంగా ఎంత తీసుకుంటారు?' },
  ],
  'tax-accounting': [
    { en: 'Which work do you do most: GST returns, ITR, bookkeeping, audits or TDS? For what kind of businesses?', hi: 'आप सबसे ज़्यादा कौन सा काम करते हैं: GST रिटर्न, ITR, बहीखाता, ऑडिट या TDS? किस तरह के व्यवसायों के लिए?', te: 'మీరు ఎక్కువగా ఏ పని చేస్తారు: GST రిటర్న్స్, ITR, బుక్‌కీపింగ్, ఆడిట్ లేదా TDS? ఎలాంటి వ్యాపారాలకు?' },
    { en: 'What does a monthly engagement include, and which software do you work in (Tally, Zoho, Excel)?', hi: 'मासिक सेवा में क्या-क्या शामिल है, और आप किस सॉफ़्टवेयर में काम करते हैं (Tally, Zoho, Excel)?', te: 'నెలవారీ సేవలో ఏమేమి ఉంటాయి, మీరు ఏ సాఫ్ట్‌వేర్‌లో పని చేస్తారు (Tally, Zoho, Excel)?' },
    { en: 'What do you charge per month for a small trading firm, if you want to state a price?', hi: 'अगर आप कीमत बताना चाहें, तो एक छोटी ट्रेडिंग फ़र्म के लिए प्रति माह कितना लेते हैं?', te: 'ధర చెప్పాలనుకుంటే, చిన్న ట్రేడింగ్ సంస్థకు నెలకు ఎంత తీసుకుంటారు?' },
  ],
  legal: [
    { en: 'Which legal work do you take: contracts, trademarks, notices, labour compliance, disputes?', hi: 'आप कौन सा कानूनी काम लेते हैं: अनुबंध, ट्रेडमार्क, नोटिस, श्रम अनुपालन, विवाद?', te: 'మీరు ఏ చట్టపరమైన పని తీసుకుంటారు: కాంట్రాక్టులు, ట్రేడ్‌మార్క్‌లు, నోటీసులు, లేబర్ కంప్లయన్స్, వివాదాలు?' },
    { en: 'Which courts, tribunals or registries do you appear before, and in which languages do you draft?', hi: 'आप किन अदालतों, ट्रिब्यूनल या रजिस्ट्री में पेश होते हैं, और किन भाषाओं में ड्राफ़्ट करते हैं?', te: 'మీరు ఏ కోర్టులు, ట్రిబ్యునల్స్ లేదా రిజిస్ట్రీల ముందు హాజరవుతారు, ఏ భాషల్లో డ్రాఫ్ట్ చేస్తారు?' },
    { en: 'What is your fee for a standard contract draft or trademark filing, if you want to state one?', hi: 'अगर आप बताना चाहें, तो एक मानक अनुबंध ड्राफ़्ट या ट्रेडमार्क फ़ाइलिंग की आपकी फ़ीस क्या है?', te: 'చెప్పాలనుకుంటే, ఒక సాధారణ కాంట్రాక్ట్ డ్రాఫ్ట్ లేదా ట్రేడ్‌మార్క్ ఫైలింగ్‌కు మీ ఫీజు ఎంత?' },
  ],
  'hr-staffing': [
    { en: 'What do you provide: recruitment (skilled or unskilled), payroll, HR policies, contract staff?', hi: 'आप क्या देते हैं: भर्ती (कुशल या अकुशल), पेरोल, HR नीतियाँ, कॉन्ट्रैक्ट स्टाफ?', te: 'మీరు ఏమి అందిస్తారు: రిక్రూట్‌మెంట్ (నైపుణ్యం ఉన్న లేదా లేని), పేరోల్, HR విధానాలు, కాంట్రాక్ట్ సిబ్బంది?' },
    { en: 'Which industries and cities do you hire for, and how fast can you fill a role?', hi: 'आप किन उद्योगों और शहरों के लिए भर्ती करते हैं, और एक पद कितनी जल्दी भर सकते हैं?', te: 'మీరు ఏ పరిశ్రమలు, నగరాలకు నియామకాలు చేస్తారు, ఒక పోస్ట్‌ను ఎంత త్వరగా భర్తీ చేయగలరు?' },
    { en: 'How do you charge: a placement fee, a monthly retainer or per employee? A number if you like.', hi: 'आप कैसे शुल्क लेते हैं: प्लेसमेंट फ़ीस, मासिक रिटेनर या प्रति कर्मचारी? चाहें तो राशि बताएँ।', te: 'మీరు ఎలా ఛార్జ్ చేస్తారు: ప్లేస్‌మెంట్ ఫీజు, నెలవారీ రిటైనర్ లేదా ఉద్యోగికి? కావాలంటే మొత్తం చెప్పండి.' },
  ],
  'finance-facilitation': [
    { en: 'Which finance help do you give: loan documentation, CGTMSE or Mudra applications, project reports, DSA services?', hi: 'आप कौन सी वित्तीय मदद देते हैं: ऋण दस्तावेज़, CGTMSE या मुद्रा आवेदन, प्रोजेक्ट रिपोर्ट, DSA सेवाएँ?', te: 'మీరు ఏ ఫైనాన్స్ సహాయం అందిస్తారు: లోన్ డాక్యుమెంటేషన్, CGTMSE లేదా ముద్రా దరఖాస్తులు, ప్రాజెక్ట్ రిపోర్టులు, DSA సేవలు?' },
    { en: 'Which banks or NBFCs do you work with, and what loan sizes do you usually handle?', hi: 'आप किन बैंकों या NBFC के साथ काम करते हैं, और आमतौर पर कितनी राशि के ऋण संभालते हैं?', te: 'మీరు ఏ బ్యాంకులు లేదా NBFCలతో పని చేస్తారు, సాధారణంగా ఎంత మొత్తం లోన్లు నిర్వహిస్తారు?' },
    { en: 'What do you charge for a project report or a loan file, if you want to state a price?', hi: 'अगर आप कीमत बताना चाहें, तो प्रोजेक्ट रिपोर्ट या लोन फ़ाइल के लिए कितना लेते हैं?', te: 'ధర చెప్పాలనుకుంటే, ప్రాజెక్ట్ రిపోర్ట్ లేదా లోన్ ఫైల్‌కు ఎంత తీసుకుంటారు?' },
  ],
  'digital-marketing': [
    { en: 'What do you do most: social media, SEO, paid ads, branding or content? On which platforms?', hi: 'आप सबसे ज़्यादा क्या करते हैं: सोशल मीडिया, SEO, पेड विज्ञापन, ब्रांडिंग या कंटेंट? किन प्लेटफ़ॉर्म पर?', te: 'మీరు ఎక్కువగా ఏమి చేస్తారు: సోషల్ మీడియా, SEO, పెయిడ్ యాడ్స్, బ్రాండింగ్ లేదా కంటెంట్? ఏ ప్లాట్‌ఫారమ్‌లలో?' },
    { en: 'What does a monthly package include (posts, ad spend management, reports), and for which kinds of businesses?', hi: 'मासिक पैकेज में क्या शामिल है (पोस्ट, विज्ञापन खर्च प्रबंधन, रिपोर्ट), और किस तरह के व्यवसायों के लिए?', te: 'నెలవారీ ప్యాకేజీలో ఏమి ఉంటాయి (పోస్టులు, యాడ్ ఖర్చు నిర్వహణ, రిపోర్టులు), ఎలాంటి వ్యాపారాలకు?' },
    { en: 'What is your monthly fee for a small business, if you want to state a price?', hi: 'अगर आप कीमत बताना चाहें, तो एक छोटे व्यवसाय के लिए आपकी मासिक फ़ीस क्या है?', te: 'ధర చెప్పాలనుకుంటే, చిన్న వ్యాపారానికి మీ నెలవారీ ఫీజు ఎంత?' },
  ],
  'web-tech': [
    { en: 'What do you build: websites, e-commerce stores, mobile apps, ONDC onboarding? Which tools or platforms?', hi: 'आप क्या बनाते हैं: वेबसाइट, ई-कॉमर्स स्टोर, मोबाइल ऐप, ONDC ऑनबोर्डिंग? कौन से टूल या प्लेटफ़ॉर्म?', te: 'మీరు ఏమి నిర్మిస్తారు: వెబ్‌సైట్లు, ఇ-కామర్స్ స్టోర్లు, మొబైల్ యాప్‌లు, ONDC ఆన్‌బోర్డింగ్? ఏ టూల్స్ లేదా ప్లాట్‌ఫారమ్‌లు?' },
    { en: 'How many days does a typical small business website take, and what is included (pages, hosting, support)?', hi: 'एक सामान्य छोटे व्यवसाय की वेबसाइट में कितने दिन लगते हैं, और क्या शामिल है (पेज, होस्टिंग, सपोर्ट)?', te: 'ఒక సాధారణ చిన్న వ్యాపార వెబ్‌సైట్‌కు ఎన్ని రోజులు పడుతుంది, ఏమి ఉంటాయి (పేజీలు, హోస్టింగ్, సపోర్ట్)?' },
    { en: 'What do you charge for that website, if you want to state a price?', hi: 'अगर आप कीमत बताना चाहें, तो उस वेबसाइट के लिए कितना लेते हैं?', te: 'ధర చెప్పాలనుకుంటే, ఆ వెబ్‌సైట్‌కు ఎంత తీసుకుంటారు?' },
  ],
  'government-licensing': [
    { en: 'Which licences and schemes do you handle: factory licence, pollution NOC, PMEGP or state subsidies, GeM or tenders?', hi: 'आप कौन से लाइसेंस और योजनाएँ संभालते हैं: फ़ैक्टरी लाइसेंस, प्रदूषण NOC, PMEGP या राज्य सब्सिडी, GeM या टेंडर?', te: 'మీరు ఏ లైసెన్సులు, పథకాలు నిర్వహిస్తారు: ఫ్యాక్టరీ లైసెన్స్, పొల్యూషన్ NOC, PMEGP లేదా రాష్ట్ర సబ్సిడీలు, GeM లేదా టెండర్లు?' },
    { en: 'In which state or district offices do you file, and how long does a typical application take?', hi: 'आप किस राज्य या ज़िले के कार्यालयों में फ़ाइल करते हैं, और एक सामान्य आवेदन में कितना समय लगता है?', te: 'మీరు ఏ రాష్ట్ర లేదా జిల్లా కార్యాలయాల్లో ఫైల్ చేస్తారు, ఒక సాధారణ దరఖాస్తుకు ఎంత సమయం పడుతుంది?' },
    { en: 'What do you charge for your most common licence application, if you want to state a price?', hi: 'अगर आप कीमत बताना चाहें, तो अपने सबसे आम लाइसेंस आवेदन के लिए कितना लेते हैं?', te: 'ధర చెప్పాలనుకుంటే, మీ అత్యంత సాధారణ లైసెన్స్ దరఖాస్తుకు ఎంత తీసుకుంటారు?' },
  ],
}

function lookup(id: OnboardingCopyId): Copy | null {
  if (id.startsWith('step.')) return STEP_LABELS[id.slice(5) as OnboardingStep] ?? null
  if (id.startsWith('cat.')) {
    const slug = id.slice(4) as CategorySlug
    const meta = CATEGORIES[slug]
    if (!meta) return null
    return { en: meta.name_i18n.en, hi: meta.name_i18n.hi ?? meta.name_i18n.en, te: CATEGORY_TE[slug] ?? meta.name_i18n.en }
  }
  if (id.startsWith('cap.')) {
    const m = /^cap\.(.+)\.([123])$/.exec(id)
    if (!m) return null
    const row = CAPABILITY_COPY[m[1] as CategorySlug]
    return row ? row[Number(m[2]) - 1] ?? null : null
  }
  return (CORE as Record<string, Copy>)[id] ?? null
}

/** Every copy id (for the completeness test and the runbook). */
export function onboardingCopyIds(): OnboardingCopyId[] {
  const ids: OnboardingCopyId[] = [...(Object.keys(CORE) as OnboardingCopyId[])]
  for (const step of Object.keys(STEP_LABELS) as OnboardingStep[]) ids.push(`step.${step}`)
  for (const slug of CATEGORY_SLUGS) {
    ids.push(`cat.${slug}`, `cap.${slug}.1`, `cap.${slug}.2`, `cap.${slug}.3`)
  }
  return ids
}

/** Render a message in a locale, replacing `{token}` params. Falls back to en; throws on an unknown id. */
export function onboardingCopy(id: OnboardingCopyId, locale: OnboardingLocale, params: Record<string, string | number> = {}): string {
  const copy = lookup(id)
  if (!copy) throw new Error(`unknown onboarding copy id '${id}'`)
  const raw = copy[locale] ?? copy.en
  return raw.replace(/\{([a-z_]+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m))
}

/** Category display name in the interview locale. */
export function onboardingCategoryName(slug: CategorySlug, locale: OnboardingLocale): string {
  return onboardingCopy(`cat.${slug}`, locale)
}
