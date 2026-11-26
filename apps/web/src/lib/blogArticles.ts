export interface BlogSection {
  heading: string;
  paragraphs: string[];
}

export interface BlogFaq {
  question: string;
  answer: string;
}

export interface BlogArticleLocale {
  title: string;
  description: string;
  sections: BlogSection[];
  faqs: BlogFaq[];
}

export interface BlogArticle {
  slug: string;
  publishedAt: string;
  updatedAt: string;
  readingMinutes: number;
  en: BlogArticleLocale;
  hi: BlogArticleLocale;
}

export const BLOG_ARTICLES: BlogArticle[] = [
  {
    slug: "how-seat-swapping-works-in-indian-railways",
    publishedAt: "2026-11-15",
    updatedAt: "2026-11-26",
    readingMinutes: 5,
    en: {
      title: "How Seat Swapping Works in Indian Railways (Safely & Fairly)",
      description:
        "A practical guide to mutual berth swapping in Indian Railways—from TTE etiquette and chart preparation timing to zero-PII verified swaps with Saath.",
      sections: [
        {
          heading: "Why families end up split across coaches",
          paragraphs: [
            "IRCTC allocates confirmed berths from remaining inventory at booking time, or across multiple PNRs when family members book separately. Even in a single booking, seniors or children sometimes receive Upper or Side Upper berths.",
            "Before boarding, passengers have no safe way to discover who in B3 or B5 is travelling solo on a Lower Berth and happy to trade for an Upper Berth or another bay.",
          ],
        },
        {
          heading: "Is mutual seat swapping allowed by Indian Railways?",
          paragraphs: [
            "Yes—mutual seat adjustments between consenting passengers holding valid confirmed tickets in the same class are routine on Indian trains, subject to the onboard Travelling Ticket Examiner (TTE) checking tickets at their original booked berths if needed.",
            "Saath generates an offline-ready signed Swap Card showing only agreed berth numbers and train details—never personal phone numbers or PNRs—so both travellers can coordinate calmly with the TTE.",
          ],
        },
        {
          heading: "How Saath keeps swaps ₹0 and privacy-first",
          paragraphs: [
            "Before both travellers agree, Saath reveals only coach code, berth type (such as LB or UB), and verification trust tier. Names and exact seat numbers stay private until mutual confirmation.",
            "Peer-to-peer swaps on Saath are ₹0 forever. We never sell, auction, or bump seats.",
          ],
        },
      ],
      faqs: [
        {
          question: "Do I need to pay anything to swap seats on Saath?",
          answer: "No. Peer-to-peer train and flight seat swaps on Saath are always ₹0 for passengers.",
        },
        {
          question: "Should we inform the TTE after swapping berths?",
          answer:
            "Yes. Keep your original ticket and signed Saath Swap Card handy and inform the TTE when they check berths in the coach.",
        },
      ],
    },
    hi: {
      title: "भारतीय रेल में सीट अदला-बदली कैसे काम करती है (सुरक्षित और निष्पक्ष तरीका)",
      description:
        "भारतीय रेल में आपसी सहमति से बर्थ बदलने की पूरी गाइड—TTE नियम, चार्ट तैयारी समय और साथ (Saath) पर गोपनीय सत्यापित स्वैप।",
      sections: [
        {
          heading: "परिवार की सीटें अलग-अलग कोच में क्यों बँट जाती हैं",
          paragraphs: [
            "IRCTC बुकिंग के समय उपलब्ध इन्वेंट्री के अनुसार बर्थ आवंटित करता है। अलग-अलग PNR से बुकिंग करने पर या भीड़ वाले दिनों में वरिष्ठ नागरिकों को भी ऊपरी बर्थ मिल जाती है।",
            "ट्रेन में चढ़ने से पहले यह जानना मुश्किल होता है कि B3 या B5 कोच में कौन यात्री निचली बर्थ बदलने के लिए तैयार है।",
          ],
        },
        {
          heading: "क्या भारतीय रेल में आपसी सीट स्वैप मान्य है?",
          paragraphs: [
            "हाँ—एक ही श्रेणी में वैध कन्फ़र्म टिकट वाले यात्रियों के बीच आपसी सहमति से बर्थ बदलना सामान्य है, जो TTE (Travelling Ticket Examiner) की जाँच के अधीन होता है।",
            "साथ (Saath) एक ऑफ़लाइन डिजिटल स्वैप कार्ड बनाता है जिसमें केवल बदली गई बर्थ और ट्रेन विवरण होता है—आपका फ़ोन नंबर या PNR नहीं।",
          ],
        },
        {
          heading: "साथ ₹0 और गोपनीयता-प्रथम कैसे रहता है",
          paragraphs: [
            "दोनों यात्रियों की सहमति से पहले केवल कोच और बर्थ का प्रकार दिखता है। नाम और सीट नंबर सहमति के बाद ही दिखते हैं।",
            "पीयर-टू-पीयर सीट स्वैप हमेशा ₹0 रहेंगे। साथ पर सीटें कभी बेची नहीं जातीं।",
          ],
        },
      ],
      faqs: [
        {
          question: "क्या साथ पर सीट बदलने के लिए कोई शुल्क लगता है?",
          answer: "नहीं। यात्रियों के लिए आपसी ट्रेन और फ़्लाइट सीट स्वैप हमेशा ₹0 है।",
        },
        {
          question: "क्या बर्थ बदलने के बाद TTE को बताना चाहिए?",
          answer: "हाँ। अपना मूल टिकट और साथ स्वैप कार्ड पास रखें और जाँच के समय TTE को सूचित करें।",
        },
      ],
    },
  },
  {
    slug: "irctc-chart-preparation-time-rules",
    publishedAt: "2026-11-16",
    updatedAt: "2026-11-26",
    readingMinutes: 4,
    en: {
      title: "IRCTC Chart Preparation Time Rules (Dec 2025 Update)",
      description:
        "Understand when Indian Railways prepares first and final reservation charts for morning vs afternoon/night trains—and when berth swaps lock in.",
      sections: [
        {
          heading: "Morning departures (05:00 to 14:00 IST)",
          paragraphs: [
            "Under the updated Railway Board chart rules, trains departing between 05:00 IST and 14:00 IST prepare their first reservation chart at 20:00 IST on the previous evening.",
          ],
        },
        {
          heading: "Afternoon & overnight departures",
          paragraphs: [
            "For trains departing after 14:00 IST or before 05:00 IST, the first chart is prepared roughly 10 hours before scheduled departure, followed by the final chart shortly before departure.",
          ],
        },
      ],
      faqs: [
        {
          question: "What happens to a Saath swap if my berth changes at charting?",
          answer:
            "Saath watches chart updates automatically. If a confirmed swap's berth changes during charting, the Swap Card is revoked immediately and both passengers are notified.",
        },
      ],
    },
    hi: {
      title: "IRCTC चार्ट तैयार होने के समय के नियम (दिसंबर 2025 अपडेट)",
      description:
        "जानें कि सुबह और रात की ट्रेनों के लिए पहला और अंतिम आरक्षण चार्ट कब बनता है—और स्वैप कब पक्के होते हैं।",
      sections: [
        {
          heading: "सुबह की ट्रेनें (05:00 से 14:00 IST)",
          paragraphs: [
            "नए रेलवे बोर्ड नियमों के अनुसार 05:00 से 14:00 IST के बीच छूटने वाली ट्रेनों का पहला चार्ट पिछली शाम 20:00 IST पर तैयार होता है।",
          ],
        },
        {
          heading: "दोपहर और रात की ट्रेनें",
          paragraphs: [
            "14:00 IST के बाद छूटने वाली ट्रेनों का पहला चार्ट प्रस्थान से लगभग 10 घंटे पहले तैयार होता है, और अंतिम चार्ट प्रस्थान से ठीक पहले जारी होता है।",
          ],
        },
      ],
      faqs: [
        {
          question: "अगर चार्ट बनने पर मेरी बर्थ बदल जाए तो स्वैप का क्या होगा?",
          answer:
            "साथ चार्ट अपडेट पर नज़र रखता है। यदि चार्टिंग में बर्थ बदलती है तो पुराना स्वैप कार्ड तुरंत अमान्य हो जाता है और दोनों यात्रियों को सूचना मिलती है।",
        },
      ],
    },
  },
  {
    slug: "lower-berth-quota-and-senior-citizen-seats",
    publishedAt: "2026-11-17",
    updatedAt: "2026-11-26",
    readingMinutes: 4,
    en: {
      title: "Lower Berth Quota & Swapping Upper Berths for Seniors",
      description:
        "Why senior citizens sometimes miss the Lower Berth quota during peak travel, and how to find a willing Lower Berth swap before boarding.",
      sections: [
        {
          heading: "When the Lower Berth quota fills up",
          paragraphs: [
            "Indian Railways reserves Lower Berths per coach for senior citizens (60+ men, 45+ women) and pregnant women, but peak-season demand quickly exhausts that quota.",
            "When Saath detects a senior passenger on an Upper or Side Upper berth, it automatically suggests a Lower Berth swap goal and prioritises zero-friction pairs.",
          ],
        },
      ],
      faqs: [
        {
          question: "Can younger travellers volunteer to give up a Lower Berth?",
          answer:
            "Yes! Choose 'Open to helping others' when verifying or setting a goal to match with seniors and families who need a Lower Berth.",
        },
      ],
    },
    hi: {
      title: "लोअर बर्थ कोटा और वरिष्ठ नागरिकों के लिए सीट स्वैप",
      description:
        "भीड़ के समय वरिष्ठ नागरिकों को निचली बर्थ न मिलने पर यात्रा से पहले सुरक्षित स्वैप कैसे खोजें।",
      sections: [
        {
          heading: "जब लोअर बर्थ कोटा भर जाए",
          paragraphs: [
            "भारतीय रेल वरिष्ठ नागरिकों के लिए हर कोच में निचली बर्थ आरक्षित रखती है, लेकिन त्योहारों या छुट्टियों में यह कोटा जल्दी भर जाता है।",
            "साथ (Saath) ऊपरी बर्थ पर वरिष्ठ यात्री दिखने पर अपने-आप निचली बर्थ का सुझाव देता है।",
          ],
        },
      ],
      faqs: [
        {
          question: "क्या युवा यात्री स्वेच्छा से निचली बर्थ दे सकते हैं?",
          answer:
            "हाँ! सत्यापन के समय 'दूसरों की मदद के लिए तैयार' चुनकर आप वरिष्ठ नागरिकों की मदद कर सकते हैं।",
        },
      ],
    },
  },
  {
    slug: "rac-vs-wl-seat-swap-guide",
    publishedAt: "2026-11-18",
    updatedAt: "2026-11-26",
    readingMinutes: 4,
    en: {
      title: "RAC vs Waitlist (WL) Berth Guide: When Can You Swap?",
      description:
        "What RAC Side Lower sharing means, how Waitlisted PNRs transition at chart preparation, and when Saath unlocks berth matching.",
      sections: [
        {
          heading: "RAC passengers vs WL passengers",
          paragraphs: [
            "Passengers with Reservation Against Cancellation (RAC) share a Side Lower berth until cancellations upgrade them. Waitlisted (WL) passengers do not have an assigned coach or berth until charting.",
            "Saath tracks chart updates for your PNR so you can match as soon as a full berth is allotted.",
          ],
        },
      ],
      faqs: [
        {
          question: "Can a WL ticket swap seats before charting?",
          answer:
            "Waitlisted tickets do not yet have a physical berth to swap; once your status upgrades to RAC or CNF at chart preparation, Saath updates your berth map.",
        },
      ],
    },
    hi: {
      title: "RAC बनाम वेटलिस्ट (WL) गाइड: सीट स्वैप कब कर सकते हैं?",
      description:
        "RAC साइड लोअर साझाकरण और चार्ट बनने के बाद WL टिकट के कन्फ़र्म होने पर स्वैप कैसे काम करता है।",
      sections: [
        {
          heading: "RAC और WL यात्रियों में अंतर",
          paragraphs: [
            "RAC यात्री साइड लोअर बर्थ साझा करते हैं जबकि वेटलिस्ट (WL) यात्रियों को चार्ट तैयार होने तक कोई कोच या सीट नहीं मिलती।",
            "चार्ट बनने पर जैसे ही आपकी बर्थ कन्फ़र्म होती है, साथ (Saath) आपका बर्थ मैप अपडेट कर देता है।",
          ],
        },
      ],
      faqs: [
        {
          question: "क्या चार्ट से पहले WL टिकट स्वैप हो सकता है?",
          answer:
            "WL टिकट में अभी कोई भौतिक बर्थ नहीं होती। चार्ट तैयारी के बाद RAC या CNF होने पर स्वैप मिलान शुरू हो जाते हैं।",
        },
      ],
    },
  },
  {
    slug: "flight-seat-swap-family-dgca-rules",
    publishedAt: "2026-11-19",
    updatedAt: "2026-11-26",
    readingMinutes: 4,
    en: {
      title: "Swapping Flight Seats for Families in India: Cabin Rules & Etiquette",
      description:
        "How to swap seats on IndiGo, Air India, Akasa Air, and SpiceJet flights without paying extra seat-selection fees—while respecting DGCA exit-row rules.",
      sections: [
        {
          heading: "Respecting exit-row and cabin crew rules",
          paragraphs: [
            "DGCA safety regulations restrict emergency exit-row seats to able-bodied adults who understand crew briefings. Children, infants, and passengers needing assistance cannot swap into exit rows.",
            "Saath checks aircraft cabin layouts (3-3, 2-2, 3-3-3) and clearly marks exit rows before you propose a swap, and every confirmed swap remains subject to cabin crew approval.",
          ],
        },
      ],
      faqs: [
        {
          question: "How does Saath verify my flight seat without storing my boarding pass?",
          answer:
            "Your phone decodes the IATA BCBP barcode locally inside your browser—images never leave your device, and passenger names are discarded.",
        },
      ],
    },
    hi: {
      title: "भारत में फ़्लाइट सीट स्वैप और DGCA केबिन नियम",
      description:
        "IndiGo, Air India, Akasa और SpiceJet फ़्लाइट्स में परिवार के साथ बैठने के लिए सुरक्षित सीट स्वैप गाइड।",
      sections: [
        {
          heading: "एग्ज़िट-रो और केबिन क्रू नियमों का सम्मान",
          paragraphs: [
            "DGCA सुरक्षा नियमों के अनुसार इमरजेंसी एग्ज़िट रो की सीटें केवल सक्षम वयस्क यात्रियों के लिए होती हैं।",
            "साथ (Saath) विमान लेआउट में एग्ज़िट रो को साफ़ चिह्नित करता है और हर स्वैप केबिन क्रू की स्वीकृति के अधीन रहता है।",
          ],
        },
      ],
      faqs: [
        {
          question: "मेरा बोर्डिंग पास अपलोड किए बिना फ़्लाइट सीट कैसे सत्यापित होती है?",
          answer:
            "आपका ब्राउज़र डिवाइस पर ही IATA BCBP बारकोड पढ़ता है—फोटो फ़ोन से बाहर नहीं जाती और यात्री का नाम सेव नहीं होता।",
        },
      ],
    },
  },
];

export function getBlogArticle(slug: string): BlogArticle | undefined {
  return BLOG_ARTICLES.find((a) => a.slug === slug);
}
