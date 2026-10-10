/**
 * わりかん Web アプリの窓口（API）。
 * スプレッドシート「食費と生活費」に付ける Google Apps Script で、
 * スマホのホーム画面に追加した Web アプリから呼ばれて、シートの読み書きをする。
 *
 * 運用コスト 0 円: Apps Script の無料枠だけで動く（サーバー不要）。
 *
 * スクリプトプロパティ:
 *   APP_KEY         setup() で自動生成される合言葉。これを知っている端末だけが読み書きできる
 *   SPREADSHEET_ID  （任意）スプレッドシートから開いたスクリプトなら不要
 */

const CONFIG = {
  // スマホで開くアプリの URL（Cloudflare Pages で公開した URL に書き換える）
  APP_URL: 'https://warikan.pages.dev/',
  // 割り勘のメンバー（シートの「誰が払ったか」列の表記と同じにする）
  MEMBERS: ['てん', 'あおい'],
  // 新しい月のシートを作るときにコピーする元シート
  TEMPLATE_SHEET: 'template',
  TIMEZONE: 'Asia/Tokyo',
  // シートの「何の費用？」のプルダウンが読めなかったときに使う候補
  DEFAULT_CATEGORIES: ['食べ物', '電気ガス水道家賃', '薬', '日用品'],
  // シート内の列（A:日付 B:金額 C:誰が払ったか D:何の費用？ E:コメント）
  DATA_COLUMNS: 5,
  // 集計欄（「てん | 支払額 | 負担する額 | 精算額」の並び）を上から何行目まで探すか
  SUMMARY_SEARCH_ROWS: 15,
  // コメントの候補を集めるときに見る月数と、返す数
  SUGGESTION_MONTHS: 3,
  SUGGESTION_COUNT: 12,
};

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * Web アプリからの呼び出し。本文は JSON（プリフライトを避けるため Content-Type は text/plain で送られてくる）:
 *   { key, action: 'load',   sheet? }                               → 月のデータ
 *   { key, action: 'add',    entry: {date, amount, payer, category, comment}, clientId }
 *   { key, action: 'delete', sheet, row, expect: {amount, payer} }
 */
function doPost(e) {
  let result;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    result = handleRequest(req);
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    result = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput('わりかん API は動いています');
}

function handleRequest(req) {
  const expected = PropertiesService.getScriptProperties().getProperty('APP_KEY');
  if (!expected || req.key !== expected) return { ok: false, error: 'unauthorized' };

  switch (req.action) {
    case 'load':
      return withLock(function () { return loadMonth(req.sheet || null); });
    case 'add':
      return withLock(function () { return addEntry(req.entry || {}, req.clientId || null); });
    case 'delete':
      return withLock(function () { return deleteEntry(req.sheet, req.row, req.expect || {}); });
    default:
      return { ok: false, error: '不明な操作です: ' + req.action };
  }
}

/**
 * 初回セットアップ: Apps Script エディタでこの関数を 1 回実行する。
 * 合言葉を作って、ログに表示する。
 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('APP_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('APP_KEY', key);
  }
  getSpreadsheet(); // 権限の承認ダイアログを出すため
  console.log('合言葉 (APP_KEY): ' + key);
}

/**
 * スマホで開く「セットアップ用リンク」をログに表示する。
 * ウェブアプリとしてデプロイしたあと、CONFIG.APP_URL を Cloudflare Pages の URL に書き換えてから実行する。
 */
function printSetupLink() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('APP_KEY')) setup();
  // デプロイ済みウェブアプリの URL（…/exec）。うまく取れないときはスクリプトプロパティ API_URL に貼っておく
  const apiUrl = props.getProperty('API_URL') || ScriptApp.getService().getUrl();
  if (!apiUrl || !/\/exec$/.test(apiUrl)) {
    throw new Error('ウェブアプリの URL（…/exec）が取得できません。先にデプロイするか、スクリプトプロパティ API_URL に URL を設定してください');
  }
  const code = Utilities.base64EncodeWebSafe(JSON.stringify({ a: apiUrl, k: props.getProperty('APP_KEY') }));
  console.log('セットアップ用リンク（2 人のスマホで開く。ほかの人には教えない）:\n' + CONFIG.APP_URL + '#setup=' + code);
}

