import { CONFIG } from "./config.js";
import { WORDS } from "./words.js";

const PROXY = (CONFIG.quotesProxy || "/api").replace(/\/+$/, "");
const REFRESH_MS = CONFIG.refreshSeconds * 1000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CLOSED_AFTER = 30 * MINUTE; // нет новых цен полчаса → торги не идут
// Столбцы изменений: ключ, заголовок, короткая подпись на телефоне, подсказка.
const PERIODS = [
  ["h1", "1 час", "1 ч", "Как изменилась цена за последние 60 минут."],
  ["d1", "День", "день", "По сравнению с ценой закрытия прошлого торгового дня. У криптовалют — за последние 24 часа."],
  ["w1", "Неделя", "нед.", "По сравнению с ценой 7 дней назад."],
  ["m1", "Месяц", "мес.", "По сравнению с ценой месяц назад."],
  ["y1", "Год", "год", "По сравнению с ценой год назад."],
];

const toAsset = (section) => (a) => ({ ...a, section, live: null, hist: null, liveAt: 0, histAt: 0, failed: false });
const assets = [...CONFIG.markets.map(toAsset("markets")), ...CONFIG.companies.map(toAsset("companies"))];
assets.forEach((a, i) => (a.id = `a${i}`));
const markets = assets.filter((a) => a.section === "markets");
const companies = assets.filter((a) => a.section === "companies");
const sparks = new Map(); // id мини-графика → точки и масштаб, для подсказки при наведении
let lastRefresh = 0;
let timer = null;
let busy = false;
let focus = null; // id компании, открытой в большом графике
let focusRange = "m1";
let focusWidth = 0;

const $ = (id) => document.getElementById(id);
const phone = matchMedia("(max-width: 720px)");

// ---------- Загрузка данных ----------

async function getJSON(url, fresh) {
  const res = await fetch(url, fresh ? { cache: "no-store" } : {});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const needsHistory = (a, now) => !a.hist || now - a.histAt > HOUR;

async function load(a, now) {
  const sym = encodeURIComponent(a.symbol);
  const [live, hist] = await Promise.allSettled([
    getJSON(`${PROXY}/chart?symbol=${sym}&range=2d`, true),
    needsHistory(a, now) ? getJSON(`${PROXY}/chart?symbol=${sym}&range=1y`) : null,
  ]);
  if (live.status === "fulfilled") Object.assign(a, { live: live.value, liveAt: now, failed: false });
  else a.failed = true;
  if (hist.status === "fulfilled" && hist.value) Object.assign(a, { hist: hist.value, histAt: now });
}

// Обновляем только пока вкладка видна; при возвращении на вкладку — сразу.
async function refresh() {
  if (busy) return;
  busy = true;
  clearTimeout(timer);
  const now = Date.now();
  await Promise.all(assets.map((a) => load(a, now)));
  lastRefresh = Date.now();
  busy = false;
  render();
  timer = setTimeout(() => document.hidden || refresh(), REFRESH_MS);
}

// ---------- Расчёт изменений ----------

const pct = (price, base) => (price == null || !base ? null : (price / base - 1) * 100);
const monthsAgo = (now, n) => {
  const d = new Date(now);
  d.setMonth(d.getMonth() - n);
  return d.getTime();
};
const dayKey = (ms) => new Date(ms).toDateString();

// Последняя цена в момент ts (секунды) или раньше.
function priceAt(t, c, ts) {
  let v = null;
  for (let i = 0; i < t.length && t[i] <= ts; i++) if (c[i] != null) v = c[i];
  return v;
}

// Цена закрытия на дату target (мс). Если история начинается чуть позже — берём первый день.
function closeOn(hist, target) {
  const v = priceAt(hist.t, hist.c, target / 1000);
  if (v != null) return v;
  const first = hist.c.findIndex((x) => x != null);
  return first >= 0 && hist.t[first] * 1000 - target < 5 * DAY ? hist.c[first] : null;
}

function view(a, now) {
  if (!a.live) return null;
  const L = a.live;
  const time = L.time * 1000;
  const closed = now - time > CLOSED_AFTER;
  // Криптовалюты торгуются круглосуточно: «день» для них — последние 24 часа.
  const dayBase = a.kind === "crypto" ? priceAt(L.t, L.c, L.time - 86400) : L.prevClose;
  const ch = {
    h1: closed ? null : pct(L.price, priceAt(L.t, L.c, L.time - 3600) ?? L.prevClose),
    d1: pct(L.price, dayBase),
    w1: null,
    m1: null,
    y1: null,
  };
  let spark = [];
  if (a.hist) {
    const H = a.hist;
    ch.w1 = pct(L.price, closeOn(H, now - 7 * DAY));
    ch.m1 = pct(L.price, closeOn(H, monthsAgo(now, 1)));
    ch.y1 = pct(L.price, closeOn(H, monthsAgo(now, 12)));
    spark = histPoints(H, monthsAgo(now, 1), time, L.price);
  }
  return { price: L.price, currency: L.currency, time, closed, ch, spark };
}

// Точки графика: цены закрытия начиная с from (мс), последней — текущая цена.
function histPoints(H, from, time, price) {
  const points = H.t
    .map((t, i) => [t * 1000, H.c[i]])
    .filter(([t, v]) => v != null && t >= from && dayKey(t) !== dayKey(time));
  points.push([time, price]);
  return points;
}

// ---------- Форматирование ----------

const nf = (d) => new Intl.NumberFormat("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtPct = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" });
const CURRENCY = { USD: "$", PLN: "zł", EUR: "€" };
const NBSP = "\u00a0"; // неразрывный пробел: «3,5 %» не разъезжается на две строки
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function decimals(a, price) {
  if (a.kind === "fx") return 4;
  if (a.kind === "crypto" && price >= 1000) return 0;
  return 2;
}

