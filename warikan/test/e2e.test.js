// スマホ画面（web/）を本物のブラウザで動かすテスト。
// Apps Script への通信は横取りして、gas/Code.gs をモックのスプレッドシート上で動かす。
// 実行: node test/e2e.test.js（Chromium が必要。CHROMIUM_PATH で場所を指定できる）
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright-core');
const { install } = require('./gas-mock');

const { ss } = install({ today: '2026-10-10' });
const gas = require(path.join(__dirname, '..', 'gas', 'Code.gs'));
const origLog = console.log;
console.log = () => {};
gas.setup();
console.log = origLog;
const KEY = PropertiesService.getScriptProperties().getProperty('APP_KEY');
const API = 'https://script.google.com/macros/s/TEST/exec';
const SETUP = Buffer.from(JSON.stringify({ a: API, k: KEY })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const WEB = path.join(__dirname, '..', 'web');
const SHOTS = path.join(__dirname, 'screenshots');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = path.join(WEB, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
      if (!file.startsWith(WEB) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    }).listen(0, () => resolve(server));
  });
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP' });
  let online = true;
  let apiCalls = 0;
  await context.route(API, async (route) => {
    apiCalls++;
    if (!online) return route.abort('internetdisconnected');
    const out = gas.doPost({ postData: { contents: route.request().postData() } });
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: out.text });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());

  // 1. 何も設定していなければセットアップ画面
  await page.goto(base);
  await page.waitForSelector('#setup:not([hidden])');
  assert.ok(await page.isVisible('#setup-link-step'));

  // 2. セットアップ用リンクで開く → 「だれ？」を選ぶ
  await page.goto(base + '#setup=' + SETUP);
  await page.reload();
  await page.waitForSelector('#setup-me-step:not([hidden])');
  await page.click('#setup-members button:has-text("てん")');
  await page.waitForSelector('#app:not([hidden])');
  assert.strictEqual(await page.textContent('#settle-label'), 'あおい → てん');
  assert.strictEqual(await page.textContent('#settle-amount'), '¥26,813');
  assert.strictEqual(await page.inputValue('#month-select'), '10月');
  assert.strictEqual(await page.textContent('#payer button[aria-checked="true"]'), 'てん（自分）');

  // 3. 記録する（メモの候補をタップするとカテゴリも入る）
  await page.fill('#amount', '3000');
  assert.strictEqual(await page.inputValue('#amount'), '3,000');
  await page.click('#payer button:has-text("あおい")');
  await page.click('#suggestions button:has-text("セコマ")');
  assert.strictEqual(await page.textContent('#categories button[aria-checked="true"]'), '食べ物');
  await page.click('#submit');
  await page.waitForFunction(() => document.querySelectorAll('#entries .entry-row:not(.pending)').length === 2);
  assert.deepStrictEqual(ss.getSheetByName('10月').rows()[1], [10, 3000, 'あおい', '食べ物', 'セコマ']);
  assert.strictEqual(await page.textContent('#settle-amount'), '¥24,813');
  assert.strictEqual(await page.inputValue('#amount'), '');
  assert.strictEqual(await page.textContent('#payer button[aria-checked="true"]'), 'てん（自分）'); // 自分に戻る
  await page.screenshot({ path: path.join(SHOTS, 'main.png'), fullPage: true });

  // 4. 電波がないときは「送信待ち」でためておき、つながったら送る
  online = false;
  await context.setOffline(true);
  await page.fill('#amount', '1200');
  await page.fill('#comment', 'パン屋');
  await page.click('#submit');
  await page.waitForSelector('.entry-row.pending');
  assert.match(await page.textContent('#status-line'), /送信待ち 1件/);
  assert.strictEqual(ss.getSheetByName('10月').rows().length, 2);
  await page.screenshot({ path: path.join(SHOTS, 'offline.png'), fullPage: true });
  online = true;
  await context.setOffline(false);
  await page.waitForFunction(() => !document.querySelector('.entry-row.pending'));
  assert.deepStrictEqual(ss.getSheetByName('10月').rows()[2], [10, 1200, 'てん', '', 'パン屋']);
  assert.strictEqual(await page.textContent('#status-line'), '');

  // 5. 削除
  await page.click('#entries .entry-row:has-text("セコマ") .delete-btn');
  await page.waitForFunction(() => !document.querySelector('#entries').textContent.includes('セコマ'));
  assert.deepStrictEqual(ss.getSheetByName('10月').rows().map((r) => r[4]), ['', 'パン屋']);

  // 6. 先月を見る
  await page.click('#prev-month');
  await page.waitForFunction(() => document.querySelector('#month-select').value === '2026/9');
  assert.match(await page.textContent('#list-title'), /2026\/9/);
  assert.strictEqual(await page.locator('#entries .entry-row').count(), 5);

  // 7. 開き直しても設定が残っていて、今月が表示される
  await page.goto(base);
  await page.waitForSelector('#app:not([hidden])');
  await page.waitForFunction(() => document.querySelector('#month-select').value === '10月');

  // 8. ダークモード
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(SHOTS, 'dark.png'), fullPage: true });

  assert.deepStrictEqual(errors, []);
  assert.ok(apiCalls > 0);
  await browser.close();
  server.close();
  console.log('画面のテストに合格しました（スクリーンショット: test/screenshots/）');
})().catch((e) => { console.error(e); process.exit(1); });
