// Посредник между сайтом и Yahoo Finance.
// Браузер не может обращаться к Yahoo напрямую (Yahoo не отдаёт CORS-заголовок),
// поэтому сайт спрашивает этот Worker, а Worker — Yahoo.
//
// Запрос:  /chart?symbol=^GSPC&range=2d   → цены за последние ~25 часов с шагом 5 минут
//          /chart?symbol=^GSPC&range=1y   → дневные цены закрытия за год
// Ответ:   { symbol, currency, price, time, prevClose, t: [секунды], c: [цены] }
//          prevClose — цена закрытия прошлого торгового дня.
//
// Проверка: /health → { ok: true }, если Yahoo отвечает, иначе код 502.
//           Её раз в час вызывает .github/workflows/health.yml.
//
// Этот же файл используется локально в server.js.

const INTERVALS = { "2d": "5m", "1y": "1d" };
const BROWSER_CACHE_SECONDS = { "2d": 0, "1y": 3600 };
const KEEP_SECONDS = { "2d": 25 * 3600, "1y": Infinity }; // лишнее не отправляем, чтобы ответ был маленьким

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const symbol = url.searchParams.get("symbol") || "";
    const range = url.searchParams.get("range") || "";

    if (url.pathname === "/health") {
      const ok = Boolean((await yahoo("^GSPC", "2d", INTERVALS["2d"]))?.meta?.regularMarketPrice);
      return json({ ok }, ok ? 200 : 502);
    }
    if (url.pathname !== "/chart" || !INTERVALS[range] || !/^[\w^.=-]{1,20}$/.test(symbol)) {
      return json({ error: "bad request" }, 400);
    }

    let result = await yahoo(symbol, range, INTERVALS[range]);
    // Для некоторых индексов (например WIG20) Yahoo не отдаёт дневную историю.
    // Тогда берём часовые цены за год и оставляем последнюю цену каждого дня.
    if (range === "1y" && result && (result.timestamp?.length ?? 0) < 2) {
      const hourly = await yahoo(symbol, "1y", "60m");
      if (hourly) result = toDaily(hourly);
    }
    if (!result?.meta?.regularMarketPrice) return json({ error: "no data" }, 502);

    const meta = result.meta;
    const closes = result.indicators?.quote?.[0]?.close || [];
    const from = meta.regularMarketTime - KEEP_SECONDS[range];
    const t = [];
    const c = [];
    (result.timestamp || []).forEach((ts, i) => {
      if (ts >= from && closes[i] != null) {
        t.push(ts);
        c.push(round(closes[i]));
      }
    });
    return json(
      {
        symbol,
        currency: meta.currency,
        price: meta.regularMarketPrice,
        time: meta.regularMarketTime,
        prevClose: meta.previousClose ?? meta.chartPreviousClose,
        t,
        c,
      },
      200,
      BROWSER_CACHE_SECONDS[range],
    );
  },
};

async function yahoo(symbol, range, interval) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=${interval}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    return (await res.json())?.chart?.result?.[0] ?? null;
  } catch {
    return null;
  }
}

// Часовые цены → одна цена закрытия на каждый торговый день (по времени биржи).
function toDaily(result) {
  const offset = result.meta.gmtoffset || 0;
  const closes = result.indicators?.quote?.[0]?.close || [];
  const days = new Map();
  (result.timestamp || []).forEach((ts, i) => {
    if (closes[i] == null) return;
    const day = Math.floor((ts + offset) / 86400);
    const prev = days.get(day);
    days.set(day, { t: prev ? prev.t : ts, c: closes[i] });
  });
  const list = [...days.values()];
  return { meta: result.meta, timestamp: list.map((d) => d.t), indicators: { quote: [{ close: list.map((d) => d.c) }] } };
}

// 6 значащих цифр: Yahoo отдаёт числа вида 4252.27978515625
const round = (v) => Number(v.toPrecision(6));

function json(body, status, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}
