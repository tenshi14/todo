/**
 * LINE で「金額 内容」を送ると、生活費スプレッドシートに自動で記録する Bot。
 *
 * - Google Apps Script（無料）でスプレッドシートに直接書き込む
 * - LINE Messaging API の「応答メッセージ（reply）」だけを使う（無料・回数無制限）
 * → 運用コスト 0 円
 *
 * 必要なスクリプトプロパティ:
 *   LINE_CHANNEL_ACCESS_TOKEN  LINE Developers で発行したチャネルアクセストークン（長期）
 *   WEBHOOK_TOKEN              setup() を実行すると自動生成される合言葉（Webhook URL の末尾に付ける）
 *   SPREADSHEET_ID             （任意）スプレッドシートから開いたスクリプトなら不要
 */

const CONFIG = {
  // 割り勘のメンバー（シートの「誰が払ったか」列の表記と同じにする）
  MEMBERS: ['てん', 'あおい'],
  // 新しい月のシートを作るときにコピーする元シート
  TEMPLATE_SHEET: 'template',
  TIMEZONE: 'Asia/Tokyo',
  // シートの「何の費用？」のプルダウンが読めなかったときに使う候補
  DEFAULT_CATEGORIES: ['食べ物', '電気ガス水道家賃', '薬', '日用品'],
  // この言葉がメッセージに含まれていたら、自動でカテゴリを付ける（言葉自体はコメントに残る）
  CATEGORY_ALIASES: {
    '食費': '食べ物', 'ごはん': '食べ物', 'ご飯': '食べ物', '外食': '食べ物', 'ランチ': '食べ物',
    '夕飯': '食べ物', '朝ごはん': '食べ物', 'スーパー': '食べ物',
    '家賃': '電気ガス水道家賃', '光熱費': '電気ガス水道家賃', '電気': '電気ガス水道家賃',
    '電気代': '電気ガス水道家賃', 'ガス': '電気ガス水道家賃', 'ガス代': '電気ガス水道家賃',
    '水道': '電気ガス水道家賃', '水道代': '電気ガス水道家賃', 'ガソリン': '電気ガス水道家賃',
    '高速': '電気ガス水道家賃', '高速代': '電気ガス水道家賃',
    '病院': '薬', '薬局': '薬', 'ドラッグストア': '薬',
    '日用品': '日用品', '消耗品': '日用品',
  },
  // シート内の列（A:日付 B:金額 C:誰が払ったか D:何の費用？ E:コメント）
  DATA_COLUMNS: 5,
  // 集計欄（「てん | 支払額 | 負担する額 | 精算額」の並び）を上から何行目まで探すか
  SUMMARY_SEARCH_ROWS: 15,
  HISTORY_COUNT: 5,
  // 精算専用グループ（普通の会話をしない）なら true: グループでも 1 対 1 と同じくゆるく読み取り、
  // 読み取れないメッセージにも使い方を返信する。
  // 普通の会話もするグループなら false: 「明日10時に」などを記録しないよう厳しめに読み取り、関係ない発言は無視する。
  DEDICATED_GROUP: true,
};

// ---------------------------------------------------------------------------
// Webhook の入口
// ---------------------------------------------------------------------------

function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  const expected = props.getProperty('WEBHOOK_TOKEN');
  // Apps Script では LINE の署名ヘッダーを読めないため、URL の合言葉で送信元を確認する
  if (!expected || !e || !e.parameter || e.parameter.token !== expected) {
    return textOutput('forbidden');
  }

  if (!e.postData || !e.postData.contents) return textOutput('OK');
  const body = JSON.parse(e.postData.contents);
  (body.events || []).forEach(function (event) {
    let reply;
    try {
      if (event.type === 'join') {
        reply = handleJoin(props, event);
      } else if (event.type === 'message' && event.message && event.message.type === 'text') {
        if (!isAllowedChat(props, event.source)) return;
        reply = handleText(event);
      }
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      reply = '⚠️ エラーが発生しました: ' + (err && err.message ? err.message : err);
    }
    if (reply) replyToLine(event.replyToken, reply);
  });
  return textOutput('OK');
}

function doGet() {
  return textOutput('LINE 割り勘 Bot は動いています');
}

