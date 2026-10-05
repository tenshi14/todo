// Code.gs を Node.js で動かすテスト。Apps Script の機能（SpreadsheetApp など）は簡易的なモックで置き換える。
// 実行: node test.js
'use strict';
process.env.TZ = 'Asia/Tokyo';
const assert = require('assert');

// ---- Apps Script のモック -------------------------------------------------

const store = {};
global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (k) => (k in store ? store[k] : null),
    setProperty: (k, v) => { store[k] = String(v); },
    deleteProperty: (k) => { delete store[k]; },
    getProperties: () => Object.assign({}, store),
  }),
};
global.LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
global.Utilities = {
  formatDate: (d, tz, fmt) => {
    assert.strictEqual(fmt, 'yyyy-M-d');
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
    return `${p.year}-${Number(p.month)}-${Number(p.day)}`;
  },
  getUuid: () => '1234-5678',
};
const replies = [];
const leaves = [];
global.UrlFetchApp = {
  fetch: (url, opts) => {
    if (/\/leave$/.test(url)) leaves.push(url);
    else replies.push(JSON.parse(opts.payload).messages[0].text);
    return { getResponseCode: () => 200, getContentText: () => '' };
  },
};
global.ContentService = {
  MimeType: { TEXT: 'text' },
  createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }),
};

const LIST = 'VALUE_IN_LIST';
class Sheet {
  constructor(ss, name, grid, categories) {
    this.ss = ss; this.name = name; this.grid = grid; this.categories = categories;
  }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getIndex() { return this.ss.sheets.indexOf(this) + 1; }
  getLastRow() {
    for (let r = this.grid.length - 1; r >= 0; r--) if ((this.grid[r] || []).some((v) => v !== '')) return r + 1;
    return 0;
  }
  cell(r, c) { return (this.grid[r - 1] || [])[c - 1] ?? ''; }
  set(r, c, v) { while (this.grid.length < r) this.grid.push([]); this.grid[r - 1][c - 1] = v; }
  // template と同じ式: H2=SUM(B:B), H5/H6=SUMIF, I=合計×2/3・1/3, J=I-H
  recalc() {
    if (!this.formulas) return;
    let total = 0; const paid = { てん: 0, あおい: 0 };
    for (let r = 1; r <= this.grid.length; r++) {
      const b = this.cell(r, 2);
      if (typeof b === 'number') { total += b; if (this.cell(r, 3) in paid) paid[this.cell(r, 3)] += b; }
    }
    this.set(2, 8, total);
    this.set(5, 8, paid['てん']); this.set(5, 9, total * 2 / 3); this.set(5, 10, total * 2 / 3 - paid['てん']);
    this.set(6, 8, paid['あおい']); this.set(6, 9, total / 3); this.set(6, 10, total / 3 - paid['あおい']);
  }
  getRange(a, b, h = 1, w = 1) {
    if (typeof a === 'string') { // 'D2'
      const sheet = this;
      return { getDataValidation: () => sheet.categories && ({
        getCriteriaType: () => LIST, getCriteriaValues: () => [sheet.categories, true],
      }) };
    }
    const sheet = this;
    return {
      getValues: () => { sheet.recalc(); return Array.from({ length: h }, (_, i) => Array.from({ length: w }, (_, j) => sheet.cell(a + i, b + j))); },
      setValues: (vals) => vals.forEach((row, i) => row.forEach((v, j) => sheet.set(a + i, b + j, v))),
      setNumberFormat() { return this; },
      clearContent: () => { for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) sheet.set(a + i, b + j, ''); },
    };
  }
  copyTo(ss) {
    const s = new Sheet(ss, 'コピー', this.grid.map((r) => r.slice()), this.categories);
    s.formulas = this.formulas;
    ss.sheets.push(s);
    return s;
  }
}
function templateGrid() {
  const g = [
    ['日付', '金額', '誰が払ったか', '何の費用？', 'コメント', '', '', '', '', '', '', ''],
    ['', 80440, 'てん', '電気ガス水道家賃', '', '', '合計支出', 0],
    [],
    ['', '', '', '', '', '', '', '支払額', '負担する額', '精算額', '', 'マイナス: 払い過ぎ'],
    ['', '', '', '', '', '', 'てん', 0, 0, 0, '', 'プラス: 未払い'],
    ['', '', '', '', '', '', 'あおい', 0, 0, 0, '', 'プラスの人がマイナスの人に払う'],
    ['', '', '', '', '', '', ''],
    ['', '', '', '', '', '', 'あおいが全額払った'], // G 列のメモは集計・追記位置に影響しない
    ['', '', '', '', '', '', 1000, 'きのり'],
  ];
  return g.map((r) => r.concat(Array(12 - r.length).fill('')));
}
const ss = {
  sheets: [],
  active: null,
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; },
  setActiveSheet(s) { this.active = s; },
  moveActiveSheet(pos) { this.sheets.splice(this.sheets.indexOf(this.active), 1); this.sheets.splice(pos - 1, 0, this.active); },
};
const CATS = ['食べ物', '電気ガス水道家賃', '薬', '日用品'];
const template = new Sheet(ss, 'template', templateGrid(), CATS); template.formulas = true;
const oct = new Sheet(ss, '10月', templateGrid(), CATS); oct.formulas = true;
const sep = new Sheet(ss, '2026/9', templateGrid(), CATS); sep.formulas = true;
ss.sheets.push(template, oct, sep);
global.SpreadsheetApp = {
  getActiveSpreadsheet: () => ss,
  flush() {},
  DataValidationCriteria: { VALUE_IN_LIST: LIST },
};

