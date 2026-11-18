// Ежедневный сбор данных для сайта: ставки центробанков, инфляция, безработица, даты заседаний, календарь «Что ждать».
//
// Запуск у себя:   npm run update-data      (ключ FRED берётся из файла .env)
// Запуск в GitHub: .github/workflows/update-data.yml, раз в день по расписанию
//
// Результат — data/data.json. Если источник не ответил, в файле остаётся прошлое значение
// с прошлой датой проверки (checkedAt), и сайт покажет, что оно устарело.
// Если не ответил хотя бы один источник, скрипт завершается с ошибкой,
// и GitHub пришлёт владельцу письмо о неудачном запуске.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { CONFIG } from "../js/config.js";

const OUT = new URL("../data/data.json", import.meta.url);
const HEADERS = { "User-Agent": "ekonomika-dashboard/1.0" };
const today = new Date().toISOString().slice(0, 10);
const startYear = (yearsBack) => `${new Date().getUTCFullYear() - yearsBack}-01-01`;
const round1 = (v) => Math.round(v * 10) / 10;
const pad = (n) => String(n).padStart(2, "0");

// «2026-10» → «2026-09»
const prevMonth = (period) => {
  const [y, m] = period.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
};
// Значение «месяцем ранее» — только если это действительно соседний месяц, а не более старый.
const prevIfAdjacent = (last, prev) => (prev && prev.period === prevMonth(last.period) ? prev.value : null);
// Последние месячные значения FRED (пустые месяцы пропущены), от новых к старым.
const fredMonthly = async (series, units) =>
  (await fred(series, `&units=${units}&sort_order=desc&limit=6`)).map((o) => ({ period: o.date.slice(0, 7), value: round1(o.value) }));

async function get(url, as = "json") {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    // В сообщение не попадает часть адреса после «?», там может быть ключ.
    const err = new Error(`HTTP ${res.status} от ${url.split("?")[0]}`);
    err.status = res.status;
    throw err;
  }
  return as === "json" ? res.json() : res.text();
}

// ---------- Источники ----------

async function fredApi(path, params) {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error("не задан FRED_API_KEY (см. README)");
  return get(`https://api.stlouisfed.org/fred/${path}?api_key=${key}&file_type=json${params}`);
}

async function fred(series, params) {
  const d = await fredApi("series/observations", `&series_id=${series}${params}`);
  return d.observations.filter((o) => o.value !== ".").map((o) => ({ date: o.date, value: Number(o.value) }));
}

// Текущее значение ставки, с какой даты действует и каким было до этого.
// obs — наблюдения по возрастанию даты. Если за всё окно ставка не менялась, дата неизвестна.
function lastChange(obs) {
  const last = obs.at(-1);
  let i = obs.length - 1;
  while (i > 0 && obs[i - 1].value === last.value) i--;
  return { value: last.value, since: i > 0 ? obs[i].date : null, prev: i > 0 ? obs[i - 1].value : null };
}