/**
 * 初回セットアップ: Apps Script エディタでこの関数を 1 回実行する。
 * Webhook 用の合言葉を作ってログに表示する。
 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('WEBHOOK_TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('WEBHOOK_TOKEN', token);
  }
  if (!props.getProperty('LINE_CHANNEL_ACCESS_TOKEN')) {
    console.warn('スクリプトプロパティ LINE_CHANNEL_ACCESS_TOKEN がまだ設定されていません');
  }
  getSpreadsheet(); // 権限の承認ダイアログを出すため
  console.log('Webhook URL の末尾に付ける文字列: ?token=' + token);
}

/** 登録したユーザーを全部消す（スマホを変えたときなど）。エディタから実行する。 */
function resetUsers() {
  const props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (key) {
    if (key.indexOf('USER_') === 0 || key.indexOf('LAST_') === 0) props.deleteProperty(key);
  });
  console.log('登録ユーザーをリセットしました');
}

/** 精算用グループの紐づけを外す（別のグループで使い直すとき）。エディタから実行する。 */
function resetGroup() {
  PropertiesService.getScriptProperties().deleteProperty('GROUP_ID');
  console.log('グループの紐づけを解除しました。新しいグループに Bot を招待してください');
}

// ---------------------------------------------------------------------------
// 精算用グループ
// ---------------------------------------------------------------------------

function chatIdOf(source) {
  return source ? (source.groupId || source.roomId || null) : null;
}

/**
 * Bot を使えるのは「1 対 1 のトーク」と「最初に招待された精算用グループ」だけ。
 * 他のグループでのメッセージは無視する。
 */
function isAllowedChat(props, source) {
  const chatId = chatIdOf(source);
  if (!chatId) return true;
  const bound = props.getProperty('GROUP_ID');
  if (!bound) {
    props.setProperty('GROUP_ID', chatId); // join イベントを取りこぼしたときの保険
    return true;
  }
  return bound === chatId;
}

function handleJoin(props, event) {
  const chatId = chatIdOf(event.source);
  if (!chatId) return null;
  const bound = props.getProperty('GROUP_ID');
  if (bound && bound !== chatId) {
    leaveChat(event.source);
    return null;
  }
  props.setProperty('GROUP_ID', chatId);
  return [
    '👋 精算用グループに参加しました。',
    'まず、それぞれ 1 回だけ自分の名前を送ってください。',
    CONFIG.MEMBERS.map(function (n) { return '「登録 ' + n + '」'; }).join(' / '),
    '',
    helpText(null),
  ].join('\n');
}

function leaveChat(source) {
  const token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  const url = source.groupId
    ? 'https://api.line.me/v2/bot/group/' + source.groupId + '/leave'
    : 'https://api.line.me/v2/bot/room/' + source.roomId + '/leave';
  UrlFetchApp.fetch(url, {
    method: 'post', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true,
  });
}

// ---------------------------------------------------------------------------
// メッセージ処理
// ---------------------------------------------------------------------------

function handleText(event) {
  const text = normalizeText(event.message.text);
  const userId = event.source && event.source.userId;
  const isDirect = !event.source || event.source.type === 'user';
  // true なら関係ない発言にも返信し、金額はゆるく読み取る（1 対 1 と精算専用グループ）
  const talkative = isDirect || CONFIG.DEDICATED_GROUP;
  const strict = !talkative;
  const now = event.timestamp ? new Date(event.timestamp) : new Date();
  const props = PropertiesService.getScriptProperties();

  if (!userId) {
    return talkative || parseEntry(text, now, CONFIG.DEFAULT_CATEGORIES, true)
      ? 'だれが送ったか判別できませんでした。Bot を友だち追加してからもう一度送ってください。'
      : null;
  }

  let m;
  if ((m = text.match(/^登録\s*(\S+)$/))) {
    return registerUser(props, userId, m[1]);
  }

  const payer = props.getProperty('USER_' + userId);
  if (/^(ヘルプ|使い方|help|\?)$/i.test(text)) return helpText(payer);

  if (!payer) {
    // 会話もするグループでは、記録っぽいメッセージのときだけ案内する
    if (!talkative && !parseEntry(text, now, CONFIG.DEFAULT_CATEGORIES, true)) return null;
    return 'はじめに、だれのスマホか登録してください。\n' +
      CONFIG.MEMBERS.map(function (n) { return '「登録 ' + n + '」'; }).join(' または ') +
      ' と送ってください。';
  }

  if ((m = text.match(/^(精算|集計|合計|残高)\s*(\S*)$/))) {
    const target = m[2] ? parseMonth(m[2], now) : ymdOf(now);
    if (!target) return '月の指定が読めませんでした（例: 精算 9月 / 精算 2026/9）';
    return withLock(function () { return summaryReply(target); });
  }
  if (/^(取消|取り消し|とりけし|削除|キャンセル|undo)$/i.test(text)) {
    return withLock(function () { return undoLast(props, userId); });
  }
  if (/^(履歴|一覧|りれき)$/.test(text)) {
    return withLock(function () { return historyReply(ymdOf(now)); });
  }

  if (!parseEntry(text, now, CONFIG.DEFAULT_CATEGORIES, strict)) {
    return talkative ? '「1200 スーパー」のように、金額と内容を送ってください。\n「ヘルプ」で使い方を表示します。' : null;
  }
  return withLock(function () { return addEntry(props, userId, payer, text, now, strict); });
}

