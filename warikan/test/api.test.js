// Apps Script の API（gas/Code.gs）のテスト。実行: node test/api.test.js
'use strict';
const assert = require('assert');
const path = require('path');
const { install } = require('./gas-mock');

const { ss, store, clock } = install({ today: '2026-10-10' });
const app = require(path.join(__dirname, '..', 'gas', 'Code.gs'));

function call(body) {
  return JSON.parse(app.doPost({ postData: { contents: JSON.stringify(body) } }).text);
}
function withLogs(fn) {
  const logs = [];
  const orig = console.log;
  console.log = (m) => logs.push(String(m));
  try { fn(); } finally { console.log = orig; }
  return logs.join('\n');
}

// ---- セットアップ ----
assert.deepStrictEqual(call({ action: 'load' }), { ok: false, error: 'unauthorized' });
withLogs(() => app.setup());
const KEY = store.APP_KEY;
assert.ok(KEY && KEY.length >= 32);
assert.deepStrictEqual(call({ key: 'wrong', action: 'load' }), { ok: false, error: 'unauthorized' });

app.CONFIG.APP_URL = 'https://warikan.example.pages.dev/';
const link = withLogs(() => app.printSetupLink()).match(/https:\/\/warikan\.example\.pages\.dev\/#setup=(\S+)/);
assert.ok(link, 'セットアップ用リンクが表示される');
const decoded = JSON.parse(Buffer.from(link[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
assert.deepStrictEqual(decoded, { a: 'https://script.google.com/macros/s/TEST/exec', k: KEY });

const api = (body) => call(Object.assign({ key: KEY }, body));

// ---- 読み込み: 今月（既存の「10月」シート） ----
let res = api({ action: 'load' });
assert.strictEqual(res.ok, true);
assert.strictEqual(res.data.sheet, '10月');
assert.deepStrictEqual(res.data.sheets, ['10月', '2026/9']);
assert.deepStrictEqual(res.data.members, ['てん', 'あおい']);
assert.deepStrictEqual(res.data.categories, ['食べ物', '電気ガス水道家賃', '薬', '日用品']);
assert.deepStrictEqual(res.data.entries, [{ row: 2, day: '', amount: 80440, payer: 'てん', category: '電気ガス水道家賃', comment: '' }]);
assert.deepStrictEqual(res.data.summary, {
  total: 80440,
  people: [
    { name: 'てん', paid: 80440, share: 53627, diff: -26813 },
    { name: 'あおい', paid: 0, share: 26813, diff: 26813 },
  ],
});
assert.strictEqual(res.data.today, '2026-10-10');
// よく使うメモ（多い順）と、そのときのカテゴリ
assert.deepStrictEqual(res.data.suggestions[0], { comment: 'セコマ', category: '食べ物' });

// 過去の月
res = api({ action: 'load', sheet: '2026/9' });
assert.strictEqual(res.data.sheet, '2026/9');
assert.strictEqual(res.data.entries.length, 5);
assert.strictEqual(api({ action: 'load', sheet: 'ない' }).ok, false);

// ---- 記録 ----
res = api({ action: 'add', clientId: 'c1', entry: { date: '2026-10-10', amount: 3000, payer: 'あおい', category: '食べ物', comment: 'オーケー' } });
assert.strictEqual(res.ok, true);
assert.deepStrictEqual(res.added, { sheet: '10月', row: 3 });
const oct = ss.getSheetByName('10月');
assert.deepStrictEqual(oct.rows()[1], [10, 3000, 'あおい', '食べ物', 'オーケー']);
assert.strictEqual(res.data.summary.total, 83440);
assert.deepStrictEqual(res.data.summary.people[1], { name: 'あおい', paid: 3000, share: 27813, diff: 24813 });

// 同じ clientId の再送は二重に記録しない
res = api({ action: 'add', clientId: 'c1', entry: { date: '2026-10-10', amount: 3000, payer: 'あおい', comment: 'オーケー' } });
assert.strictEqual(res.duplicate, true);
assert.strictEqual(oct.rows().length, 2);

// プルダウンにないカテゴリは空欄にする。不正な値ははじく
api({ action: 'add', clientId: 'c2', entry: { date: '2026-10-09', amount: 500, payer: 'てん', category: 'なぞ', comment: 'パン' } });
assert.deepStrictEqual(oct.rows()[2], [9, 500, 'てん', '', 'パン']);
assert.strictEqual(api({ action: 'add', entry: { date: '2026-10-09', amount: 0, payer: 'てん' } }).ok, false);
assert.strictEqual(api({ action: 'add', entry: { date: '2026-10-09', amount: 1.5, payer: 'てん' } }).ok, false);
assert.strictEqual(api({ action: 'add', entry: { date: '2026-10-09', amount: 100, payer: 'だれか' } }).ok, false);

// 先月の日付なら先月のシートへ
api({ action: 'add', clientId: 'c3', entry: { date: '2026-09-30', amount: 4000, payer: 'てん', comment: '西友' } });
assert.deepStrictEqual(ss.getSheetByName('2026/9').rows().pop(), [30, 4000, 'てん', '', '西友']);

// 新しい月は template をコピーして「2026/11」を作り、template の右に置く
clock.today = '2026-11-01';
res = api({ action: 'load' });
assert.strictEqual(res.data.sheet, '2026/11');
assert.deepStrictEqual(res.data.sheets, ['2026/11', '10月', '2026/9']);
assert.deepStrictEqual(ss.getSheetByName('template').rows(), [['', 80440, 'てん', '電気ガス水道家賃', '']]);

// ---- 削除: A〜E 列だけ上に詰め、集計欄（G〜L 列）は動かさない ----
// 10月: [家賃, あおい3000, てん500]
assert.strictEqual(api({ action: 'delete', sheet: '10月', row: 3, expect: { amount: 9999, payer: 'あおい' } }).ok, false);
res = api({ action: 'delete', sheet: '10月', row: 3, expect: { amount: 3000, payer: 'あおい' } });
assert.strictEqual(res.ok, true);
assert.deepStrictEqual(oct.rows().map((r) => r.slice(0, 5)), [['', 80440, 'てん', '電気ガス水道家賃', ''], [9, 500, 'てん', '', 'パン']]);
assert.strictEqual(oct.cell(5, 7), 'てん');
assert.strictEqual(oct.cell(8, 7), 'あおいが全額払った');
assert.strictEqual(res.data.summary.total, 80940);
assert.strictEqual(api({ action: 'delete', sheet: '10月', row: 1, expect: {} }).ok, false);

console.log('API のテストに合格しました');