const app = require('./Code.gs');

// ---- 解析のテスト -----------------------------------------------------------

const NOW = new Date('2026-10-05T12:00:00+09:00');
const parse = (t) => app.parseEntry(t, NOW, CATS);
const today = { y: 2026, m: 10, d: 5 };

assert.deepStrictEqual(parse('1200 スーパー'),
  { amount: 1200, payer: null, category: '食べ物', comment: 'スーパー', date: today });
assert.deepStrictEqual(parse('1,200円 食べ物 オーケー 牛乳'),
  { amount: 1200, payer: null, category: '食べ物', comment: 'オーケー 牛乳', date: today });
assert.deepStrictEqual(parse('ニトリ　１２００'), // 全角数字・全角スペース
  { amount: 1200, payer: null, category: '', comment: 'ニトリ', date: today });
assert.deepStrictEqual(parse('あおい ￥800 薬局'),
  { amount: 800, payer: 'あおい', category: '薬', comment: '薬局', date: today });
assert.deepStrictEqual(parse('9/28 5250 ガソリン'),
  { amount: 5250, payer: null, category: '電気ガス水道家賃', comment: 'ガソリン', date: { y: 2026, m: 9, d: 28 } });
assert.deepStrictEqual(parse('昨日500パン').date, { y: 2026, m: 10, d: 4 });
assert.deepStrictEqual(parse('3日 300 コープ').date, { y: 2026, m: 10, d: 3 });
assert.deepStrictEqual(parse('1200円スーパー').amount, 1200);
assert.deepStrictEqual(parse('9月28日3000ガソリン'), { amount: 3000, payer: null, category: '電気ガス水道家賃', comment: 'ガソリン', date: { y: 2026, m: 9, d: 28 } });
assert.deepStrictEqual(parse('9月28日 3000 ガソリン').date, { y: 2026, m: 9, d: 28 });
assert.deepStrictEqual(parse('-500 返品').amount, -500);
assert.strictEqual(parse('こんにちは'), null);
assert.strictEqual(parse('9/28'), null);
assert.strictEqual(parse('0 なにか'), null);
// 1月に「12/30」→ 去年
assert.deepStrictEqual(app.parseEntry('12/30 100 x', new Date('2027-01-03T09:00:00+09:00'), CATS).date, { y: 2026, m: 12, d: 30 });
assert.deepStrictEqual(app.parseMonth('9月', NOW), { y: 2026, m: 9 });
assert.deepStrictEqual(app.parseMonth('12月', NOW), { y: 2025, m: 12 });
assert.deepStrictEqual(app.parseMonth('2026/9', NOW), { y: 2026, m: 9 });
assert.deepStrictEqual(app.parseMonth('先月', NOW), { y: 2026, m: 9 });

