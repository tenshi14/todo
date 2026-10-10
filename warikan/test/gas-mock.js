// Apps Script の機能（SpreadsheetApp など）を Node.js で真似する簡易モック。
// 「食費と生活費」の template シートと同じ並び・同じ式（2:1 の割り勘）を再現する。
'use strict';

const LIST = 'VALUE_IN_LIST';
const CATS = ['食べ物', '電気ガス水道家賃', '薬', '日用品'];

class Sheet {
  constructor(ss, name, grid, categories, formulas) {
    Object.assign(this, { ss, name, grid, categories, formulas });
  }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getIndex() { return this.ss.sheets.indexOf(this) + 1; }
  getLastRow() {
    for (let r = this.grid.length - 1; r >= 0; r--) if ((this.grid[r] || []).some((v) => v !== '' && v !== undefined)) return r + 1;
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
    const sheet = this;
    if (typeof a === 'string') { // 'D2'
      return { getDataValidation: () => sheet.categories && ({
        getCriteriaType: () => LIST, getCriteriaValues: () => [sheet.categories, true],
      }) };
    }
    return {
      getValues: () => { sheet.recalc(); return Array.from({ length: h }, (_, i) => Array.from({ length: w }, (_, j) => sheet.cell(a + i, b + j))); },
      setValues: (vals) => vals.forEach((row, i) => row.forEach((v, j) => sheet.set(a + i, b + j, v))),
      setNumberFormat() { return this; },
      clearContent: () => { for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) sheet.set(a + i, b + j, ''); },
    };
  }
  copyTo(ss) {
    const s = new Sheet(ss, 'コピー', this.grid.map((r) => r.slice()), this.categories, this.formulas);
    ss.sheets.push(s);
    return s;
  }
  // テスト用: A〜E 列のデータ行
  rows() {
    const out = [];
    for (let r = 2; r <= this.getLastRow(); r++) {
      const v = [1, 2, 3, 4, 5].map((c) => this.cell(r, c));
      if (v.some((x) => x !== '')) out.push(v);
    }
    return out;
  }
}

function templateGrid() {
  const g = [
    ['日付', '金額', '誰が払ったか', '何の費用？', 'コメント'],
    ['', 80440, 'てん', '電気ガス水道家賃', '', '', '合計支出', 0],
    [],
    ['', '', '', '', '', '', '', '支払額', '負担する額', '精算額', '', 'マイナス: 払い過ぎ'],
    ['', '', '', '', '', '', 'てん', 0, 0, 0, '', 'プラス: 未払い'],
    ['', '', '', '', '', '', 'あおい', 0, 0, 0, '', 'プラスの人がマイナスの人に払う'],
    [],
    ['', '', '', '', '', '', 'あおいが全額払った'], // G 列のメモは追記位置・集計に影響しない
    ['', '', '', '', '', '', 1000, 'きのり'],
  ];
  return g.map((r) => r.concat(Array(12 - r.length).fill('')));
}

/** グローバルに Apps Script のモックを入れて、スプレッドシートを返す */
function install({ today = '2026-10-10' } = {}) {
  const store = {};
  const cache = {};
  const clock = { today };
  global.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in store ? store[k] : null),
      setProperty: (k, v) => { store[k] = String(v); },
      deleteProperty: (k) => { delete store[k]; },
      getProperties: () => Object.assign({}, store),
    }),
  };
  global.CacheService = {
    getScriptCache: () => ({ get: (k) => cache[k] ?? null, put: (k, v) => { cache[k] = v; } }),
  };
  global.LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  global.Utilities = {
    formatDate: (d, tz, fmt) => { if (fmt !== 'yyyy-MM-dd') throw new Error(fmt); return clock.today; },
    getUuid: () => require('crypto').randomUUID(),
    base64EncodeWebSafe: (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
  };
  global.ContentService = {
    MimeType: { JSON: 'json', TEXT: 'text' },
    createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }),
  };

  const ss = {
    sheets: [],
    active: null,
    getSheets() { return this.sheets.slice(); },
    getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; },
    setActiveSheet(s) { this.active = s; },
    moveActiveSheet(pos) { this.sheets.splice(this.sheets.indexOf(this.active), 1); this.sheets.splice(pos - 1, 0, this.active); },
  };
  ss.sheets.push(
    new Sheet(ss, 'template', templateGrid(), CATS, true),
    new Sheet(ss, '10月', templateGrid(), CATS, true),
    new Sheet(ss, '2026/9', templateGrid(), CATS, true),
  );
  ss.getSheetByName('2026/9').set(3, 1, 1);
  ss.getSheetByName('2026/9').getRange(3, 1, 4, 5).setValues([
    [1, 3153, 'あおい', '食べ物', 'セコマ'],
    ['', 4863, 'てん', '日用品', 'スーパーバリュー'],
    [10, 2060, 'あおい', '食べ物', 'セコマ'],
    ['', 980, 'てん', '', '道の駅'],
  ]);
  global.SpreadsheetApp = {
    getActiveSpreadsheet: () => ss,
    flush() {},
    DataValidationCriteria: { VALUE_IN_LIST: LIST },
  };
  global.ScriptApp = { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }) };
  return { ss, store, cache, clock };
}

module.exports = { install, CATS };