function fmtPrice(a, price, currency) {
  const num = nf(decimals(a, price)).format(price);
  return a.kind === "index" ? num : `${num}${NBSP}${esc(CURRENCY[currency] || currency || "")}`.trim();
}

function fmtStamp(ms) {
  const sameDay = dayKey(ms) === dayKey(Date.now());
  return new Date(ms).toLocaleString("ru-RU", sameDay ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const fmtSigned = (v) => `${fmtPct.format(v).replace("-", "−")}${NBSP}%`;

// ---------- Отрисовка ----------

const tipButton = (text) => `<button type="button" class="tip" aria-label="Подсказка" data-tip="${esc(text)}">?</button>`;

function headHtml(first) {
  return `<tr>
    <th scope="col" class="c-name">${first}</th>
    <th scope="col">Цена</th>
    ${PERIODS.map(([, title, , hint]) => `<th scope="col">${title} ${tipButton(hint)}</th>`).join("")}
    <th scope="col" class="c-spark">За месяц ${tipButton("Как менялась цена последний месяц. Наведите или коснитесь графика, чтобы увидеть цену на конкретную дату.")}</th>
  </tr>`;
}

const chgClass = (value) => (Math.abs(value) < 0.005 ? "flat" : value > 0 ? "up" : "down");
const naWhy = (v, key) => (key === "h1" && v.closed ? "Биржа закрыта — за последний час цена не менялась" : "нет данных");

function changeCell(v, key, label) {
  const value = v.ch[key];
  if (value == null) return `<td class="chg na" data-label="${label}" title="${naWhy(v, key)}">—</td>`;
  return `<td class="chg ${chgClass(value)}" data-label="${label}">${fmtSigned(value)}</td>`;
}

function sparkSvg(a, points, currency) {
  if (points.length < 2) return `<span class="chg na" title="нет данных">—</span>`;
  const [W, H, P] = phone.matches ? [96, 32, 4] : [120, 36, 4];
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [x0, x1, y0, y1] = [xs[0], xs.at(-1), Math.min(...ys), Math.max(...ys)];
  const X = (t) => P + ((W - 2 * P) * (t - x0)) / (x1 - x0 || 1);
  const Y = (v) => H - P - ((H - 2 * P) * (v - y0)) / (y1 - y0 || 1);
  const d = points.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
  const up = ys.at(-1) >= ys[0];
  sparks.set(a.id, { a, points, currency, X, Y });
  return `<svg class="spark ${up ? "up" : "down"}" data-id="${a.id}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
      role="img" aria-label="${esc(a.name)}: график за месяц, ${up ? "рост" : "падение"}">
    <line class="cross" y1="0" y2="${H}"/>
    <path d="${d}"/>
    <circle class="end" cx="${X(xs.at(-1)).toFixed(1)}" cy="${Y(ys.at(-1)).toFixed(1)}" r="3"/>
    <circle class="hover" r="3.5"/>
  </svg>`;
}

function rowNote(a, v) {
  if (v && a.failed) return `<span class="note warn">⚠ не обновилось · данные на ${fmtStamp(a.liveAt)}</span>`;
  if (v?.closed) return `<span class="note">биржа закрыта · цена на ${fmtStamp(v.time)}</span>`;
  return "";
}

function rowHtml(a, now) {
  const v = view(a, now);
  // Компанию можно открыть: нажатие на строку показывает большой график наверху блока.
  const open = a.section === "companies";
  const tr = open ? `<tr data-open="${a.id}"${a.id === focus ? ` class="sel"` : ""}>` : "<tr>";
  const title = open ? `<button type="button" class="name">${esc(a.name)}</button>` : `<span class="name">${esc(a.name)}</span>`;
  const name = `<th scope="row" class="c-name">${title}<span class="hint">${esc(a.hint)}</span>${rowNote(a, v)}</th>`;
  if (!v) return `${tr}${name}<td class="nodata" colspan="7">нет данных — источник не ответил</td></tr>`;
  return `${tr}${name}
    <td class="c-price">${fmtPrice(a, v.price, v.currency)}</td>
    ${PERIODS.map(([key, , label]) => changeCell(v, key, label)).join("")}
    <td class="c-spark">${sparkSvg(a, v.spark, v.currency)}</td>
  </tr>`;
}

function renderTable(id, list, now) {
  let group = null;
  const rows = [];
  for (const a of list) {
    if (a.group !== group) {
      group = a.group;
      rows.push(`<tr class="group"><th colspan="8" scope="colgroup">${esc(group)}</th></tr>`);
    }
    rows.push(rowHtml(a, now));
  }
  $(id).innerHTML = rows.join("");
}

// «Топ-5 растут / падают»: компании с самым большим изменением за день.
function renderMovers(now) {
  const withDay = companies.map((a) => ({ a, v: view(a, now) })).filter(({ v }) => v?.ch.d1 != null);
  const item = ({ a, v }) => `<li data-open="${a.id}">
      <button type="button" class="m-name">${esc(a.name)}</button>
      <span class="m-price">${fmtPrice(a, v.price, v.currency)}</span>
      <span class="chg ${v.ch.d1 > 0 ? "up" : "down"}">${fmtSigned(v.ch.d1)}</span>
    </li>`;
  const fill = (id, list, emptyText) => {
    $(id).innerHTML = !withDay.length
      ? `<li class="empty">нет данных</li>`
      : list.length
        ? list.map(item).join("")
        : `<li class="empty">${emptyText}</li>`;
  };
  const byDay = (x, y) => y.v.ch.d1 - x.v.ch.d1;
  fill("movers-up", withDay.filter(({ v }) => v.ch.d1 >= 0.005).sort(byDay).slice(0, 5), "Ни одна компания из списка не выросла");
  fill("movers-down", withDay.filter(({ v }) => v.ch.d1 <= -0.005).sort(byDay).reverse().slice(0, 5), "Ни одна компания из списка не упала");
}

// ---------- Большой график компании ----------

// Кнопки периода. axis — подписи дат под графиком, tip — дата в подсказке при наведении.
const FOCUS_RANGES = [
  { key: "d1", title: "День", what: "за день", axis: { hour: "2-digit", minute: "2-digit" }, tip: { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" } },
  { key: "m1", title: "Месяц", what: "за месяц", axis: { day: "numeric", month: "short" }, tip: { day: "numeric", month: "long" } },
  { key: "y1", title: "Год", what: "за год", axis: { month: "short", year: "numeric" }, tip: { day: "numeric", month: "long", year: "numeric" } },
  { key: "max", title: "Всё время", what: "за всё время", axis: { year: "numeric" }, tip: { month: "long", year: "numeric" } },
];

// История за всё время нужна редко — загружаем, только когда нажали «Всё время».
async function loadMax(a) {
  a.maxState = "loading";
  try {
    a.max = await getJSON(`${PROXY}/chart?symbol=${encodeURIComponent(a.symbol)}&range=max`);
    a.maxState = "ok";
  } catch {
    a.maxState = "failed";
  }
  renderFocus();
}

function focusPoints(a, v, key, now) {
  if (key === "d1") {
    // Акции — последний торговый день, криптовалюты — последние 24 часа.
    const L = a.live;
    const points = L.t
      .map((t, i) => [t * 1000, L.c[i]])
      .filter(([t]) => (a.kind === "crypto" ? t >= v.time - DAY : dayKey(t) === dayKey(v.time)));
    if (!points.length || points.at(-1)[0] < v.time) points.push([v.time, v.price]);
    return points;
  }
  const H = key === "max" ? a.max : a.hist;
  if (!H) return [];
  return histPoints(H, key === "m1" ? monthsAgo(now, 1) : key === "y1" ? monthsAgo(now, 12) : 0, v.time, v.price);
}

// «Круглые» значения для линий сетки: шаг 1, 2 или 5 × 10ⁿ.
function niceTicks(lo, hi) {
  const raw = (hi - lo) / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step / 1e6; v += step) ticks.push(v);
  return { ticks, digits: Math.max(0, -Math.floor(Math.log10(step))) };
}

function bigChartSvg(a, points, currency, range, base, cls) {
  const W = focusWidth;
  const H = phone.matches ? 200 : 260;
  const [P, B] = [8, 24]; // поля и место под даты внизу
  const ys = points.map((p) => p[1]);
  if (base != null) ys.push(base);
  let [lo, hi] = [Math.min(...ys), Math.max(...ys)];
  if (hi - lo < hi * 1e-6) [lo, hi] = [lo * 0.99, hi * 1.01];
  const { ticks, digits } = niceTicks(lo, hi);
  const labels = ticks.map((v) => nf(digits).format(v));
  const R = 12 + Math.max(...labels.map((s) => s.length)) * 7; // место под цены справа
  const [x0, x1] = [points[0][0], points.at(-1)[0]];
  const bottom = H - B - P;
  const X = (t) => P + ((W - R - P) * (t - x0)) / (x1 - x0 || 1);
  const Y = (v) => P + ((bottom - P) * (hi - v)) / (hi - lo);
  const d = points.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
  const grid = ticks
    .map((v, i) => `<line class="grid" x1="${P}" x2="${W - R + 6}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>
      <text x="${W}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${labels[i]}</text>`)
    .join("");
  const dates = [
    [x0, "start"],
    [(x0 + x1) / 2, "middle"],
    [x1, "end"],
  ]
    .map(([t, anchor]) => `<text x="${X(t).toFixed(1)}" y="${H - 6}" text-anchor="${anchor}">${new Date(t).toLocaleString("ru-RU", range.axis)}</text>`)
    .join("");
  const baseLine = base == null ? "" : `<line class="base" x1="${P}" x2="${W - R}" y1="${Y(base).toFixed(1)}" y2="${Y(base).toFixed(1)}"/>`;
  sparks.set("focus", { a, points, currency, X, Y, tip: range.tip });
  return `<svg class="spark big ${cls}" data-id="focus" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
      role="img" aria-label="${esc(a.name)}: график ${range.what}">
    ${grid}${dates}${baseLine}
    <line class="cross" y1="${P}" y2="${bottom}"/>
    <path d="${d}"/>
    <circle class="end" cx="${X(x1).toFixed(1)}" cy="${Y(points.at(-1)[1]).toFixed(1)}" r="4"/>
    <circle class="hover" r="5"/>
  </svg>`;
}

function renderFocus() {
  const box = $("focus");
  const a = companies.find((x) => x.id === focus);
  box.hidden = !a;
  if (!a) return;
  const now = Date.now();
  const v = view(a, now);
  const range = FOCUS_RANGES.find((r) => r.key === focusRange);
  if (v && range.key === "max" && !a.maxState) loadMax(a);
  const points = v ? focusPoints(a, v, range.key, now) : [];
  const change = !v ? null : range.key === "max" ? (points.length > 1 ? pct(v.price, points[0][1]) : null) : v.ch[range.key];
  const cls = change == null ? "flat" : chgClass(change);
  // Для дня рисуем пунктиром вчерашнюю цену закрытия: от неё считается изменение за день.
  const base = range.key === "d1" && a.kind !== "crypto" ? a.live?.prevClose : null;
  const stats = v
    ? `<div class="focus-stats">${PERIODS.map(([key, title]) => {
        const x = v.ch[key];
        return `<div><span class="fs-label">${title}</span>${
          x == null ? `<span class="chg na" title="${naWhy(v, key)}">—</span>` : `<span class="chg ${chgClass(x)}">${fmtSigned(x)}</span>`
        }</div>`;
      }).join("")}</div>`
    : "";

  box.innerHTML = `<div class="focus-head">
      <div>
        <p class="focus-group">${esc(a.group)}</p>
        <h3 class="focus-name">${esc(a.name)}</h3>
        <p class="hint">${esc(a.hint)}</p>
      </div>
      <button type="button" class="focus-close" data-close aria-label="Закрыть большой график">×</button>
    </div>
    ${v ? `<p class="focus-price"><strong>${fmtPrice(a, v.price, v.currency)}</strong>
      <span class="chg ${change == null ? "na" : cls}">${change == null ? "нет данных" : fmtSigned(change)} ${range.what}</span></p>` : ""}
    <div class="seg" role="group" aria-label="Период графика">
      ${FOCUS_RANGES.map((r) => `<button type="button" data-range="${r.key}" aria-pressed="${r.key === range.key}">${r.title}</button>`).join("")}
    </div>
    <div class="focus-chart" id="focus-chart"></div>
    ${base != null ? `<p class="note">Пунктир — цена закрытия прошлого торгового дня, от неё считается изменение за день.</p>` : ""}
    ${rowNote(a, v)}
    ${stats}`;

  const chart = $("focus-chart");
  focusWidth = chart.clientWidth;
  chart.innerHTML =
    range.key === "max" && a.maxState === "loading"
      ? `<p class="focus-msg">Загружаю историю…</p>`
      : points.length < 2
        ? `<p class="focus-msg">нет данных — источник не ответил</p>`
        : bigChartSvg(a, points, v.currency, range, base, cls);
}

function openFocus(id) {
  focus = id;
  render();
  if (id) $("focus").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

document.addEventListener("click", (e) => {
  const rangeBtn = e.target.closest?.("[data-range]");
  const row = e.target.closest?.("[data-open]");
  if (rangeBtn) {
    focusRange = rangeBtn.dataset.range;
    const a = companies.find((x) => x.id === focus);
    if (focusRange === "max" && a?.maxState === "failed") a.maxState = null; // нажали ещё раз — пробуем снова
    renderFocus();
  } else if (e.target.closest?.("[data-close]")) openFocus(null);
  else if (row) openFocus(row.dataset.open === focus ? null : row.dataset.open);
});
addEventListener("resize", () => focus && $("focus-chart")?.clientWidth !== focusWidth && renderFocus());

function render() {
  const now = Date.now();
  sparks.clear();
  renderTable("markets-body", markets, now);
  renderTable("companies-body", companies, now);
  renderMovers(now);
  renderFocus();
  renderStatus();
}

const fmtFull = (ms) => new Date(ms).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", second: "2-digit" });

function renderStatus() {
  const line = $("prices-line");
  const ok = assets.filter((a) => !a.failed).length;
  line.classList.toggle("ok", ok === assets.length);
  line.classList.toggle("error", ok === 0);
  const at = fmtFull(lastRefresh);
  $("updated-text").textContent =
    ok === 0
      ? `Не удалось получить цены (${at}). Проверьте интернет или адрес Worker в js/config.js.`
      : ok < assets.length
        ? `Цены обновлены: ${at}. Часть источников не ответила.`
        : `Цены обновлены: ${at}`;
}

function tick() {
  if (!lastRefresh) return;
  const left = Math.max(0, Math.round((lastRefresh + REFRESH_MS - Date.now()) / 1000));
  $("next").textContent = document.hidden ? "" : `· следующее через ${left} с`;
}

// ---------- Ставки и инфляция: data/data.json, его раз в день собирает GitHub Actions ----------

const STALE_AFTER = 2 * DAY;
const INFLATION_HINT = "На сколько процентов подорожали товары и услуги за год.";
const RATE_TILES = [
  { key: "fedRate", meet: "fedMeetings", title: "Ставка ФРС", region: "США", hint: "Коридор, в котором банки США одалживают друг другу деньги на ночь. Его задаёт ФРС." },
  { key: "ecbRate", meet: "ecbMeetings", title: "Ставка ЕЦБ", region: "еврозона", hint: "Процент, который ЕЦБ платит банкам за деньги на депозите, — главная ставка еврозоны." },
  { key: "nbpRate", meet: "nbpMeetings", title: "Ставка НБП", region: "Польша", hint: "Референсная ставка Нацбанка Польши: от неё зависят проценты по кредитам и вкладам в злотых." },
];
const MACRO_TILES = [
  { key: "usInflation", title: "Инфляция", region: "США", hint: INFLATION_HINT },
  { key: "euInflation", title: "Инфляция", region: "еврозона", hint: INFLATION_HINT },
  { key: "plInflation", title: "Инфляция", region: "Польша", hint: INFLATION_HINT },
  { key: "usUnemployment", title: "Безработица", region: "США", hint: "Доля людей, которые ищут работу и пока не нашли." },
];

let daily = null;

const isoToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const fmtDate = (iso, opts = { day: "numeric", month: "long", year: "numeric" }) => new Date(`${iso}T12:00:00`).toLocaleDateString("ru-RU", opts);
const fmtMonth = (period) => fmtDate(`${period}-15`, { month: "long", year: "numeric" });
const fmtRate = (v, d) => `${nf(d).format(v)}${NBSP}%`;
const fmtRange = (low, high) => (low != null ? `${nf(2).format(low)}–${fmtRate(high, 2)}` : fmtRate(high, 2));
const NA = `<p class="tile-value na">нет данных</p>`;

function daysWord(n) {
  const [m10, m100] = [n % 10, n % 100];
  if (m10 === 1 && m100 !== 11) return "день";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "дня";
  return "дней";
}

function tile(def, body, item) {
  const stale = item && isStale(item) ? `<p class="note warn">⚠ не обновлялось с ${fmtDay(item.checkedAt.slice(0, 10))}</p>` : "";
  const src = item ? `<a class="tile-src" href="${esc(item.url)}" target="_blank" rel="noopener">Источник: ${esc(item.source)}</a>` : "";
  return `<article class="tile">
    <h4 class="tile-label">${def.title} <span class="tile-region">· ${def.region}</span> ${tipButton(def.hint)}</h4>
    ${body}${stale}${src}
  </article>`;
}

// Сколько дней от сегодняшнего дня до даты «2026-11-25» (0 — сегодня, отрицательное — уже прошло).
const daysUntil = (iso) => Math.round((Date.parse(`${iso}T12:00:00`) - Date.parse(`${isoToday()}T12:00:00`)) / DAY);
const isStale = (item) => Date.now() - Date.parse(item.checkedAt) > STALE_AFTER;
const fmtDay = (iso) => fmtDate(iso, { day: "numeric", month: "long" });

function nextMeeting(m) {
  const next = m?.dates.find((d) => daysUntil(d) >= 0);
  if (!next) return `<p class="tile-next">Следующее решение: нет данных</p>`;
  const days = daysUntil(next);
  const when = days === 0 ? "сегодня" : days === 1 ? "завтра" : `через ${days}${NBSP}${daysWord(days)}`;
  return `<p class="tile-next">Следующее решение: <strong>${fmtDay(next)}</strong> (${when})</p>`;
}

function rateTile(def, items) {
  const r = items[def.key];
  const meta = r && [r.since && `с ${fmtDate(r.since)}`, r.prev != null && `было ${fmtRange(r.prevLow, r.prev)}`].filter(Boolean).join(" · ");
  const body = r ? `<p class="tile-value">${fmtRange(r.low, r.value)}</p>${meta ? `<p class="tile-meta">${meta}</p>` : ""}` : NA;
  return tile(def, body + nextMeeting(items[def.meet]), r);
}

function macroTile(def, items) {
  const x = items[def.key];
  const prev = x?.prev != null ? ` · месяцем ранее ${fmtRate(x.prev, 1)}` : "";
  const body = x
    ? `<p class="tile-value">${fmtRate(x.value, 1)}</p>
       <p class="tile-meta">за ${fmtMonth(x.period)}${x.preliminary ? " (предварительно)" : ""}${prev}</p>`
    : NA;
  return tile(def, body, x);
}

// ---------- Что ждать ----------

const EVENT_DAYS = 7;
const RATE_HINT = "Центробанк решает, менять ли ставку. В такой день валюты и акции часто сильно двигаются.";
const meetings = (title) => (x) => x.dates.map((date) => ({ date, title, hint: RATE_HINT }));
// Откуда берутся события. Порядок важен: внутри одного дня события идут в этом же порядке.
const EVENT_SOURCES = [
  { key: "fedMeetings", kind: "Ставка", what: "заседания ФРС", src: "ФРС", events: meetings("Решение по ставке ФРС (США)") },
  { key: "ecbMeetings", kind: "Ставка", what: "заседания ЕЦБ", src: "ЕЦБ", events: meetings("Решение по ставке ЕЦБ (еврозона)") },
  { key: "nbpMeetings", kind: "Ставка", what: "заседания НБП", src: "НБП", events: meetings("Решение по ставке НБП (Польша)") },
  { key: "usReleases", kind: "Данные", what: "статистика США", src: "FRED", events: (x) => x.events },
  { key: "euReleases", kind: "Данные", what: "статистика еврозоны", src: "Eurostat", events: (x) => x.events },
  {
    key: "earnings",
    kind: "Отчёт",
    what: "отчёты компаний",
    src: "Nasdaq",
    events: (x) => x.events.map((e) => ({ date: e.date, title: `${e.name} — отчёт за квартал`, hint: e.when && `Время: ${e.when}` })),
  },
];

function dayTitle(iso) {
  const label = fmtDate(iso, { weekday: "long", day: "numeric", month: "long" });
  const days = daysUntil(iso);
  if (days === 0) return `Сегодня, ${label}`;
  if (days === 1) return `Завтра, ${label}`;
  return label[0].toUpperCase() + label.slice(1);
}

function renderEvents(items) {
  const events = [];
  const notes = [];
  const sources = [];
  for (const s of EVENT_SOURCES) {
    const x = items[s.key];
    if (!x) {
      notes.push(`нет данных: ${s.what} — источник не ответил`);
      continue;
    }
    if (isStale(x)) notes.push(`⚠ ${s.what}: не обновлялось с ${fmtDay(x.checkedAt.slice(0, 10))}`);
    sources.push(`<a href="${esc(x.url)}" target="_blank" rel="noopener">${s.src}</a>`);
    for (const e of s.events(x)) {
      const days = daysUntil(e.date);
      if (days >= 0 && days <= EVENT_DAYS) events.push({ ...e, kind: s.kind });
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date)); // сортировка устойчивая, порядок источников внутри дня сохраняется

  const days = new Map();
  for (const e of events) days.set(e.date, [...(days.get(e.date) || []), e]);
  if (!sources.length) {
    $("events").innerHTML = `<p class="ev-empty">нет данных — календарь не загрузился</p>`;
    $("events-notes").innerHTML = $("events-src").innerHTML = "";
    return;
  }
  $("events").innerHTML = days.size
    ? [...days]
        .map(
          ([date, list]) => `<div class="ev-day">
      <h3 class="ev-date">${dayTitle(date)}</h3>
      <ul class="ev-list">${list
        .map(
          (e) => `<li class="ev">
        <span class="ev-kind">${e.kind}</span>
        <div><p class="ev-title">${esc(e.title)}</p>${e.hint ? `<p class="ev-hint">${esc(e.hint)}</p>` : ""}</div>
      </li>`,
        )
        .join("")}</ul>
    </div>`,
        )
        .join("")
    : `<p class="ev-empty">На ближайшие ${EVENT_DAYS}${NBSP}дней важных событий не нашлось.</p>`;
  $("events-notes").innerHTML = notes.map((n) => `<p class="note${n.startsWith("⚠") ? " warn" : ""}">${n}</p>`).join("");
  $("events-src").innerHTML = sources.length ? `Источники: ${sources.join(", ")}.` : "";
}

// ---------- Главное за день и слово дня ----------

const fmtNewsTime = (iso) => new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
// Ссылка из чужой ленты: пропускаем только обычные веб-адреса.
const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : "#");

function renderNews(items) {
  const x = items.news;
  if (!x) {
    $("news").innerHTML = `<p class="ev-empty">нет данных — источник не ответил</p>`;
    $("news-notes").innerHTML = "";
    return;
  }
  $("news").innerHTML = x.list.length
    ? `<ul class="news-list">${x.list
        .map(
          (n) => `<li class="news-item">
        <a class="news-title" href="${esc(safeUrl(n.url))}" target="_blank" rel="noopener">${esc(n.title)}</a>
        ${n.text ? `<p class="news-text">${esc(n.text)}</p>` : ""}
        <p class="news-meta">${esc(n.source)} · ${fmtNewsTime(n.time)}</p>
      </li>`,
        )
        .join("")}</ul>`
    : `<p class="ev-empty">За последние сутки новостей в лентах не было.</p>`;
  const notes = x.missing.map((name) => `<p class="note">нет данных: ${esc(name)} — источник не ответил</p>`);
  if (isStale(x)) notes.unshift(`<p class="note warn">⚠ новости не обновлялись с ${fmtDay(x.checkedAt.slice(0, 10))}</p>`);
  $("news-notes").innerHTML = notes.join("");
}

// Каждый день — следующее слово из словаря, по кругу.
function renderWord() {
  const [y, m, d] = isoToday().split("-").map(Number);
  const w = WORDS[Math.round(Date.UTC(y, m - 1, d) / DAY) % WORDS.length];
  $("word-term").textContent = w.term;
  $("word-text").textContent = w.text;
}

function renderDaily(failed) {
  const items = daily?.items || {};
  $("rates-tiles").innerHTML = RATE_TILES.map((d) => rateTile(d, items)).join("");
  $("macro-tiles").innerHTML = MACRO_TILES.map((d) => macroTile(d, items)).join("");
  renderEvents(items);
  renderNews(items);
  renderWord();
  const line = $("daily-line");
  line.classList.toggle("ok", !failed);
  line.classList.toggle("error", failed);
  $("daily-text").textContent = failed
    ? "Ставки, календарь и новости: не удалось загрузить данные."
    : `Ставки, календарь и новости обновлены: ${fmtFull(Date.parse(daily.generatedAt))} (раз в день)`;
}

async function loadDaily() {
  try {
    daily = await getJSON("data/data.json", true);
    renderDaily(false);
  } catch {
    renderDaily(true);
  }
}

// ---------- Подсказки и наведение на график ----------

const tooltip = $("tooltip");

function showTooltip(html, x, y, kind) {
  tooltip.innerHTML = html;
  tooltip.dataset.kind = kind;
  tooltip.hidden = false;
  const r = tooltip.getBoundingClientRect();
  const left = Math.min(Math.max(8, x - r.width / 2), innerWidth - r.width - 8);
  const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideTooltip() {
  tooltip.hidden = true;
  document.querySelectorAll(".spark.active").forEach((s) => s.classList.remove("active"));
}

function onSparkMove(e) {
  const svg = e.target.closest?.(".spark");
  const s = svg && sparks.get(svg.dataset.id);
  if (!s) return;
  // График рисуется в натуральную величину, поэтому координаты SVG = пиксели.
  const rect = svg.getBoundingClientRect();
  const x = e.clientX - rect.left;
  let best = s.points[0];
  for (const p of s.points) if (Math.abs(s.X(p[0]) - x) < Math.abs(s.X(best[0]) - x)) best = p;
  const [cx, cy] = [s.X(best[0]), s.Y(best[1])];
  svg.querySelector(".cross").setAttribute("x1", cx);
  svg.querySelector(".cross").setAttribute("x2", cx);
  svg.querySelector(".hover").setAttribute("cx", cx);
  svg.querySelector(".hover").setAttribute("cy", cy);
  svg.classList.add("active");
  const date = new Date(best[0]).toLocaleString("ru-RU", s.tip || { day: "numeric", month: "long" });
  showTooltip(`${date}<br><strong>${fmtPrice(s.a, best[1], s.currency)}</strong>`, rect.left + cx, rect.top + cy, "spark");
}

document.addEventListener("pointermove", (e) => {
  if (e.target.closest?.(".spark")) onSparkMove(e);
  else if (!e.target.closest?.(".tip")) hideTooltip();
});
document.addEventListener("pointerdown", (e) => {
  if (e.target.closest?.(".spark")) onSparkMove(e);
});
document.addEventListener("mouseover", (e) => {
  const tip = e.target.closest?.(".tip");
  if (tip) showTipFor(tip);
});
document.addEventListener("focusin", (e) => {
  if (e.target.matches?.(".tip")) showTipFor(e.target);
});
document.addEventListener("focusout", () => tooltip.dataset.kind === "tip" && hideTooltip());
document.addEventListener("click", (e) => {
  const tip = e.target.closest?.(".tip");
  if (tip) showTipFor(tip);
  else if (!e.target.closest?.(".spark")) hideTooltip();
});
document.addEventListener("keydown", (e) => e.key === "Escape" && hideTooltip());
addEventListener("scroll", hideTooltip, { passive: true });

function showTipFor(el) {
  const r = el.getBoundingClientRect();
  showTooltip(esc(el.dataset.tip), r.left + r.width / 2, r.top, "tip");
}

// ---------- Тема ----------

$("theme-btn").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try {
    localStorage.setItem("theme", root.dataset.theme);
  } catch {}
});

// ---------- Запуск ----------

$("markets-head").innerHTML = headHtml("Актив");
$("companies-head").innerHTML = headHtml("Компания");
$("today").textContent = new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
phone.addEventListener("change", () => lastRefresh && render());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() - lastRefresh >= REFRESH_MS) refresh();
});
setInterval(tick, 1000);
setInterval(loadDaily, HOUR);
refresh();
loadDaily();