// ---- Webhook 全体のテスト ---------------------------------------------------

store.WEBHOOK_TOKEN = 'secret';
store.LINE_CHANNEL_ACCESS_TOKEN = 'dummy';
const TEN = 'Uten', AOI = 'Uaoi';
function post(event, token = 'secret') {
  replies.length = 0;
  app.doPost({ parameter: { token }, postData: { contents: JSON.stringify({ events: [event] }) } });
  return replies[0];
}
function send(userId, text, opts = {}) {
  replies.length = 0;
  const groupId = opts.group === true ? 'G' : opts.group;
  const event = {
    type: 'message', replyToken: 'r', timestamp: (opts.at || NOW).getTime(),
    source: groupId ? { type: 'group', groupId, userId } : { type: 'user', userId },
    message: { type: 'text', text },
  };
  const res = app.doPost({ parameter: { token: opts.token || 'secret' }, postData: { contents: JSON.stringify({ events: [event] }) } });
  return { res: res.text, reply: replies[0] };
}

// 合言葉が違うリクエストは無視
assert.strictEqual(send(TEN, '1000 x', { token: 'wrong' }).reply, undefined);

// 精算用グループに招待されると挨拶し、そのグループに紐づく
assert.match(post({ type: 'join', replyToken: 'r', source: { type: 'group', groupId: 'G' } }), /精算用グループに参加しました/);
assert.strictEqual(store.GROUP_ID, 'G');
// 別のグループに招待されたら退出し、そこでのメッセージは無視する
assert.strictEqual(post({ type: 'join', replyToken: 'r', source: { type: 'group', groupId: 'OTHER' } }), undefined);
assert.deepStrictEqual(leaves, ['https://api.line.me/v2/bot/group/OTHER/leave']);
assert.strictEqual(send(TEN, '登録 てん', { group: 'OTHER' }).reply, undefined);

// 未登録だと案内が出る
assert.match(send(TEN, '1000 スーパー').reply, /登録 てん/);
assert.match(send(TEN, 'おはよう', { group: true }).reply, /登録 てん/);

// 登録
assert.match(send(TEN, '登録 てん').reply, /「てん」として登録/);
assert.match(send(AOI, '登録 てん').reply, /すでに別のアカウント/);
assert.match(send(AOI, '登録 だれか').reply, /てん \/ あおい/);
assert.match(send(AOI, '登録 あおい').reply, /「あおい」として登録/);

// 記録 → 既存の「10月」シートの最後の行の次に書かれる
let r = send(AOI, '3,000 食べ物 オーケー');
assert.deepStrictEqual(oct.grid[2].slice(0, 5), [5, 3000, 'あおい', '食べ物', 'オーケー']);
assert.match(r.reply, /記録しました（10月）/);
assert.match(r.reply, /合計支出: 83,440円/);
assert.match(r.reply, /あおい → てん に 24,813円/); // 83440/3 - 3000 = 24813.33

r = send(TEN, 'あおい 1000 パン屋');
assert.deepStrictEqual(oct.grid[3].slice(0, 5), [5, 1000, 'あおい', '', 'パン屋']);

// 取消は自分が記録した最後の1件
r = send(TEN, '取消');
assert.match(r.reply, /取り消しました/);
assert.deepStrictEqual(oct.grid[3].slice(0, 5), ['', '', '', '', '']);
assert.match(send(TEN, '取消').reply, /取り消せる記録がありません/);

