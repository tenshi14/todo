// 本物の実行環境（wrangler pages dev = Cloudflare の workerd + D1）を起動して、
// API と画面（スマホ 2 台分）を通しで動かすテスト。
// 実行: npm test（Chromium が必要。CHROMIUM_PATH で場所を指定できる）
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const PORT = 8790;
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'screenshots');

function startServer() {
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'warikan-'));
  const proc = spawn('npx', ['wrangler', 'pages', 'dev', 'public', '--d1', 'DB=warikan-test', '--port', String(PORT),
    '--persist-to', persist, '--compatibility-date', '2026-09-01', '--show-interactive-dev-session=false'],
  { cwd: ROOT, env: Object.assign({}, process.env, { CI: '1' }), detached: true });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const stop = () => { try { process.kill(-proc.pid); } catch (e) { /* 終了済み */ } fs.rmSync(persist, { recursive: true, force: true }); };
  return new Promise((resolve, reject) => {
    const started = Date.now();
    (async function wait() {
      try {
        const res = await fetch(BASE + '/');
        if (res.ok) return resolve(stop);
      } catch (e) { /* まだ起動していない */ }
      if (Date.now() - started > 90000) { stop(); return reject(new Error('サーバーが起動しませんでした\n' + log)); }
      setTimeout(wait, 500);
    })();
  });
}

