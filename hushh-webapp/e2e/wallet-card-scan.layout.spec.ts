import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
let server: Server;
let origin: string;
let failLanguage = false;
test.beforeAll(async () => {
  const { build } = await import("vite");
  const root = process.cwd();
  const dir = mkdtempSync(path.join(tmpdir(), "wallet-ocr-proof-"));
  const entry = path.join(dir, "entry.ts");
  writeFileSync(entry, `import { scanWalletCard } from ${JSON.stringify(path.join(root, "lib/services/wallet-card-scan.ts").replaceAll("\\", "/"))}; window.scanWalletCard = scanWalletCard;`);
  await build({ configFile: false, publicDir: false, logLevel: "error", resolve: { alias: { "@": root } }, build: { outDir: dir, emptyOutDir: false, lib: { entry, name: "Scan", formats: ["iife"], fileName: () => "scan.js" } } });
  server = createServer((req, res) => {
    const name = new URL(req.url!, "http://localhost").pathname;
    if (failLanguage && name.endsWith("eng.traineddata.gz")) { res.statusCode = 404; res.end(); return; }
    if (name === "/") { res.setHeader("Content-Type", "text/html"); res.end('<script src="/scan.js"></script>'); return; }
    const filename = name === "/scan.js" ? path.join(dir, "scan.js") : name === "/wallet/card-scan-worker.js" ? path.join(root, "public/wallet/card-scan-worker.js") : path.join(root, "public/vendor/wallet-ocr", path.basename(name));
    try { res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream"); res.end(readFileSync(filename)); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });
test("reads a synthetic card with bundled OCR and no off-device requests", async ({ page }) => {
  test.setTimeout(120000);
  const requests: { url: string; method: string; body: string | null }[] = [];
  page.on("request", (request) => requests.push({ url: request.url(), method: request.method(), body: request.postData() }));
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 1200; canvas.height = 750;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = "white"; ctx.fillRect(0, 0, 1200, 750);
    ctx.fillStyle = "black"; ctx.font = "48px monospace";
    ctx.fillText("DEMO CARD", 80, 140); ctx.fillText("4242 4242 4242 4242", 80, 350); ctx.fillText("12/30", 80, 480);
    const photo = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"));
    return await (window as unknown as { scanWalletCard: (file: Blob, signal: AbortSignal) => Promise<{ pan: string }> }).scanWalletCard(photo, new AbortController().signal);
  });
  expect(result.pan).toBe("4242424242424242");
  expect(requests.every(({ url, method, body }) => method === "GET" && body === null && (url === origin + "/" || url === origin + "/scan.js" || url === origin + "/wallet/card-scan-worker.js" || url.startsWith(origin + "/vendor/wallet-ocr/")))).toBe(true);
});

test("failed language initialization settles and releases its workers", async ({ page }) => {
  failLanguage = true;
  try {
    await page.goto(origin);
    const failed = await page.evaluate(async () => {
      try {
        await (window as unknown as { scanWalletCard: (file: Blob, signal: AbortSignal) => Promise<unknown> }).scanWalletCard(new Blob(["synthetic"], { type: "image/png" }), new AbortController().signal);
        return false;
      } catch { return true; }
    });
    expect(failed).toBe(true);
    await expect.poll(() => page.workers().length).toBe(0);
  } finally { failLanguage = false; }
});