// GUS, переменная 305 «Wskaźniki cen towarów i usług konsumpcyjnych», раздел 1698 (COICOP 2018, данные с 2026 г.).
// Нужна строка «0 - OGÓŁEM» (14916914) по всем домохозяйствам (6902025)
// в виде «тот же месяц год назад = 100» (способ представления 5). Месяц m → период 246 + m.
async function gusCpi(year, month) {
  for (let page = 0; ; page++) {
    let d;
    try {
      d = await get(
        `https://api-dbw.stat.gov.pl/api/1.1.0/variable/variable-data-section?id-zmienna=305&id-przekroj=1698` +
          `&id-rok=${year}&id-okres=${246 + month}&ile-na-stronie=5000&numer-strony=${page}&lang=pl`,
      );
    } catch (err) {
      if (err.status === 404) return null; // за этот месяц данных ещё нет
      throw err;
    }
    const row = d.data.find(
      (r) => r["id-pozycja-2"] === 14916914 && r["id-pozycja-3"] === 6902025 && r["id-sposob-prezentacji-miara"] === 5,
    );
    if (row) return round1(row.wartosc - 100);
    if (d.data.length < 5000) return null;
  }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// ---------- Календарь «Что ждать» ----------

// Собираем на 2 недели вперёд, сайт показывает ближайшие 7 дней.
// Запас нужен, чтобы календарь не опустел, если сборщик несколько дней подряд не сработает.
const EVENT_DAYS = 14;
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

// Какие публикации США показывать: номер выпуска в FRED → название и подсказка.
const US_RELEASES = {
  10: { title: "Инфляция в США (CPI)", hint: "Насколько подорожали товары и услуги. От этого зависят решения ФРС." },
  50: { title: "Рынок труда США", hint: "Безработица и сколько новых рабочих мест появилось за месяц." },
  53: { title: "ВВП США", hint: "Насколько выросла или сжалась экономика США за квартал." },
  54: { title: "Расходы американцев и инфляция PCE", hint: "Сколько тратят люди и как растут цены. Эту инфляцию ФРС смотрит в первую очередь." },
  9: { title: "Розничные продажи в США", hint: "Сколько люди потратили в магазинах за месяц." },
};

// Какие публикации еврозоны показывать: название в календаре Eurostat → название и подсказка.
const EU_RELEASES = {
  "Flash estimate inflation euro area": { title: "Инфляция в еврозоне — первая оценка", hint: "Насколько подорожали товары и услуги. От этого зависят решения ЕЦБ." },
  "Inflation (HICP)": { title: "Инфляция в еврозоне — итоговые данные", hint: "Уточнение первой оценки, обычно почти без изменений." },
  "Preliminary flash estimate GDP - EU and euro area": { title: "ВВП еврозоны — первая оценка", hint: "Насколько выросла или сжалась экономика еврозоны за квартал." },
  Unemployment: { title: "Безработица в еврозоне", hint: "Доля людей, которые ищут работу и пока не нашли." },
};

// Отчёты: компании из нашего списка и все, кто дороже $200 млрд.
const BIG_COMPANY_CAP = 200e9;
const EARNINGS_TIME = { "time-pre-market": "до открытия биржи в США", "time-after-hours": "после закрытия биржи в США" };
// «Palo Alto Networks, Inc.» → «Palo Alto Networks», «Alibaba Group Holding Limited» → «Alibaba»
const shortName = (name) => name.replace(/,?\s+(Group|Holdings?|Inc|Incorporated|Corp|Corporation|Company|Ltd|Limited|plc|N\.V|S\.A|SE|AG)\b.*$/i, "");

const tasks = {
  async fedRate() {
    const params = `&observation_start=${startYear(5)}`;
    const [upper, lower] = await Promise.all([fred("DFEDTARU", params), fred("DFEDTARL", params)]);
    const up = lastChange(upper);
    const low = lastChange(lower);
    return {
      value: up.value,
      low: low.value,
      since: up.since,
      prev: up.prev,
      prevLow: low.prev,
      source: "FRED",
      url: "https://fred.stlouisfed.org/series/DFEDTARU",
    };
  },

  async ecbRate() {
    const csv = await get(
      `https://data-api.ecb.europa.eu/service/data/FM/D.U2.EUR.4F.KR.DFR.LEV?startPeriod=${startYear(5)}&format=csvdata&detail=dataonly`,
      "text",
    );
    const obs = csv
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.split(","))
      .map((f) => ({ date: f.at(-2), value: Number(f.at(-1)) }));
    return { ...lastChange(obs), source: "ECB", url: "https://data.ecb.europa.eu/data/datasets/FM/FM.D.U2.EUR.4F.KR.DFR.LEV" };
  },

  async nbpRate() {
    const url = "https://static.nbp.pl/dane/stopy/stopy_procentowe.xml";
    const ref = (await get(url, "text")).match(/<pozycja[^>]*id="ref"[^>]*>/)?.[0] || "";
    const value = ref.match(/oprocentowanie="([\d,]+)"/)?.[1];
    if (!value) throw new Error("в XML NBP не нашлась референсная ставка");
    return { value: Number(value.replace(",", ".")), since: ref.match(/obowiazuje_od="([\d-]+)"/)?.[1] ?? null, prev: null, source: "NBP", url };
  },

  // Месяц может быть пустым: за октябрь 2025 BLS цены не собирал (остановка работы правительства США),
  // поэтому годового изменения за октябрь 2026 нет. Тогда берём последний месяц, за который оно есть.
  async usInflation() {
    const [last, prev] = await fredMonthly("CPIAUCNS", "pc1");
    if (!last) throw new Error("FRED не вернул значений CPI");
    return { ...last, prev: prevIfAdjacent(last, prev), source: "FRED (BLS)", url: "https://fred.stlouisfed.org/series/CPIAUCNS" };
  },

  async euInflation() {
    const d = await get(
      "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_minr?geo=EA&unit=RCH_A&coicop18=TOTAL&lastTimePeriod=3",
    );
    const points = Object.entries(d.dimension.time.category.index)
      .sort((a, b) => a[1] - b[1])
      .map(([period, i]) => ({ period, value: d.value[i], status: d.status?.[i] }))
      .filter((p) => p.value != null);
    const last = points.at(-1);
    if (!last) throw new Error("Eurostat не вернул значений");
    return {
      value: last.value,
      period: last.period,
      prev: prevIfAdjacent(last, points.at(-2)),
      preliminary: last.status === "e", // «e» у Eurostat — предварительная оценка
      source: "Eurostat",
      url: "https://ec.europa.eu/eurostat/databrowser/view/prc_hicp_minr/default/table",
    };
  },

  async plInflation() {
    const found = [];
    const now = new Date();
    for (let back = 0; back < 6 && found.length < 2; back++) {
      const m = new Date(now.getFullYear(), now.getMonth() - back, 1);
      const value = await gusCpi(m.getFullYear(), m.getMonth() + 1);
      if (value != null) found.push({ period: `${m.getFullYear()}-${pad(m.getMonth() + 1)}`, value });
    }
    if (!found.length) throw new Error("GUS: нет данных за последние полгода");
    return {
      value: found[0].value,
      period: found[0].period,
      prev: prevIfAdjacent(found[0], found[1]),
      source: "GUS",
      url: "https://api-dbw.stat.gov.pl/",
    };
  },

  async usUnemployment() {
    const [last, prev] = await fredMonthly("UNRATE", "lin");
    if (!last) throw new Error("FRED не вернул значений безработицы");
    return { ...last, prev: prevIfAdjacent(last, prev), source: "FRED (BLS)", url: "https://fred.stlouisfed.org/series/UNRATE" };
  },

  // Дни решений ФРС: последний день каждого заседания из официального календаря.
  async fedMeetings() {
    const url = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
    const html = await get(url, "text");
    const dates = new Set();
    for (const [, year, panel] of html.matchAll(/(\d{4}) FOMC Meetings([\s\S]*?)(?=\d{4} FOMC Meetings|$)/g)) {
      const rows = panel.matchAll(/fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)</g);
      for (const [, monthText, daysText] of rows) {
        const months = monthText.split("/").map((m) => MONTHS.indexOf(m.trim().slice(0, 3).toLowerCase()));
        const days = (daysText.match(/\d+/g) || []).map(Number);
        if (!days.length || months.includes(-1)) continue;
        const day = days.at(-1);
        const month = months.length > 1 && day < days[0] ? months[1] : months[0]; // «Oct/Nov 31-1»
        dates.add(`${year}-${pad(month + 1)}-${pad(day)}`);
      }
    }
    return upcoming([...dates], url);
  },

  // Дни решений ЕЦБ: второй день заседания по денежной политике, после него пресс-конференция.
  async ecbMeetings() {
    const url = "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html";
    const html = await get(url, "text");
    const dates = [];
    for (const [, d, m, y, text] of html.matchAll(/<dt>\s*(\d{2})\/(\d{2})\/(\d{4})\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) {
      if (/monetary policy meeting/i.test(text) && !/non-monetary/i.test(text) && /press conference/i.test(text)) {
        dates.push(`${y}-${m}-${d}`);
      }
    }
    return upcoming(dates, url);
  },

  async nbpMeetings() {
    const { decisionDays, source } = CONFIG.nbpMeetings;
    return upcoming(decisionDays, source);
  },

  async usReleases() {
    const d = await fredApi(
      "releases/dates",
      `&realtime_start=${today}&realtime_end=${addDays(today, EVENT_DAYS)}&include_release_dates_with_no_data=true&limit=1000`,
    );
    const events = d.release_dates.filter((r) => US_RELEASES[r.release_id]).map((r) => ({ date: r.date, ...US_RELEASES[r.release_id] }));
    return { events, source: "FRED", url: "https://fred.stlouisfed.org/releases/calendar" };
  },

  // Тот же запрос, что делает страница календаря Eurostat; время в ответе — по Люксембургу.
  async euReleases() {
    const range = (iso) => encodeURIComponent(`${iso}T00:00:00+01:00`);
    const list = await get(
      "https://ec.europa.eu/eurostat/o/calendars/eventsJson?theme=0&category=0&keywords=&isEuroindicator=true&authorInclude=&authorExclude=" +
        `&start=${range(today)}&end=${range(addDays(today, EVENT_DAYS + 1))}&timeZone=Europe%2FLuxembourg`,
    );
    const events = list.filter((e) => EU_RELEASES[e.title]).map((e) => ({ date: e.start.slice(0, 10), ...EU_RELEASES[e.title] }));
    return { events, source: "Eurostat", url: "https://ec.europa.eu/eurostat/web/main/news/release-calendar" };
  },

  // Календарь Nasdaq знает только компании с американских бирж, поэтому польских отчётов здесь нет.
  async earnings() {
    const ours = new Map(CONFIG.companies.map((c) => [c.symbol, c.name]));
    const events = [];
    for (let i = 0; i <= EVENT_DAYS; i++) {
      const date = addDays(today, i);
      const d = await get(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`);
      if (d.status?.rCode !== 200) throw new Error(`Nasdaq ответил кодом ${d.status?.rCode} за ${date}`);
      for (const r of d.data?.rows || []) {
        const cap = Number(r.marketCap.replace(/[$,]/g, ""));
        if (!ours.has(r.symbol) && !(cap >= BIG_COMPANY_CAP)) continue;
        events.push({ date, name: ours.get(r.symbol) || shortName(r.name), when: EARNINGS_TIME[r.time] ?? null });
      }
    }
    return { events, source: "Nasdaq", url: "https://www.nasdaq.com/market-activity/earnings" };
  },
};

function upcoming(dates, url) {
  const future = [...new Set(dates)].filter((d) => d >= today).sort();
  if (!future.length) throw new Error(`не нашлось будущих заседаний (${url})`);
  return { dates: future, source: new URL(url).hostname, url };
}

// ---------- Запуск ----------

const previous = await readFile(OUT, "utf8")
  .then(JSON.parse)
  .catch(() => ({ items: {} }));
const items = { ...previous.items };
const failed = [];

await Promise.all(
  Object.entries(tasks).map(async ([name, task]) => {
    try {
      items[name] = { ...(await task()), checkedAt: new Date().toISOString() };
      console.log(`✓ ${name}`);
    } catch (err) {
      failed.push(name);
      console.error(`✗ ${name}: ${err.message}`);
    }
  }),
);

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(OUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), items }, null, 2)}\n`);
console.log(`Записано в data/data.json. ${failed.length ? `Не ответили: ${failed.join(", ")}` : "Все источники ответили."}`);
if (failed.length) process.exitCode = 1;