// グループでも記録できる
send(TEN, '2000 日用品 ドラッグストア', { group: true });
assert.deepStrictEqual(oct.grid[3].slice(0, 5), [5, 2000, 'てん', '日用品', 'ドラッグストア']);

// 精算専用グループ（既定）: 1 対 1 と同じくゆるく読み取り、読めないメッセージには案内を返す
assert.match(send(TEN, 'りょうかい', { group: true }).reply, /金額と内容を送ってください/);
send(TEN, '昨日500パン', { group: true });
assert.deepStrictEqual(oct.grid[4].slice(0, 5), [4, 500, 'てん', '', 'パン']);
send(TEN, '取消', { group: true });

// 会話もするグループ（DEDICATED_GROUP = false）: 「明日10時に」のような会話は記録せず無視。「円」付きやスペース区切りは OK
app.CONFIG.DEDICATED_GROUP = false;
assert.strictEqual(send(TEN, 'きょうは寒いね', { group: true }).reply, undefined);
assert.strictEqual(send(TEN, '明日10時に集合ね', { group: true }).reply, undefined);
assert.strictEqual(send(TEN, '昨日500パン', { group: true }).reply, undefined);
assert.deepStrictEqual(oct.grid[4].slice(0, 5), ['', '', '', '', '']);
send(AOI, 'パン屋500円', { group: true });
assert.deepStrictEqual(oct.grid[4].slice(0, 5), [5, 500, 'あおい', '', 'パン屋']);
send(AOI, '取消', { group: true });
app.CONFIG.DEDICATED_GROUP = true;
assert.strictEqual(app.parseEntry('明日10時に', NOW, CATS, true), null);
assert.strictEqual(app.parseEntry('セブン11', NOW, CATS, true), null);
assert.strictEqual(app.parseEntry('¥1200スーパー', NOW, CATS, true).amount, 1200);
assert.deepStrictEqual(app.parseEntry('9/28 5250ガソリン円', NOW, CATS, true), null);
assert.deepStrictEqual(app.parseEntry('9/28 5250円ガソリン', NOW, CATS, true).date, { y: 2026, m: 9, d: 28 });

// 日付指定で先月のシートへ
send(TEN, '9/30 4000 西友');
assert.deepStrictEqual(sep.grid[2].slice(0, 5), [30, 4000, 'てん', '', '西友']);

// 精算
r = send(AOI, '精算');
assert.match(r.reply, /📊 10月/);
assert.match(r.reply, /てん: 支払 82,440/);
r = send(AOI, '精算 9月');
assert.match(r.reply, /📊 2026\/9/);
assert.match(send(AOI, '精算 3月').reply, /シートはまだありません/);

// 履歴
r = send(AOI, '履歴');
assert.match(r.reply, /5日 あおい 3,000円 \[食べ物\] オーケー/);
assert.match(r.reply, /5日 てん 2,000円 \[日用品\] ドラッグストア/);

// 新しい月は template をコピーして「2026/11」を作り、template の右に置く
r = send(TEN, '1500 スーパー', { at: new Date('2026-11-02T08:00:00+09:00') });
const nov = ss.getSheetByName('2026/11');
assert.ok(nov);
assert.strictEqual(ss.sheets.indexOf(nov), 1);
assert.deepStrictEqual(nov.grid[1].slice(0, 3), ['', 80440, 'てん']); // template の家賃行も引き継ぐ
assert.deepStrictEqual(nov.grid[2].slice(0, 5), [2, 1500, 'てん', '食べ物', 'スーパー']);
assert.deepStrictEqual(template.grid[2].slice(0, 5), ['', '', '', '', '']);

// ヘルプ
assert.match(send(TEN, 'ヘルプ').reply, /あおい 800 薬局/);

console.log('すべてのテストに合格しました');