/** 合言葉を作り直す（スマホをなくしたときなど）。各スマホでセットアップし直しが必要になる。 */
function resetKey() {
  PropertiesService.getScriptProperties().deleteProperty('APP_KEY');
  setup();
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

function loadMonth(sheetName) {
  const ss = getSpreadsheet();
  let sheet = null;
  if (sheetName) {
    sheet = ss.getSheetByName(sheetName);
    if (!sheet) return { ok: false, error: '「' + sheetName + '」シートが見つかりません' };
  } else {
    sheet = findMonthSheet(ss, todayYmd()) || getOrCreateMonthSheet(ss, todayYmd());
  }
  return { ok: true, data: monthData(ss, sheet) };
}

function addEntry(entry, clientId) {
  // 電波が悪くて再送されたときに二重に記録しない
  const cache = CacheService.getScriptCache();
  if (clientId && cache.get('cid_' + clientId)) {
    const done = JSON.parse(cache.get('cid_' + clientId));
    const ss0 = getSpreadsheet();
    return { ok: true, duplicate: true, data: monthData(ss0, ss0.getSheetByName(done.sheet)) };
  }

  const date = parseIsoDate(entry.date) || todayYmd();
  const amount = Number(entry.amount);
  if (!isFinite(amount) || amount === 0 || Math.round(amount) !== amount) {
    return { ok: false, error: '金額は 0 以外の整数で入力してください' };
  }
  if (Math.abs(amount) > 10000000) return { ok: false, error: '金額が大きすぎます' };
  const payer = String(entry.payer || '');
  if (CONFIG.MEMBERS.indexOf(payer) < 0) return { ok: false, error: '払った人が正しくありません' };

  const ss = getSpreadsheet();
  const sheet = getOrCreateMonthSheet(ss, { y: date.y, m: date.m });
  let category = String(entry.category || '');
  if (category && categoriesOf(sheet).indexOf(category) < 0) category = '';
  const comment = String(entry.comment || '').slice(0, 200);

  const row = lastDataRow(sheet) + 1;
  sheet.getRange(row, 1, 1, CONFIG.DATA_COLUMNS).setValues([[date.d, amount, payer, category, comment]]);
  sheet.getRange(row, 2).setNumberFormat('#,##0');
  SpreadsheetApp.flush();

  if (clientId) cache.put('cid_' + clientId, JSON.stringify({ sheet: sheet.getName(), row: row }), 21600);
  return { ok: true, added: { sheet: sheet.getName(), row: row }, data: monthData(ss, sheet) };
}

/**
 * 1 行削除する。G 列より右の集計欄やメモを動かさないよう、行ごと消さずに
 * A〜E 列だけ下の行を 1 つずつ上に詰める。
 */
function deleteEntry(sheetName, row, expect) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(String(sheetName));
  if (!sheet) return { ok: false, error: '「' + sheetName + '」シートが見つかりません' };
  row = Number(row);
  if (!(row >= 2)) return { ok: false, error: '行番号が正しくありません' };

  const current = sheet.getRange(row, 1, 1, CONFIG.DATA_COLUMNS).getValues()[0];
  if (Number(current[1]) !== Number(expect.amount) || String(current[2]) !== String(expect.payer)) {
    return { ok: false, error: 'シートが別の場所で編集されたため削除しませんでした。画面を更新してください', data: monthData(ss, sheet) };
  }

  const last = lastDataRow(sheet);
  if (last > row) {
    const below = sheet.getRange(row + 1, 1, last - row, CONFIG.DATA_COLUMNS).getValues();
    sheet.getRange(row, 1, last - row, CONFIG.DATA_COLUMNS).setValues(below);
  }
  sheet.getRange(last, 1, 1, CONFIG.DATA_COLUMNS).clearContent();
  SpreadsheetApp.flush();
  return { ok: true, data: monthData(ss, sheet) };
}

// ---------------------------------------------------------------------------
// 月のデータ
// ---------------------------------------------------------------------------

function monthData(ss, sheet) {
  return {
    sheet: sheet.getName(),
    sheets: monthSheetNames(ss),
    members: CONFIG.MEMBERS,
    categories: categoriesOf(sheet),
    entries: entriesOf(sheet),
    summary: summaryOf(sheet),
    suggestions: suggestionsOf(ss),
    today: todayIso(),
  };
}

/** template 以外のシート名（シートの並び順。左が新しい月） */
function monthSheetNames(ss) {
  return ss.getSheets()
    .map(function (s) { return s.getName(); })
    .filter(function (n) { return n !== CONFIG.TEMPLATE_SHEET; });
}

function entriesOf(sheet) {
  const last = lastDataRow(sheet);
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, CONFIG.DATA_COLUMNS).getValues();
  const entries = [];
  values.forEach(function (r, i) {
    if (r[1] === '' || r[1] === null) return;
    entries.push({
      row: i + 2,
      day: r[0] instanceof Date ? (r[0].getMonth() + 1) + '/' + r[0].getDate() : String(r[0]),
      amount: Number(r[1]) || 0,
      payer: String(r[2]),
      category: String(r[3]),
      comment: String(r[4]),
    });
  });
  return entries;
}

