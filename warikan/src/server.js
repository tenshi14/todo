// わりかん API（Cloudflare Pages Functions で動く）。データは Cloudflare D1 に保存する。
import { MEMBERS, CATEGORIES, RECURRING, SESSION_DAYS } from './config.js';

const COOKIE = 'warikan_session';
const PBKDF2_ITERATIONS = 20000; // 無料プランの CPU 時間（1 リクエスト 10ms）に収まる範囲
const MAX_FAILURES = 10; // 15 分間にこれだけ失敗したら、その名前でのログインを止める
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MEMBER_NAMES = MEMBERS.map((m) => m.name);

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export async function handle(request, env) {
  try {
    if (!env.DB) {
      return json({ error: 'データベース（D1）がつながっていません。Cloudflare Pages の設定で、変数名 DB の D1 バインディングを追加してください' }, 500);
    }
    await ensureSchema(env.DB);
    return await route(request, env);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err && err.stack ? err.stack : err);
    return json({ error: 'サーバーでエラーが発生しました' }, 500);
  }
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';
  const method = request.method;

  // 他のサイトからの書き換え（CSRF）を防ぐ: 書き込み系はこのアプリだけが付けるヘッダーを必須にする
  if (method !== 'GET' && method !== 'HEAD' && request.headers.get('X-Warikan') !== '1') {
    return json({ error: 'forbidden' }, 403);
  }

  // ---- ログイン不要 ----
  if (method === 'GET' && path === '/session') return getSession(request, env);
  if (method === 'POST' && path === '/register') return register(request, env);
  if (method === 'POST' && path === '/login') return login(request, env);
  if (method === 'POST' && path === '/logout') return logout(request, env);

  // ---- ここから先はログインが必要 ----
  const user = await currentUser(request, env.DB);
  if (!user) return json({ error: 'login' }, 401);

  let m;
  if (method === 'GET' && path === '/month') return json(await monthData(env.DB, url.searchParams.get('m') || currentMonth()));
  if (method === 'POST' && path === '/expenses') return createExpense(request, env.DB, user);
  if ((m = path.match(/^\/expenses\/(\d+)$/))) {
    if (method === 'PUT') return updateExpense(request, env.DB, user, Number(m[1]));
    if (method === 'DELETE') return deleteExpense(env.DB, Number(m[1]));
  }
  if (method === 'POST' && path === '/settlements') return settle(request, env.DB, user);
  if (method === 'DELETE' && (m = path.match(/^\/settlements\/(\d{4}-\d{2})$/))) return unsettle(env.DB, m[1]);
  if (method === 'POST' && path === '/password') return changePassword(request, env.DB, user);
  if (method === 'GET' && path === '/export.csv') return exportCsv(env.DB);

  return json({ error: 'not found' }, 404);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers),
  });
}

async function body(request) {
  try {
    return await request.json();
  } catch (e) {
    throw new HttpError(400, 'リクエストが読み取れません');
  }
}

// ---------------------------------------------------------------------------
// データベース
// ---------------------------------------------------------------------------

let schemaReady = null;

/** 初回アクセス時にテーブルを作る（D1 のコンソールでの作業は不要） */
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, password TEXT NOT NULL, created_at TEXT NOT NULL)'),
      db.prepare('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, name TEXT NOT NULL, expires_at INTEGER NOT NULL)'),
      db.prepare('CREATE TABLE IF NOT EXISTS login_failures (name TEXT NOT NULL, at INTEGER NOT NULL)'),
      db.prepare(`CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        amount INTEGER NOT NULL,
        payer TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '',
        comment TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        client_id TEXT UNIQUE
      )`),
      db.prepare('CREATE INDEX IF NOT EXISTS expenses_date ON expenses (date)'),
      db.prepare(`CREATE TABLE IF NOT EXISTS settlements (
        month TEXT PRIMARY KEY,
        amount INTEGER NOT NULL,
        from_name TEXT NOT NULL,
        to_name TEXT NOT NULL,
        settled_by TEXT NOT NULL,
        settled_at TEXT NOT NULL
      )`),
      db.prepare('CREATE TABLE IF NOT EXISTS applied (key TEXT PRIMARY KEY)'),
    ]).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

