export interface TrainCatalogItem {
  trainNo: string;
  trainName: string;
  fromCode: string;
  toCode: string;
  departureIst: string;
  classes: string[];
}

const CURATED_TRAINS: TrainCatalogItem[] = [
  { trainNo: "12951", trainName: "Mumbai Tejas Rajdhani Express", fromCode: "NDLS", toCode: "MMCT", departureIst: "16:55", classes: ["1A", "2A", "3A"] },
  { trainNo: "12952", trainName: "New Delhi Tejas Rajdhani Express", fromCode: "MMCT", toCode: "NDLS", departureIst: "17:00", classes: ["1A", "2A", "3A"] },
  { trainNo: "12009", trainName: "Mumbai Central - Ahmedabad Shatabdi Express", fromCode: "MMCT", toCode: "ADI", departureIst: "06:20", classes: ["EC", "CC"] },
  { trainNo: "12010", trainName: "Ahmedabad - Mumbai Central Shatabdi Express", fromCode: "ADI", toCode: "MMCT", departureIst: "14:50", classes: ["EC", "CC"] },
  { trainNo: "12002", trainName: "Rani Kamalapati (Habibganj) Shatabdi Express", fromCode: "NDLS", toCode: "RKMP", departureIst: "06:00", classes: ["EC", "CC"] },
  { trainNo: "12001", trainName: "New Delhi - Rani Kamalapati Shatabdi Express", fromCode: "RKMP", toCode: "NDLS", departureIst: "15:15", classes: ["EC", "CC"] },
  { trainNo: "12627", trainName: "Karnataka Express", fromCode: "SBC", toCode: "NDLS", departureIst: "19:20", classes: ["2A", "3A", "SL"] },
  { trainNo: "12628", trainName: "Karnataka Express", fromCode: "NDLS", toCode: "SBC", departureIst: "20:20", classes: ["2A", "3A", "SL"] },
  { trainNo: "22436", trainName: "New Delhi - Varanasi Vande Bharat Express", fromCode: "NDLS", toCode: "BSB", departureIst: "06:00", classes: ["EC", "CC"] },
  { trainNo: "22435", trainName: "Varanasi - New Delhi Vande Bharat Express", fromCode: "BSB", toCode: "NDLS", departureIst: "15:00", classes: ["EC", "CC"] },
  { trainNo: "12301", trainName: "Howrah - New Delhi Rajdhani Express", fromCode: "HWH", toCode: "NDLS", departureIst: "16:50", classes: ["1A", "2A", "3A"] },
  { trainNo: "12302", trainName: "New Delhi - Howrah Rajdhani Express", fromCode: "NDLS", toCode: "HWH", departureIst: "16:50", classes: ["1A", "2A", "3A"] },
  { trainNo: "12309", trainName: "Rajendra Nagar - New Delhi Tejas Rajdhani", fromCode: "RJPB", toCode: "NDLS", departureIst: "19:10", classes: ["1A", "2A", "3A"] },
  { trainNo: "12310", trainName: "New Delhi - Rajendra Nagar Tejas Rajdhani", fromCode: "NDLS", toCode: "RJPB", departureIst: "17:10", classes: ["1A", "2A", "3A"] },
  { trainNo: "12903", trainName: "Golden Temple Mail", fromCode: "MMCT", toCode: "ASR", departureIst: "18:45", classes: ["1A", "2A", "3A", "SL"] },
  { trainNo: "12904", trainName: "Golden Temple Mail", fromCode: "ASR", toCode: "MMCT", departureIst: "18:55", classes: ["1A", "2A", "3A", "SL"] },
  { trainNo: "12801", trainName: "Purushottam Express", fromCode: "PURI", toCode: "NDLS", departureIst: "21:55", classes: ["2A", "3A", "SL"] },
  { trainNo: "12802", trainName: "Purushottam Express", fromCode: "NDLS", toCode: "PURI", departureIst: "22:40", classes: ["2A", "3A", "SL"] },
  { trainNo: "12423", trainName: "Dibrugarh - New Delhi Rajdhani Express", fromCode: "DBRG", toCode: "NDLS", departureIst: "20:55", classes: ["1A", "2A", "3A"] },
  { trainNo: "12424", trainName: "New Delhi - Dibrugarh Rajdhani Express", fromCode: "NDLS", toCode: "DBRG", departureIst: "16:20", classes: ["1A", "2A", "3A"] },
  { trainNo: "12431", trainName: "Thiruvananthapuram Central Rajdhani Express", fromCode: "TVC", toCode: "NZM", departureIst: "19:15", classes: ["1A", "2A", "3A"] },
  { trainNo: "12432", trainName: "Hazrat Nizamuddin - Thiruvananthapuram Rajdhani", fromCode: "NZM", toCode: "TVC", departureIst: "06:16", classes: ["1A", "2A", "3A"] },
  { trainNo: "12723", trainName: "Telangana Express", fromCode: "HYB", toCode: "NDLS", departureIst: "06:25", classes: ["1A", "2A", "3A", "SL"] },
  { trainNo: "12724", trainName: "Telangana Express", fromCode: "NDLS", toCode: "HYB", departureIst: "16:00", classes: ["1A", "2A", "3A", "SL"] },
  { trainNo: "12621", trainName: "Tamil Nadu Express", fromCode: "MAS", toCode: "NDLS", departureIst: "22:00", classes: ["1A", "2A", "3A", "SL"] },
  { trainNo: "12622", trainName: "Tamil Nadu Express", fromCode: "NDLS", toCode: "MAS", departureIst: "21:05", classes: ["1A", "2A", "3A", "SL"] },
  { trainNo: "12259", trainName: "Sealdah - Bikaner Duronto Express", fromCode: "SDAH", toCode: "BKN", departureIst: "17:00", classes: ["1A", "2A", "3A"] },
  { trainNo: "12260", trainName: "Bikaner - Sealdah Duronto Express", fromCode: "BKN", toCode: "SDAH", departureIst: "12:15", classes: ["1A", "2A", "3A"] },
  { trainNo: "12049", trainName: "Gatimaan Express", fromCode: "NZM", toCode: "VGLJ", departureIst: "08:10", classes: ["EC", "CC"] },
  { trainNo: "12050", trainName: "Gatimaan Express", fromCode: "VGLJ", toCode: "NZM", departureIst: "15:05", classes: ["EC", "CC"] },
  { trainNo: "22221", trainName: "CSMT - Hazrat Nizamuddin Rajdhani Express", fromCode: "CSMT", toCode: "NZM", departureIst: "16:00", classes: ["1A", "2A", "3A"] },
  { trainNo: "22222", trainName: "Hazrat Nizamuddin - CSMT Rajdhani Express", fromCode: "NZM", toCode: "CSMT", departureIst: "16:55", classes: ["1A", "2A", "3A"] },
  { trainNo: "12841", trainName: "Coromandel Express", fromCode: "SHM", toCode: "MAS", departureIst: "15:20", classes: ["1A", "2A", "3A", "SL"] },
  { trainNo: "12842", trainName: "Coromandel Express", fromCode: "MAS", toCode: "SHM", departureIst: "07:00", classes: ["1A", "2A", "3A", "SL"] },
  { trainNo: "12137", trainName: "Punjab Mail", fromCode: "CSMT", toCode: "FZR", departureIst: "19:35", classes: ["1A", "2A", "3A", "SL"] },
  { trainNo: "12138", trainName: "Punjab Mail", fromCode: "FZR", toCode: "CSMT", departureIst: "21:40", classes: ["1A", "2A", "3A", "SL"] },
  { trainNo: "12953", trainName: "August Kranti Tejas Rajdhani Express", fromCode: "MMCT", toCode: "NZM", departureIst: "17:10", classes: ["1A", "2A", "3A"] },
  { trainNo: "12954", trainName: "August Kranti Tejas Rajdhani Express", fromCode: "NZM", toCode: "MMCT", departureIst: "17:15", classes: ["1A", "2A", "3A"] },
  { trainNo: "12615", trainName: "Grand Trunk Express", fromCode: "MAS", toCode: "NDLS", departureIst: "18:50", classes: ["1A", "2A", "3A", "SL"] },
  { trainNo: "12616", trainName: "Grand Trunk Express", fromCode: "NDLS", toCode: "MAS", departureIst: "16:10", classes: ["1A", "2A", "3A", "SL"] },
];

