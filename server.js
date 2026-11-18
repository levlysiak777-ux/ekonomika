// Локальный запуск сайта: node server.js → http://localhost:8080
// Отдаёт файлы сайта, а запросы /api/... передаёт в worker/worker.js
// (то же самое, что в интернете делает Cloudflare Worker).

import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./worker/worker.js";

const PORT = Number(process.env.PORT) || 8080;
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname.startsWith("/api/")) {
      try {
        const r = await worker.fetch(new Request(`http://local${url.pathname.slice(4)}${url.search}`));
        res.writeHead(r.status, Object.fromEntries(r.headers));
        res.end(await r.text());
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    const path = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const file = normalize(join(ROOT, path));
    // Не отдаём ничего за пределами папки и скрытые файлы (.env, .git).
    // Части пути проверяем уже после normalize: в Windows разделителем бывает и «\».
    if (!file.startsWith(ROOT) || relative(ROOT, file).split(/[\\/]/).some((part) => part.startsWith("."))) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("Not found");
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Сайт запущен: http://localhost:${PORT}`)); // только с этого компьютера