// ---------------------------------------------------------------------------
// 日付（日本時間）
// ---------------------------------------------------------------------------

function todayJst() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function currentMonth() {
  return todayJst().slice(0, 7);
}
function nowIso() {
  return new Date().toISOString();
}
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function nextMonth(month) {
  let [y, m] = month.split('-').map(Number);
  m += 1;
  if (m > 12) { y += 1; m = 1; }
  return y + '-' + String(m).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// ログイン
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));

async function hashPassword(password, saltHex, iterations = PBKDF2_ITERATIONS) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2$${iterations}$${toHex(salt)}$${toHex(bits)}`;
}

async function verifyPassword(password, stored) {
  const [scheme, iterations, salt, expected] = String(stored).split('$');
  if (scheme !== 'pbkdf2') return false;
  const actual = (await hashPassword(password, salt, Number(iterations))).split('$')[3];
  // 長さは同じなので、1 文字ずつ全部比べる（タイミング攻撃対策）
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0 && actual.length === expected.length;
}

async function sha256(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

function cookieOf(request) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  return m ? m[1] : null;
}

function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function currentUser(request, db) {
  const token = cookieOf(request);
  if (!token) return null;
  const row = await db.prepare('SELECT name FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(await sha256(token), Date.now()).first();
  return row && MEMBER_NAMES.includes(row.name) ? row.name : null;
}

async function startSession(db, name) {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const maxAge = SESSION_DAYS * 24 * 3600;
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(Date.now()),
    db.prepare('INSERT INTO sessions (token_hash, name, expires_at) VALUES (?, ?, ?)')
      .bind(await sha256(token), name, Date.now() + maxAge * 1000),
  ]);
  return json({ user: name }, 200, { 'Set-Cookie': sessionCookie(token, maxAge) });
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'パスワードは 8 文字以上にしてください');
  if (password.length > 200) throw new HttpError(400, 'パスワードが長すぎます');
}

async function getSession(request, env) {
  const user = await currentUser(request, env.DB);
  const { results } = await env.DB.prepare('SELECT name FROM users').all();
  const registered = results.map((r) => r.name);
  return json({
    user,
    members: MEMBERS.map((m) => ({ name: m.name, registered: registered.includes(m.name) })),
    signupCodeRequired: !!env.SIGNUP_CODE,
  });
}

/** パスワードの初回登録。まだパスワードがないメンバーだけが登録できる */
async function register(request, env) {
  const { name, password, code } = await body(request);
  if (!MEMBER_NAMES.includes(name)) throw new HttpError(400, 'メンバーを選んでください');
  if (env.SIGNUP_CODE && code !== env.SIGNUP_CODE) throw new HttpError(403, '招待コードが違います');
  checkPassword(password);
  const res = await env.DB.prepare('INSERT OR IGNORE INTO users (name, password, created_at) VALUES (?, ?, ?)')
    .bind(name, await hashPassword(password), nowIso()).run();
  if (!res.meta.changes) throw new HttpError(409, `「${name}」はすでに登録されています。ログインしてください`);
  return startSession(env.DB, name);
}

async function login(request, env) {
  const { name, password } = await body(request);
  if (!MEMBER_NAMES.includes(name) || typeof password !== 'string') throw new HttpError(400, '名前とパスワードを入力してください');
  const db = env.DB;
  const since = Date.now() - FAILURE_WINDOW_MS;
  const failures = await db.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE name = ? AND at > ?').bind(name, since).first();
  if (failures.n >= MAX_FAILURES) throw new HttpError(429, 'パスワードを何度も間違えたので、15 分ほど待ってからもう一度お試しください');

  const user = await db.prepare('SELECT password FROM users WHERE name = ?').bind(name).first();
  if (!user || !(await verifyPassword(password, user.password))) {
    await db.batch([
      db.prepare('DELETE FROM login_failures WHERE at <= ?').bind(since),
      db.prepare('INSERT INTO login_failures (name, at) VALUES (?, ?)').bind(name, Date.now()),
    ]);
    throw new HttpError(401, user ? 'パスワードが違います' : `「${name}」はまだパスワードが登録されていません`);
  }
  await db.prepare('DELETE FROM login_failures WHERE name = ?').bind(name).run();
  return startSession(db, name);
}

async function logout(request, env) {
  const token = cookieOf(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ user: null }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

async function changePassword(request, db, user) {
  const { current, next } = await body(request);
  const row = await db.prepare('SELECT password FROM users WHERE name = ?').bind(user).first();
  if (!row || !(await verifyPassword(String(current || ''), row.password))) throw new HttpError(400, '今のパスワードが違います');
  checkPassword(next);
  await db.batch([
    db.prepare('UPDATE users SET password = ? WHERE name = ?').bind(await hashPassword(next), user),
    // ほかの端末のログインは解除する（この端末も新しくログインし直す）
    db.prepare('DELETE FROM sessions WHERE name = ?').bind(user),
  ]);
  return startSession(db, user);
}

// ---------------------------------------------------------------------------
// 記録
// ---------------------------------------------------------------------------

function validateExpense(input) {
  const date = input.date;
  const amount = Number(input.amount);
  const payer = input.payer;
  const category = input.category || '';
  const comment = String(input.comment || '').trim();
  if (!isValidDate(date)) throw new HttpError(400, '日付が正しくありません');
  if (!Number.isInteger(amount) || amount === 0) throw new HttpError(400, '金額は 0 以外の整数で入力してください');
  if (Math.abs(amount) > 10000000) throw new HttpError(400, '金額が大きすぎます');
  if (!MEMBER_NAMES.includes(payer)) throw new HttpError(400, '払った人を選んでください');
  if (category && !CATEGORIES.includes(category)) throw new HttpError(400, '「何の費用？」が正しくありません');
  if (comment.length > 200) throw new HttpError(400, 'メモが長すぎます');
  return { date, amount, payer, category, comment };
}

async function createExpense(request, db, user) {
  const input = await body(request);
  const e = validateExpense(input);
  const clientId = typeof input.clientId === 'string' && input.clientId ? input.clientId.slice(0, 64) : null;
  // 電波が悪くて再送されても、同じ clientId なら二重に記録しない
  await db.prepare(`INSERT INTO expenses (date, amount, payer, category, comment, created_by, created_at, client_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (client_id) DO NOTHING`)
    .bind(e.date, e.amount, e.payer, e.category, e.comment, user, nowIso(), clientId).run();
  return json(await monthData(db, e.date.slice(0, 7)));
}

async function updateExpense(request, db, user, id) {
  const e = validateExpense(await body(request));
  const res = await db.prepare(`UPDATE expenses SET date = ?, amount = ?, payer = ?, category = ?, comment = ?, updated_at = ?
      WHERE id = ?`).bind(e.date, e.amount, e.payer, e.category, e.comment, nowIso(), id).run();
  if (!res.meta.changes) throw new HttpError(404, 'この記録は削除されています');
  return json(await monthData(db, e.date.slice(0, 7)));
}

async function deleteExpense(db, id) {
  const row = await db.prepare('DELETE FROM expenses WHERE id = ? RETURNING date').bind(id).first();
  if (!row) throw new HttpError(404, 'この記録はすでに削除されています');
  return json(await monthData(db, row.date.slice(0, 7)));
}

/** その月の固定費（家賃など）を、まだ入れていなければ入れる */
async function applyRecurring(db, month) {
  for (let i = 0; i < RECURRING.length; i++) {
    const r = RECURRING[i];
    const res = await db.prepare('INSERT OR IGNORE INTO applied (key) VALUES (?)').bind(`recurring:${month}:${i}`).run();
    if (res.meta.changes) {
      await db.prepare(`INSERT INTO expenses (date, amount, payer, category, comment, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, '自動', ?)`).bind(month + '-01', r.amount, r.payer, r.category, r.comment, nowIso()).run();
    }
  }
}

// ---------------------------------------------------------------------------
// 月のデータ・精算
// ---------------------------------------------------------------------------

function summarize(entries) {
  const total = entries.reduce((s, e) => s + e.amount, 0);
  const shares = MEMBERS.reduce((s, m) => s + m.share, 0);
  const people = MEMBERS.map((m) => {
    const paid = entries.filter((e) => e.payer === m.name).reduce((s, e) => s + e.amount, 0);
    const share = (total * m.share) / shares;
    return { name: m.name, paid, share: Math.round(share), diff: Math.round(share - paid) };
  });
  const debtor = people.find((p) => p.diff > 0);
  const creditor = people.find((p) => p.diff < 0);
  const transfer = debtor && creditor ? { from: debtor.name, to: creditor.name, amount: debtor.diff } : null;
  return { total, people, transfer };
}

async function monthData(db, month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, '月の指定が正しくありません');
  const current = currentMonth();
  if (month === current) await applyRecurring(db, month);

  const [entriesRes, monthsRes, settlement, suggestionsRes] = await db.batch([
    db.prepare(`SELECT id, date, amount, payer, category, comment, created_by FROM expenses
        WHERE date >= ? AND date < ? ORDER BY date DESC, id DESC`).bind(month + '-01', nextMonth(month) + '-01'),
    db.prepare('SELECT DISTINCT substr(date, 1, 7) AS month FROM expenses ORDER BY month DESC'),
    db.prepare('SELECT amount, from_name, to_name, settled_by, settled_at FROM settlements WHERE month = ?').bind(month),
    // 最近 90 日によく使ったメモと、最後に選んだカテゴリ（入力候補）
    db.prepare(`SELECT comment, COUNT(*) AS n,
          (SELECT category FROM expenses e2 WHERE e2.comment = e1.comment AND e2.category != '' ORDER BY e2.id DESC LIMIT 1) AS category
        FROM expenses e1 WHERE comment != '' AND length(comment) <= 20 AND date >= ?
        GROUP BY comment ORDER BY n DESC, MAX(id) DESC LIMIT 12`)
      .bind(new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)),
  ]);

  const entries = entriesRes.results;
  const months = new Set(monthsRes.results.map((r) => r.month));
  months.add(current);
  months.add(month);
  const s = settlement.results[0];
  return {
    month,
    today: todayJst(),
    months: Array.from(months).sort().reverse(),
    members: MEMBERS.map((m) => m.name),
    categories: CATEGORIES,
    entries,
    summary: summarize(entries),
    settlement: s ? { amount: s.amount, from: s.from_name, to: s.to_name, by: s.settled_by, at: s.settled_at } : null,
    suggestions: suggestionsRes.results.map((r) => ({ comment: r.comment, category: r.category || '' })),
  };
}

/** その月を「精算済み」にする（そのときの精算額を記録しておく） */
async function settle(request, db, user) {
  const { month } = await body(request);
  const data = await monthData(db, String(month || ''));
  const t = data.summary.transfer || { from: '', to: '', amount: 0 };
  await db.prepare(`INSERT OR REPLACE INTO settlements (month, amount, from_name, to_name, settled_by, settled_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(data.month, t.amount, t.from, t.to, user, nowIso()).run();
  return json(await monthData(db, data.month));
}

async function unsettle(db, month) {
  await db.prepare('DELETE FROM settlements WHERE month = ?').bind(month).run();
  return json(await monthData(db, month));
}

async function exportCsv(db) {
  const { results } = await db.prepare('SELECT date, amount, payer, category, comment, created_by, created_at FROM expenses ORDER BY date, id').all();
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [['日付', '金額', '払った人', '何の費用', 'メモ', '記録した人', '記録日時']]
    .concat(results.map((r) => [r.date, r.amount, r.payer, r.category, r.comment, r.created_by, r.created_at]))
    .map((row) => row.map(cell).join(','));
  return new Response('﻿' + lines.join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="warikan-${todayJst()}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