// cookie を覚えておく簡易クライアント（スマホ 1 台のつもり）
function client() {
  let cookie = '';
  return async function call(method, p, data, headers = { 'X-Warikan': '1' }) {
    const res = await fetch(BASE + '/api' + p, {
      method,
      headers: Object.assign({}, headers, data ? { 'Content-Type': 'application/json' } : {}, cookie ? { Cookie: cookie } : {}),
      body: data ? JSON.stringify(data) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
}

function jstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function prevMonth(month) {
  let [y, m] = month.split('-').map(Number);
  m -= 1;
  if (m === 0) { y -= 1; m = 12; }
  return y + '-' + String(m).padStart(2, '0');
}

async function apiTests() {
  const today = jstToday();
  const month = today.slice(0, 7);
  const ten = client();
  const outsider = client();

  // ---- ログインまわり ----
  let r = await ten('GET', '/session');
  assert.deepStrictEqual(r.body, {
    user: null,
    members: [{ name: 'てん', registered: false }, { name: 'あおい', registered: false }],
    signupCodeRequired: false,
  });
  assert.strictEqual((await ten('GET', '/month')).status, 401);
  assert.strictEqual((await ten('POST', '/register', { name: 'てん', password: 'password123' }, {})).status, 403); // CSRF 対策ヘッダーなし
  assert.strictEqual((await ten('POST', '/register', { name: 'てん', password: 'short' })).status, 400);
  assert.strictEqual((await ten('POST', '/register', { name: 'だれか', password: 'password123' })).status, 400);
  r = await ten('POST', '/register', { name: 'てん', password: 'password123' });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /warikan_session=\w{64}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000/);
  assert.strictEqual((await ten('GET', '/session')).body.user, 'てん');
  // 登録済みの名前は横取りできない
  r = await outsider('POST', '/register', { name: 'てん', password: 'hijack12345' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await outsider('POST', '/login', { name: 'てん', password: 'wrongpass1' })).status, 401);

  // ---- 今月: 固定費（家賃）が自動で 1 回だけ入る ----
  r = await ten('GET', '/month');
  assert.strictEqual(r.body.month, month);
  assert.deepStrictEqual(r.body.entries.map((e) => [e.date, e.amount, e.payer, e.comment, e.created_by]), [[month + '-01', 80440, 'てん', '家賃', '自動']]);
  assert.deepStrictEqual(r.body.summary.transfer, { from: 'あおい', to: 'てん', amount: 26813 });
  assert.strictEqual((await ten('GET', '/month')).body.entries.length, 1);

  // ---- 記録・二重送信の防止・入力チェック ----
  r = await ten('POST', '/expenses', { date: today, amount: 3000, payer: 'あおい', category: '食べ物', comment: 'オーケー', clientId: 'c1' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.summary.total, 83440);
  assert.deepStrictEqual(r.body.summary.transfer, { from: 'あおい', to: 'てん', amount: 24813 });
  r = await ten('POST', '/expenses', { date: today, amount: 3000, payer: 'あおい', category: '食べ物', comment: 'オーケー', clientId: 'c1' });
  assert.strictEqual(r.body.entries.length, 2);
  for (const bad of [
    { date: today, amount: 0, payer: 'てん' },
    { date: today, amount: 1.5, payer: 'てん' },
    { date: '2026-02-30', amount: 100, payer: 'てん' },
    { date: today, amount: 100, payer: 'だれか' },
    { date: today, amount: 100, payer: 'てん', category: 'なぞ' },
  ]) assert.strictEqual((await ten('POST', '/expenses', bad)).status, 400, JSON.stringify(bad));
  assert.deepStrictEqual(r.body.suggestions.map((s) => s.comment).sort(), ['オーケー', '家賃'].sort());
  assert.strictEqual(r.body.suggestions.find((s) => s.comment === 'オーケー').category, '食べ物');

  // 先月の日付は先月に入る（先月には固定費は自動で入らない）
  const last = prevMonth(month);
  r = await ten('POST', '/expenses', { date: last + '-28', amount: 4000, payer: 'てん', comment: '西友' });
  assert.strictEqual(r.body.month, last);
  assert.deepStrictEqual(r.body.entries.map((e) => e.amount), [4000]);
  assert.deepStrictEqual(r.body.months, [month, last]);

  // ---- 編集・削除 ----
  const okId = (await ten('GET', '/month')).body.entries.find((e) => e.comment === 'オーケー').id;
  r = await ten('PUT', '/expenses/' + okId, { date: today, amount: 3500, payer: 'あおい', category: '食べ物', comment: 'オーケー' });
  assert.strictEqual(r.body.summary.total, 83940);
  r = await ten('DELETE', '/expenses/' + okId);
  assert.strictEqual(r.body.summary.total, 80440);
  assert.strictEqual((await ten('DELETE', '/expenses/' + okId)).status, 404);

  // ---- 精算済み ----
  r = await ten('POST', '/settlements', { month });
  assert.deepStrictEqual([r.body.settlement.amount, r.body.settlement.from, r.body.settlement.to, r.body.settlement.by], [26813, 'あおい', 'てん', 'てん']);
  r = await ten('DELETE', '/settlements/' + month);
  assert.strictEqual(r.body.settlement, null);

  // ---- CSV ----
  r = await ten('GET', '/export.csv');
  assert.match(r.body, /^﻿?日付,金額,払った人,何の費用,メモ,記録した人,記録日時\r\n/);
  assert.match(r.body, /,4000,てん,,西友,てん,/);

  // ---- パスワード変更: ほかの端末はログアウトされる ----
  const ten2 = client();
  assert.strictEqual((await ten2('POST', '/login', { name: 'てん', password: 'password123' })).status, 200);
  assert.strictEqual((await ten('POST', '/password', { current: 'nope', next: 'newpassword1' })).status, 400);
  assert.strictEqual((await ten('POST', '/password', { current: 'password123', next: 'newpassword1' })).status, 200);
  assert.strictEqual((await ten('GET', '/month')).status, 200);
  assert.strictEqual((await ten2('GET', '/month')).status, 401);
  assert.strictEqual((await ten('POST', '/password', { current: 'newpassword1', next: 'password123' })).status, 200);

  // ---- ログアウト ----
  await ten2('POST', '/login', { name: 'てん', password: 'password123' });
  await ten2('POST', '/logout');
  assert.strictEqual((await ten2('GET', '/month')).status, 401);

  // ---- パスワードを何度も間違えるとしばらくログインできない ----
  for (let i = 0; i < 10; i++) await outsider('POST', '/login', { name: 'てん', password: 'wrong' + i });
  r = await outsider('POST', '/login', { name: 'てん', password: 'password123' });
  assert.strictEqual(r.status, 429);
  return { month, last };
}

async function uiTests({ month, last }) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' };
  const errors = [];
  async function newPhone() {
    const context = await browser.newContext(phone);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());
    return { context, page };
  }
  const settleAmount = (page) => page.textContent('#settle-amount');

  // ---- あおいのスマホ: はじめてなのでパスワードを登録 ----
  const aoi = await newPhone();
  let page = aoi.page;
  await page.goto(BASE);
  await page.waitForSelector('#login:not([hidden])');
  await page.click('#login-members button:has-text("あおい")');
  assert.strictEqual(await page.textContent('#login-submit'), 'パスワードを登録してはじめる');
  await page.screenshot({ path: path.join(SHOTS, 'register.png') });
  await page.fill('#login-password', 'aoipassword');
  await page.fill('#login-password2', 'different!!');
  await page.click('#login-submit');
  assert.match(await page.textContent('#login-error'), /一致しません/);
  await page.fill('#login-password2', 'aoipassword');
  await page.click('#login-submit');
  await page.waitForSelector('#app:not([hidden])');
  await page.waitForFunction(() => document.querySelector('#settle-amount').textContent === '¥26,813');
  assert.strictEqual(await page.textContent('#settle-label'), 'あおい → てん');
  assert.strictEqual(await page.textContent('#payer button[aria-checked="true"]'), 'あおい（自分）');

  // 記録する（メモの候補を押すとカテゴリも入る）
  await page.fill('#amount', '3000');
  assert.strictEqual(await page.inputValue('#amount'), '3,000');
  await page.click('#suggestions button:has-text("家賃")');
  assert.strictEqual(await page.textContent('#categories button[aria-checked="true"]'), '電気ガス水道家賃');
  await page.fill('#comment', 'セコマ');
  await page.click('#categories button:has-text("食べ物")');
  await page.click('#submit');
  await page.waitForFunction(() => document.querySelector('#settle-amount').textContent === '¥24,813');
  assert.strictEqual(await page.inputValue('#amount'), '');
  await page.screenshot({ path: path.join(SHOTS, 'main.png'), fullPage: true });

  // 編集: 行をタップ → 金額を直して更新
  await page.click('#entries .entry-row:has-text("セコマ") .entry-tap');
  assert.strictEqual(await page.inputValue('#amount'), '3,000');
  assert.strictEqual(await page.textContent('#submit'), '更新する');
  await page.fill('#amount', '3200');
  await page.click('#submit');
  await page.waitForFunction(() => document.querySelector('#settle-amount').textContent === '¥24,680');
  assert.strictEqual(await page.textContent('#submit'), '記録する');

  // 電波がないときは「送信待ち」にためて、つながったら送る
  await aoi.context.setOffline(true);
  await page.fill('#amount', '1200');
  await page.fill('#comment', 'パン屋');
  await page.click('#submit');
  await page.waitForSelector('.entry-row.pending');
  assert.match(await page.textContent('#status-line'), /送信待ち 1件（オフライン）/);
  await page.screenshot({ path: path.join(SHOTS, 'offline.png'), fullPage: true });
  await aoi.context.setOffline(false);
  await page.waitForFunction(() => !document.querySelector('.entry-row.pending') && document.querySelector('#settle-amount').textContent === '¥23,880');

  // ---- てんのスマホ: ログイン（API テストで登録済み）→ あおいの記録が見える ----
  const ten = await newPhone();
  page = ten.page;
  await page.goto(BASE);
  await page.waitForSelector('#login:not([hidden])');
  await page.click('#login-members button:has-text("てん")');
  assert.strictEqual(await page.textContent('#login-submit'), 'ログイン');
  await page.fill('#login-password', 'wrongpass');
  await page.click('#login-submit');
  await page.waitForFunction(() => document.querySelector('#login-error').textContent !== '');
  // （API テストでロックされているので、15 分待つ案内が出る）
  assert.match(await page.textContent('#login-error'), /15 分/);
  await ten.context.close();

  // ロックされていないブラウザとして、あおいのスマホで精算・月の切り替え・ログアウトを確認
  page = aoi.page;
  await page.click('#settle-btn');
  await page.waitForFunction(() => document.querySelector('#settle-status').textContent.includes('精算済み'));
  assert.strictEqual(await page.textContent('#settle-btn'), '精算を取り消す');
  await page.fill('#amount', '500');
  await page.click('#submit');
  await page.waitForFunction(() => document.querySelector('#settle-status').textContent.includes('記録が変わっています'));

  await page.click('#prev-month');
  await page.waitForFunction((m) => document.querySelector('#month-select').value === m, last);
  assert.strictEqual(await page.locator('#entries .entry-row').count(), 1);

  // 開き直すと、ログインしたまま今月が表示される
  await page.goto(BASE);
  await page.waitForFunction((m) => !document.querySelector('#app').hidden && document.querySelector('#month-select').value === m, month);

  // 削除
  await page.click('#entries .entry-row:has-text("パン屋") .delete-btn');
  await page.waitForFunction(() => !document.querySelector('#entries').textContent.includes('パン屋'));

  // ダークモード
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(SHOTS, 'dark.png'), fullPage: true });

  // ログアウト
  await page.click('#open-settings');
  await page.screenshot({ path: path.join(SHOTS, 'settings.png') });
  await page.click('#logout');
  await page.waitForSelector('#login:not([hidden])');
  await page.goto(BASE);
  await page.waitForSelector('#login:not([hidden])');

  assert.deepStrictEqual(errors, []);
  await browser.close();
}

(async () => {
  const stop = await startServer();
  try {
    const ctx = await apiTests();
    console.log('API のテストに合格しました');
    await uiTests(ctx);
    console.log('画面のテストに合格しました（スクリーンショット: test/screenshots/）');
  } finally {
    stop();
  }
})().catch((e) => { console.error(e); process.exit(1); });