/**
 * シートの集計欄（合計支出・支払額・負担する額・精算額）を読む。
 * 「メンバー名 | 支払額 | 負担する額 | 精算額」と数字が並んでいる行を F〜L 列から探す。
 */
function summaryOf(sheet) {
  const values = sheet.getRange(1, 6, CONFIG.SUMMARY_SEARCH_ROWS, 7).getValues(); // F:L
  const isNum = function (v) { return typeof v === 'number' && !isNaN(v); };
  let total = null;
  const people = [];
  values.forEach(function (r) {
    for (let k = 0; k < r.length - 1; k++) {
      if (r[k] === '合計支出' && total === null && isNum(r[k + 1])) total = r[k + 1];
      if (CONFIG.MEMBERS.indexOf(r[k]) >= 0 && k + 3 < r.length &&
          isNum(r[k + 1]) && isNum(r[k + 2]) && isNum(r[k + 3]) &&
          people.every(function (p) { return p.name !== r[k]; })) {
        people.push({ name: r[k], paid: r[k + 1], share: Math.round(r[k + 2]), diff: Math.round(r[k + 3]) });
      }
    }
  });
  return { total: total, people: people };
}

/** 最近の月によく使ったコメントと、そのとき選んだカテゴリ（入力候補に使う） */
function suggestionsOf(ss) {
  const counts = {};
  const categoryOf = {};
  monthSheetNames(ss).slice(0, CONFIG.SUGGESTION_MONTHS).forEach(function (name) {
    entriesOf(ss.getSheetByName(name)).forEach(function (e) {
      const c = e.comment.trim();
      if (!c || c.length > 20) return;
      counts[c] = (counts[c] || 0) + 1;
      if (e.category && !categoryOf[c]) categoryOf[c] = e.category;
    });
  });
  return Object.keys(counts)
    .sort(function (a, b) { return counts[b] - counts[a]; })
    .slice(0, CONFIG.SUGGESTION_COUNT)
    .map(function (c) { return { comment: c, category: categoryOf[c] || '' }; });
}

// ---------------------------------------------------------------------------
// スプレッドシート操作
// ---------------------------------------------------------------------------

function getSpreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheetNameCandidates(ym) {
  // 既存シートの命名「2026/9」を優先。「10月」のような名前のシートも使う
  return [ym.y + '/' + ym.m, ym.m + '月'];
}

function findMonthSheet(ss, ym) {
  const names = sheetNameCandidates(ym);
  for (let i = 0; i < names.length; i++) {
    const sheet = ss.getSheetByName(names[i]);
    if (sheet) return sheet;
  }
  return null;
}

/** その月のシートを取得。なければ template をコピーして「2026/11」の形で作る。 */
function getOrCreateMonthSheet(ss, ym) {
  const found = findMonthSheet(ss, ym);
  if (found) return found;
  const template = ss.getSheetByName(CONFIG.TEMPLATE_SHEET);
  if (!template) throw new Error('「' + CONFIG.TEMPLATE_SHEET + '」シートが見つかりません');
  const sheet = template.copyTo(ss).setName(sheetNameCandidates(ym)[0]);
  ss.setActiveSheet(sheet);
  ss.moveActiveSheet(template.getIndex() + 1); // template のすぐ右（新しい月が左に並ぶ）
  return sheet;
}

/** A〜E 列で最後にデータがある行番号（G 列以降のメモは無視する） */
function lastDataRow(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return 0;
  const values = sheet.getRange(1, 1, lastRow, CONFIG.DATA_COLUMNS).getValues();
  for (let r = values.length - 1; r >= 0; r--) {
    if (values[r].some(function (v) { return v !== '' && v !== null; })) return r + 1;
  }
  return 0;
}

/** 「何の費用？」列のプルダウンの選択肢を読む */
function categoriesOf(sheet) {
  try {
    const rule = sheet.getRange('D2').getDataValidation();
    if (rule && rule.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
      const list = rule.getCriteriaValues()[0];
      if (list && list.length) return list.map(String);
    }
  } catch (err) {
    console.warn(err);
  }
  return CONFIG.DEFAULT_CATEGORIES;
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function todayIso() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function todayYmd() {
  return parseIsoDate(todayIso());
}

function parseIsoDate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const date = new Date(y, mo - 1, d);
  if (date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return { y: y, m: mo, d: d };
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000); // 2 人が同時に記録しても同じ行に書かないように
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// Node.js でのテスト用（Apps Script 上では module が無いので無視される）
if (typeof module !== 'undefined') {
  module.exports = { CONFIG, doPost, handleRequest, parseIsoDate, setup, printSetupLink };
}