const STATIONS: ReadonlyArray<readonly [string, string]> = [
  ["NDLS", "New Delhi"],
  ["MMCT", "Mumbai Central"],
  ["HWH", "Howrah"],
  ["MAS", "Chennai Central"],
  ["SBC", "KSR Bengaluru"],
  ["ADI", "Ahmedabad"],
  ["PUNE", "Pune"],
  ["HYB", "Hyderabad"],
  ["PNBE", "Patna"],
  ["LKO", "Lucknow"],
  ["JP", "Jaipur"],
  ["BPL", "Bhopal"],
  ["NGP", "Nagpur"],
  ["BSB", "Varanasi"],
  ["CNB", "Kanpur"],
  ["GHY", "Guwahati"],
  ["BBS", "Bhubaneswar"],
  ["ERS", "Ernakulam"],
];

const DEP_CLOCKS = [
  "05:45",
  "06:30",
  "07:15",
  "08:40",
  "10:20",
  "13:10",
  "16:15",
  "17:45",
  "19:10",
  "20:30",
  "21:50",
  "22:45",
] as const;

function buildTopTrains(): TrainCatalogItem[] {
  const items: TrainCatalogItem[] = [...CURATED_TRAINS];
  const seen = new Set(items.map((t) => t.trainNo));

  for (let num = 11001; num < 23000 && items.length < 3000; num += 1) {
    const tno = String(num);
    if (seen.has(tno)) continue;
    seen.add(tno);

    const [frmCode, frmName] = STATIONS[num % STATIONS.length]!;
    let [toCode, toName] = STATIONS[(num * 7 + 3) % STATIONS.length]!;
    if (toCode === frmCode) {
      [toCode, toName] = STATIONS[(num + 1) % STATIONS.length]!;
    }

    let classes: string[];
    let kind: string;
    if (tno.startsWith("120") || tno.startsWith("224") || tno.startsWith("209")) {
      classes = ["EC", "CC"];
      kind = tno.startsWith("120") ? "Shatabdi / Chair Car Express" : "Vande Bharat Express";
    } else if (
      tno.startsWith("129") ||
      tno.startsWith("123") ||
      tno.startsWith("124") ||
      tno.startsWith("222")
    ) {
      classes = ["1A", "2A", "3A"];
      kind = "Superfast AC Express";
    } else {
      classes = ["2A", "3A", "SL"];
      kind = num >= 12000 ? "Superfast Express" : "Mail Express";
    }

    items.push({
      trainNo: tno,
      trainName: `${frmName} - ${toName} ${kind}`,
      fromCode: frmCode,
      toCode,
      departureIst: DEP_CLOCKS[num % DEP_CLOCKS.length]!,
      classes,
    });
  }

  return items;
}