function registerUser(props, userId, name) {
  if (CONFIG.MEMBERS.indexOf(name) < 0) {
    return '登録できる名前は ' + CONFIG.MEMBERS.join(' / ') + ' です。';
  }
  const all = props.getProperties();
  for (const key in all) {
    if (key.indexOf('USER_') === 0 && all[key] === name && key !== 'USER_' + userId) {
      return '「' + name + '」はすでに別のアカウントで登録されています。\n' +
        '変更したいときは Apps Script で resetUsers() を実行してください。';
    }
  }
  props.setProperty('USER_' + userId, name);
  return '✅ 「' + name + '」として登録しました。\n\n' + helpText(name);
}

function helpText(payer) {
  const other = CONFIG.MEMBERS.filter(function (n) { return n !== payer; })[0] || CONFIG.MEMBERS[1];
  return [
    '📒 使い方',
    '・1200 スーパー → 自分が払った分として記録',
    '・1200 食べ物 オーケー → カテゴリ付きで記録',
    '・' + other + ' 800 薬局 → ' + other + 'が払った分を代わりに記録',
    '・9/28 3000 ガソリン / 昨日 500 パン → 日付を指定',
    '・精算 → 今月の精算額（「精算 9月」で過去の月）',
    '・履歴 → 今月の最近の記録',
    '・取消 → 自分が最後に記録した1件を取り消し',
    '',
    'カテゴリ: ' + CONFIG.DEFAULT_CATEGORIES.join(' / '),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 文字列の解析（スプレッドシートに依存しない純粋な関数）
// ---------------------------------------------------------------------------

function normalizeText(text) {
  return String(text || '')
    .normalize('NFKC') // 全角数字・全角スペース・￥ などを半角に
    .replace(/[−–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const AMOUNT_TOKEN = /^(-)?[¥\\]?(\d{1,3}(?:,\d{3})+|\d+)円?$/;

function parseAmount(token) {
  const m = token.match(AMOUNT_TOKEN);
  if (!m) return null;
  const value = Number(m[2].replace(/,/g, ''));
  if (!value) return null;
  return m[1] ? -value : value;
}

/**
 * 「1200 食べ物 スーパー」「スーパー 1,200円」「あおい 800 薬局」「9/28 3000 ガソリン」などを解析する。
 * 金額が見つからなければ null。
 * strict のとき（会話もするグループ。CONFIG.DEDICATED_GROUP = false）は、数字が文字にくっついている場合「円」か「¥」が付いたものだけを金額とみなす
 * （「1200円スーパー」は OK、「明日10時に」「セブン11」は無視）。
 * @return {{amount:number, payer:(string|null), category:string, comment:string, date:{y:number,m:number,d:number}}|null}
 */
function parseEntry(text, now, categories, strict) {
  text = normalizeText(text);
  if (!text) return null;
  let tokens = text.split(' ');

  // 区切りなしの「1200スーパー」「昨日500パン」も受け付ける（数字のかたまりで区切り直す）
  if (!tokens.some(function (t) { return parseAmount(t) !== null; })) {
    const chunk = strict
      ? /(-?[¥\\]\d[\d,]*円?|-?\d[\d,]*円|\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日|\d{1,2}日)/g
      : /(-?[¥\\]?\d[\d,\/]*(?:月\d{1,2}日|円|日)?)/g;
    tokens = text.replace(chunk, ' $1 ').split(' ').filter(String);
  }

  const today = ymdOf(now);
  let amount = null;
  let payer = null;
  let category = '';
  let date = null;
  const rest = [];

  tokens.forEach(function (token) {
    if (amount === null && parseAmount(token) !== null) { amount = parseAmount(token); return; }
    const bare = token.replace(/^[@＠]/, '');
    if (payer === null && CONFIG.MEMBERS.indexOf(bare) >= 0) { payer = bare; return; }
    if (date === null) {
      const d = parseDay(token, today);
      if (d) { date = d; return; }
    }
    if (!category && categories.indexOf(token) >= 0) { category = token; return; }
    if (!category && CONFIG.CATEGORY_ALIASES[token] && categories.indexOf(CONFIG.CATEGORY_ALIASES[token]) >= 0) {
      category = CONFIG.CATEGORY_ALIASES[token]; // 言葉はコメントとしても残す
    }
    rest.push(token);
  });

  if (amount === null) return null;
  return { amount: amount, payer: payer, category: category, comment: rest.join(' '), date: date || today };
}

/** 「9/28」「28日」「今日」「昨日」「おととい」を日付にする。 */
function parseDay(token, today) {
  const base = new Date(today.y, today.m - 1, today.d);
  const offsets = { '今日': 0, 'きょう': 0, '昨日': 1, 'きのう': 1, '一昨日': 2, 'おととい': 2 };
  if (token in offsets) {
    base.setDate(base.getDate() - offsets[token]);
    return { y: base.getFullYear(), m: base.getMonth() + 1, d: base.getDate() };
  }
  let m, month, day;
  if ((m = token.match(/^(\d{1,2})\/(\d{1,2})$/)) || (m = token.match(/^(\d{1,2})月(\d{1,2})日$/))) {
    month = Number(m[1]); day = Number(m[2]);
  } else if ((m = token.match(/^(\d{1,2})日$/))) {
    month = today.m; day = Number(m[1]);
  } else {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let year = today.y;
  // 1月に「12/30」と送ったら去年の12月とみなす
  if (month > today.m + 1) year -= 1;
  const date = new Date(year, month - 1, day);
  if (date.getMonth() !== month - 1) return null; // 2/30 など
  return { y: year, m: month, d: day };
}

/** 「9月」「2026/9」「先月」を {y, m} にする。 */
function parseMonth(token, now) {
  const today = ymdOf(now);
  let m;
  if (token === '今月') return { y: today.y, m: today.m };
  if (token === '先月') return today.m === 1 ? { y: today.y - 1, m: 12 } : { y: today.y, m: today.m - 1 };
  if ((m = token.match(/^(\d{4})[\/年](\d{1,2})月?$/))) return { y: Number(m[1]), m: Number(m[2]) };
  if ((m = token.match(/^(\d{1,2})月?$/))) {
    const month = Number(m[1]);
    if (month < 1 || month > 12) return null;
    return { y: month > today.m ? today.y - 1 : today.y, m: month };
  }
  return null;
}

function ymdOf(date) {
  const s = Utilities.formatDate(date, CONFIG.TIMEZONE, 'yyyy-M-d').split('-');
  return { y: Number(s[0]), m: Number(s[1]), d: Number(s[2]) };
}

function yen(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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

/** その月のシートを取得。なければ template をコピーして「2026/10」の形で作る。 */
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

function addEntry(props, userId, defaultPayer, text, now, strict) {
  const ss = getSpreadsheet();
  const date = parseEntry(text, now, CONFIG.DEFAULT_CATEGORIES, strict).date;
  const sheet = getOrCreateMonthSheet(ss, { y: date.y, m: date.m });
  // カテゴリはその月のシートのプルダウンにあるものだけ使う（入力規則の警告を避ける）
  const entry = parseEntry(text, now, categoriesOf(sheet), strict);
  if (!entry.payer) entry.payer = defaultPayer;

  const row = lastDataRow(sheet) + 1;
  sheet.getRange(row, 1, 1, CONFIG.DATA_COLUMNS)
    .setValues([[entry.date.d, entry.amount, entry.payer, entry.category, entry.comment]]);
  sheet.getRange(row, 2).setNumberFormat('#,##0');
  SpreadsheetApp.flush();

  props.setProperty('LAST_' + userId, JSON.stringify({
    sheet: sheet.getName(), row: row, amount: entry.amount, payer: entry.payer,
  }));

  const line = entry.date.m + '/' + entry.date.d + ' ' + entry.payer + ' ' + yen(entry.amount) + '円' +
    (entry.category ? ' [' + entry.category + ']' : '') + (entry.comment ? ' ' + entry.comment : '');
  return '✅ 記録しました（' + sheet.getName() + '）\n' + line + '\n\n' + summaryText(sheet);
}

function undoLast(props, userId) {
  const raw = props.getProperty('LAST_' + userId);
  if (!raw) return '取り消せる記録がありません（取り消しは最後の1件だけです）';
  const last = JSON.parse(raw);
  const sheet = getSpreadsheet().getSheetByName(last.sheet);
  if (!sheet) return '「' + last.sheet + '」シートが見つかりません';
  const range = sheet.getRange(last.row, 1, 1, CONFIG.DATA_COLUMNS);
  const values = range.getValues()[0];
  if (Number(values[1]) !== last.amount || values[2] !== last.payer) {
    props.deleteProperty('LAST_' + userId);
    return 'シートが手で編集されているため、取り消しませんでした。スプレッドシートで直接修正してください。';
  }
  range.clearContent();
  SpreadsheetApp.flush();
  props.deleteProperty('LAST_' + userId);
  return '↩️ 取り消しました（' + last.sheet + '）\n' + values[2] + ' ' + yen(values[1]) + '円 ' +
    (values[4] || '') + '\n\n' + summaryText(sheet);
}

function summaryReply(ym) {
  const sheet = findMonthSheet(getSpreadsheet(), ym);
  if (!sheet) return ym.y + '/' + ym.m + ' のシートはまだありません';
  return '📊 ' + sheet.getName() + '\n' + summaryText(sheet);
}

function historyReply(ym) {
  const sheet = findMonthSheet(getSpreadsheet(), ym);
  if (!sheet) return ym.y + '/' + ym.m + ' のシートはまだありません';
  const last = lastDataRow(sheet);
  if (last < 2) return 'まだ記録がありません';
  const from = Math.max(2, last - CONFIG.HISTORY_COUNT + 1);
  const rows = sheet.getRange(from, 1, last - from + 1, CONFIG.DATA_COLUMNS).getValues();
  const lines = rows
    .filter(function (r) { return r[1] !== '' && r[1] !== null; })
    .map(function (r) {
      return (r[0] !== '' ? r[0] + '日 ' : '') + r[2] + ' ' + yen(Number(r[1])) + '円' +
        (r[3] ? ' [' + r[3] + ']' : '') + (r[4] ? ' ' + r[4] : '');
    });
  return '🧾 ' + sheet.getName() + ' の最近の記録\n' + lines.join('\n');
}

/**
 * シートの集計欄（合計支出・支払額・負担する額・精算額）を読んでメッセージにする。
 * 「メンバー名 | 支払額 | 負担する額 | 精算額」と数字が並んでいる行を F〜L 列から探す。
 */
function summaryText(sheet) {
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
        people.push({ name: r[k], paid: r[k + 1], share: r[k + 2], diff: r[k + 3] });
      }
    }
  });
  if (people.length < 2) return '（集計欄が見つかりませんでした）';

  const lines = [];
  if (total !== null) lines.push('合計支出: ' + yen(total) + '円');
  people.forEach(function (p) {
    lines.push(p.name + ': 支払 ' + yen(p.paid) + ' / 負担 ' + yen(p.share));
  });
  const debtor = people.filter(function (p) { return Math.round(p.diff) > 0; })[0];
  const creditor = people.filter(function (p) { return Math.round(p.diff) < 0; })[0];
  if (debtor && creditor) {
    lines.push('👉 ' + debtor.name + ' → ' + creditor.name + ' に ' + yen(debtor.diff) + '円');
  } else {
    lines.push('👉 精算なし（ぴったり）');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000); // 2人が同時に送っても同じ行に書かないように
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function replyToLine(replyToken, text) {
  const token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN が設定されていません');
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: [{ type: 'text', text: text.slice(0, 5000) }],
    }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    console.error('LINE reply failed: ' + res.getResponseCode() + ' ' + res.getContentText());
  }
}

function textOutput(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.TEXT);
}

// Node.js でのテスト用（Apps Script 上では module が無いので無視される）
if (typeof module !== 'undefined') {
  module.exports = {
    CONFIG, doPost, handleText, parseEntry, parseDay, parseMonth, parseAmount, normalizeText,
  };
}