export const TOP_TRAINS: TrainCatalogItem[] = buildTopTrains();

const TRAIN_BY_NO: Map<string, TrainCatalogItem> = new Map(
  TOP_TRAINS.map((t) => [t.trainNo, t])
);

export function isValidTrainNo(trainNo: string): boolean {
  const cleaned = trainNo.trim();
  if (cleaned === "00000") return false;
  return /^[1-9][0-9]{4}$/.test(cleaned);
}

export function getTrainMeta(trainNo: string): TrainCatalogItem | null {
  const cleaned = trainNo.trim();
  if (!isValidTrainNo(cleaned)) return null;
  const known = TRAIN_BY_NO.get(cleaned);
  if (known) return known;
  return {
    trainNo: cleaned,
    trainName: `Express ${cleaned}`,
    fromCode: "NDLS",
    toCode: "MMCT",
    departureIst: cleaned.startsWith("120") || cleaned.startsWith("224") ? "07:30" : "17:30",
    classes: ["2A", "3A", "SL"],
  };
}

export function computeFallbackChartTime(
  trainNo: string,
  serviceDateIso?: string
): { train_no: string; date: string; chart_due_at: string; rule: string } {
  const meta = getTrainMeta(trainNo);
  const depIst = meta?.departureIst ?? "17:30";
  const [hhStr, mmStr] = depIst.split(":");
  const hh = Number.parseInt(hhStr ?? "17", 10);
  const mm = Number.parseInt(mmStr ?? "30", 10);
  const dateStr = serviceDateIso ?? new Date().toISOString().slice(0, 10);

  const [y, m, d] = dateStr.split("-").map((p) => Number.parseInt(p, 10));
  const depUtcMs = Date.UTC(y || 2026, (m || 1) - 1, d || 1, hh, mm) - 330 * 60 * 1000;
  const isMorningWindow = hh >= 5 && (hh < 14 || (hh === 14 && mm === 0));

  let chartUtcMs: number;
  let rule: string;
  if (isMorningWindow) {
    // Previous day 20:00 IST -> UTC
    chartUtcMs = Date.UTC(y || 2026, (m || 1) - 1, (d || 1) - 1, 20, 0) - 330 * 60 * 1000;
    rule = "dec2025_morning_prev_20_ist";
  } else {
    chartUtcMs = depUtcMs - 10 * 3600 * 1000;
    rule = "dec2025_standard_10h_before";
  }

  return {
    train_no: trainNo.trim(),
    date: dateStr,
    chart_due_at: new Date(chartUtcMs).toISOString(),
    rule,
  };
}
