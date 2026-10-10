/* わりかん: 2 人の生活費を記録して割り勘する PWA。
 * データは Cloudflare D1 に保存（/api/* は Cloudflare Pages Functions）。 */
(function () {
  'use strict';

  const STORE = {
    queue: 'warikan.queue', // 送信待ちの記録（電波がないとき）
    cache: 'warikan.cache', // 最後に表示した月のデータ（すぐ表示するため）
    user: 'warikan.user',
  };
  const RETRY_MS = 15000;

  const $ = (id) => document.getElementById(id);
  const state = {
    user: null,
    session: null, // /api/session の結果
    data: null, // /api/month の結果
    queue: [],
    payer: null,
    category: '',
    editing: null, // 編集中の記録
    loginName: null,
    loading: false,
    flushing: false,
    retryTimer: null,
  };

  // ---- localStorage（使えない環境でも落ちないように） ----
  function load(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      if (value === null || value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* 保存できなくても動作は続ける */ }
  }

  // ---- 表示用 ----
  const yen = (n) => '¥' + Math.round(Math.abs(n)).toLocaleString('ja-JP');
  const monthLabel = (m) => { const [y, mo] = m.split('-'); return `${y}年${Number(mo)}月`; };
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach((c) => c && node.append(c));
    return node;
  }
  let toastTimer = null;
  function toast(message, isError) {
    const t = $('toast');
    t.textContent = message;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 5000 : 2200);
  }
  function todayIso() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function show(screen) {
    ['boot', 'login', 'app'].forEach((id) => { $(id).hidden = id !== screen; });
  }

  // ---- API ----
  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }
  async function api(method, path, data) {
    let res;
    try {
      res = await fetch('/api' + path, {
        method,
        credentials: 'same-origin',
        headers: Object.assign({ 'X-Warikan': '1' }, data ? { 'Content-Type': 'application/json' } : {}),
        body: data ? JSON.stringify(data) : undefined,
      });
    } catch (e) {
      throw new ApiError('通信できませんでした', 0);
    }
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && json.error === 'login') {
      showLogin();
      throw new ApiError('ログインしてください', 401);
    }
    if (!res.ok) throw new ApiError(json.error || 'エラーが発生しました（' + res.status + '）', res.status);
    return json;
  }

  function applyData(data) {
    if (!data) return;
    state.data = data;
    save(STORE.cache, data);
    render();
  }

  // month: 'YYYY-MM'。省略すると表示中の月、null なら今月
  async function refresh(month) {
    const target = month === null ? '' : (month || (state.data && state.data.month) || '');
    state.loading = true;
    renderStatus();
    try {
      applyData(await api('GET', '/month' + (target ? '?m=' + target : '')));
    } catch (e) {
      if (e.status !== 401) toast(e.status === 0 ? '通信できませんでした。電波のよいところで更新してください' : e.message, true);
    } finally {
      state.loading = false;
      renderStatus();
    }
  }

  // ---- 送信待ちキュー ----
  async function flushQueue() {
    if (state.flushing || !state.queue.length || !state.user) return;
    state.flushing = true;
    clearTimeout(state.retryTimer);
    renderStatus();
    try {
      while (state.queue.length) {
        const item = state.queue[0];
        try {
          const data = await api('POST', '/expenses', Object.assign({ clientId: item.id }, item.entry));
          applyData(data);
        } catch (e) {
          if (e.status === 0) { state.retryTimer = setTimeout(flushQueue, RETRY_MS); return; }
          if (e.status === 401) return;
          toast('記録できませんでした: ' + e.message, true); // 内容の誤りは送り直しても同じなので捨てる
        }
        state.queue.shift();
        save(STORE.queue, state.queue);
      }
    } finally {
      state.flushing = false;
      render();
    }
  }

  function enqueue(entry) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    state.queue.push({ id, entry });
    save(STORE.queue, state.queue);
    render();
    flushQueue();
  }

  // ---- ログイン ----
  async function showLogin(error) {
    state.user = null;
    save(STORE.user, null);
    show('login');
    $('login-error').textContent = error || '';
    try {
      state.session = await api('GET', '/session');
    } catch (e) {
      $('login-error').textContent = e.message;
    }
    renderLogin();
  }

  function renderLogin() {
    const members = (state.session && state.session.members) || [];
    $('login-members').replaceChildren(...members.map((m) => el('button', {
      type: 'button', role: 'radio', text: m.name, 'aria-checked': String(m.name === state.loginName),
      onclick: () => { state.loginName = m.name; $('login-error').textContent = ''; renderLogin(); $('login-password').focus(); },
    })));
    const member = members.find((m) => m.name === state.loginName);
    $('login-fields').hidden = !member;
    if (!member) return;
    const registering = !member.registered;
    $('login-name').value = member.name;
    $('login-lead').textContent = registering ? `${member.name} さん、はじめまして` : `${member.name} さん、おかえりなさい`;
    $('login-hint').textContent = registering ? 'このアプリで使うパスワードを決めてください（8文字以上）' : '';
    $('login-password').autocomplete = registering ? 'new-password' : 'current-password';
    $('login-password2').hidden = !registering;
    $('login-password2').required = registering;
    $('login-code').hidden = !(registering && state.session.signupCodeRequired);
    $('login-submit').textContent = registering ? 'パスワードを登録してはじめる' : 'ログイン';
  }

  async function onLogin(ev) {
    ev.preventDefault();
    const member = state.session.members.find((m) => m.name === state.loginName);
    if (!member) return;
    const password = $('login-password').value;
    if (!member.registered && password !== $('login-password2').value) {
      $('login-error').textContent = '確認用のパスワードが一致しません';
      return;
    }
    $('login-submit').disabled = true;
    try {
      const res = member.registered
        ? await api('POST', '/login', { name: member.name, password })
        : await api('POST', '/register', { name: member.name, password, code: $('login-code').value });
      $('login-password').value = '';
      $('login-password2').value = '';
      startApp(res.user);
    } catch (e) {
      $('login-error').textContent = e.message;
      if (e.status === 409) showLogin(e.message);
    } finally {
      $('login-submit').disabled = false;
    }
  }

  function startApp(user) {
    if (state.user !== user) {
      // 別の人でログインしたら、前の人の表示は消す
      if (load(STORE.user, null) !== user) { state.data = null; save(STORE.cache, null); }
    }
    state.user = user;
    state.payer = user;
    save(STORE.user, user);
    show('app');
    render();
    refresh(null);
    flushQueue();
  }

  // ---- 描画 ----
  function render() {
    if ($('app').hidden) return;
    renderMonth();
    renderSummary();
    renderForm();
    renderEntries();
    renderStatus();
  }

  function renderMonth() {
    const select = $('month-select');
    const months = (state.data && state.data.months) || [];
    const current = state.data ? state.data.month : '';
    select.replaceChildren(...months.map((m) => el('option', { value: m, text: monthLabel(m), selected: m === current })));
    const i = months.indexOf(current); // 新しい月が先頭
    $('prev-month').disabled = i < 0 || i >= months.length - 1;
    $('next-month').disabled = i <= 0;
  }

  function renderSummary() {
    const s = state.data && state.data.summary;
    const t = s && s.transfer;
    $('settle-label').textContent = t ? `${t.from} → ${t.to}` : '精算';
    $('settle-amount').textContent = !s ? '—' : t ? yen(t.amount) : 'なし';
    $('summary-total').textContent = s ? `${monthLabel(state.data.month)}の合計 ${yen(s.total)}` : '';
    $('people').replaceChildren(...((s && s.people) || []).map((p) => el('div', { class: 'person' }, [
      el('strong', { text: p.name }),
      el('span', { text: '支払 ' + yen(p.paid) }), el('br'),
      el('span', { text: '負担 ' + yen(p.share) }),
    ])));

    const settled = state.data && state.data.settlement;
    const status = $('settle-status');
    if (settled) {
      const d = new Date(settled.at);
      const changed = !t ? settled.amount !== 0 : (settled.amount !== t.amount || settled.from !== t.from);
      status.textContent = `✓ ${d.getMonth() + 1}/${d.getDate()} に精算済み` + (changed ? '（その後、記録が変わっています）' : '');
      status.className = 'settle-status done' + (changed ? ' changed' : '');
      $('settle-btn').textContent = '精算を取り消す';
    } else {
      status.textContent = '';
      status.className = 'settle-status';
      $('settle-btn').textContent = '精算済みにする';
    }
    $('settle-btn').hidden = !s || (!t && !settled);
  }

  function renderForm() {
    const members = (state.data && state.data.members) || (state.user ? [state.user] : []);
    if (!state.payer) state.payer = state.user;
    $('payer').replaceChildren(...members.map((name) => el('button', {
      type: 'button', role: 'radio', text: name + (name === state.user ? '（自分）' : ''),
      'aria-checked': String(name === state.payer),
      onclick: () => { state.payer = name; renderForm(); },
    })));

    const categories = ['', ...((state.data && state.data.categories) || [])];
    $('categories').replaceChildren(...categories.map((c) => el('button', {
      type: 'button', role: 'radio', text: c || 'なし', 'aria-checked': String(c === state.category),
      onclick: () => { state.category = c; renderForm(); },
    })));

    const suggestions = (state.data && state.data.suggestions) || [];
    $('suggestions').replaceChildren(...suggestions.map((s) => el('button', {
      type: 'button', text: s.comment,
      onclick: () => {
        $('comment').value = s.comment;
        if (s.category && categories.includes(s.category)) state.category = s.category;
        renderForm();
      },
    })));
    $('suggestions').hidden = !!state.editing;

    if (!$('date').value) $('date').value = todayIso();
    $('edit-banner').hidden = !state.editing;
    $('submit').textContent = state.editing ? '更新する' : '記録する';
  }

  function renderEntries() {
    const data = state.data;
    const entries = data ? data.entries : [];
    const pending = state.queue
      .filter((q) => data && q.entry.date.slice(0, 7) === data.month)
      .map((q) => Object.assign({ pending: true }, q.entry))
      .reverse();
    const rows = pending.concat(entries);
    $('list-title').textContent = data ? monthLabel(data.month) + 'の記録' : '記録';
    $('list-count').textContent = rows.length ? rows.length + '件' : '';
    $('empty').hidden = rows.length > 0;
    $('entries').replaceChildren(...rows.map((e) => el('li', {
      class: 'entry-row' + (e.pending ? ' pending' : '') + (state.editing && state.editing.id === e.id ? ' editing' : ''),
    }, [
      el('button', {
        type: 'button', class: 'entry-tap', disabled: e.pending, 'aria-label': '編集',
        onclick: () => startEdit(e),
      }, [
        el('span', { class: 'entry-day', text: Number(e.date.slice(8)) + '日' }),
        el('span', { class: 'entry-main' }, [
          el('span', { class: 'entry-comment', text: e.comment || e.category || '（メモなし）' }),
          el('span', { class: 'entry-meta' }, [
            el('span', { class: 'badge' + (e.payer === state.user ? ' me' : ''), text: e.payer }),
            e.category && e.comment ? el('span', { text: e.category }) : null,
            e.created_by === '自動' ? el('span', { text: '固定費' }) : null,
            e.pending ? el('span', { class: 'badge pending', text: '送信待ち' }) : null,
          ]),
        ]),
        el('span', { class: 'entry-amount', text: (e.amount < 0 ? '−' : '') + yen(e.amount) }),
      ]),
      e.pending ? el('span') : el('button', {
        class: 'delete-btn', type: 'button', 'aria-label': '削除', text: '×',
        onclick: () => removeEntry(e),
      }),
    ])));
  }

  function renderStatus() {
    $('refresh').classList.toggle('spinning', state.loading || state.flushing);
    $('status-line').textContent = state.queue.length
      ? '送信待ち ' + state.queue.length + '件' + (navigator.onLine ? '' : '（オフライン）') : '';
  }

  // ---- 操作 ----
  function resetForm() {
    state.editing = null;
    $('amount').value = '';
    $('comment').value = '';
    $('date').value = todayIso();
    state.category = '';
    state.payer = state.user;
  }

  function startEdit(e) {
    state.editing = e;
    $('amount').value = Math.abs(e.amount).toLocaleString('ja-JP');
    $('comment').value = e.comment;
    $('date').value = e.date;
    state.category = e.category;
    state.payer = e.payer;
    render();
    $('entry-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    const amount = Number($('amount').value.replace(/[^\d]/g, ''));
    if (!amount) {
      toast('金額を入力してください', true);
      $('amount').focus();
      return;
    }
    const entry = {
      date: $('date').value || todayIso(),
      amount: state.editing && state.editing.amount < 0 ? -amount : amount,
      payer: state.payer || state.user,
      category: state.category,
      comment: $('comment').value.trim(),
    };
    $('amount').blur();
    $('comment').blur();

    if (state.editing) {
      const id = state.editing.id;
      $('submit').disabled = true;
      try {
        applyData(await api('PUT', '/expenses/' + id, entry));
        toast('更新しました');
        resetForm();
        render();
      } catch (e) {
        if (e.status !== 401) toast(e.message, true);
      } finally {
        $('submit').disabled = false;
      }
      return;
    }

    enqueue(entry);
    toast(entry.payer + ' ' + yen(amount) + ' を記録しました');
    resetForm();
    if (state.data && entry.date.slice(0, 7) !== state.data.month) refresh(entry.date.slice(0, 7));
    render();
  }

  async function removeEntry(e) {
    if (!confirm(`${Number(e.date.slice(8))}日 ${e.payer} ${yen(e.amount)} ${e.comment || ''}\nこの記録を削除しますか？`)) return;
    state.loading = true;
    renderStatus();
    try {
      applyData(await api('DELETE', '/expenses/' + e.id));
      if (state.editing && state.editing.id === e.id) { resetForm(); render(); }
      toast('削除しました');
    } catch (err) {
      if (err.status === 404) refresh();
      if (err.status !== 401) toast(err.message, true);
    } finally {
      state.loading = false;
      renderStatus();
    }
  }

  async function toggleSettle() {
    const d = state.data;
    if (!d) return;
    try {
      if (d.settlement) {
        if (!confirm(monthLabel(d.month) + 'の「精算済み」を取り消しますか？')) return;
        applyData(await api('DELETE', '/settlements/' + d.month));
      } else {
        const t = d.summary.transfer;
        if (!confirm(`${monthLabel(d.month)}を精算済みにしますか？\n${t.from} → ${t.to} ${yen(t.amount)}`)) return;
        applyData(await api('POST', '/settlements', { month: d.month }));
        toast('精算済みにしました');
      }
    } catch (e) {
      if (e.status !== 401) toast(e.message, true);
    }
  }

  function moveMonth(step) {
    const months = (state.data && state.data.months) || [];
    const next = months[months.indexOf(state.data.month) - step]; // 先頭ほど新しい
    if (next) refresh(next);
  }

  function formatAmountInput() {
    const input = $('amount');
    const digits = input.value.normalize('NFKC').replace(/[^\d]/g, '').replace(/^0+/, '').slice(0, 8);
    input.value = digits ? Number(digits).toLocaleString('ja-JP') : '';
  }

  async function onChangePassword(ev) {
    ev.preventDefault();
    $('pw-message').textContent = '';
    try {
      await api('POST', '/password', { current: $('pw-current').value, next: $('pw-next').value });
      $('pw-current').value = '';
      $('pw-next').value = '';
      $('pw-message').textContent = '変更しました。ほかの端末はログアウトされました';
    } catch (e) {
      if (e.status !== 401) $('pw-message').textContent = e.message;
    }
  }

  // ---- 起動 ----
  function bind() {
    $('login-form').addEventListener('submit', onLogin);
    $('entry-form').addEventListener('submit', onSubmit);
    $('amount').addEventListener('input', formatAmountInput);
    $('cancel-edit').addEventListener('click', () => { resetForm(); render(); });
    $('refresh').addEventListener('click', () => { refresh(); flushQueue(); });
    $('prev-month').addEventListener('click', () => moveMonth(-1));
    $('next-month').addEventListener('click', () => moveMonth(1));
    $('month-select').addEventListener('change', (ev) => refresh(ev.target.value));
    $('settle-btn').addEventListener('click', toggleSettle);
    $('open-settings').addEventListener('click', () => {
      $('settings-me').textContent = state.user || '';
      $('pw-username').value = state.user || '';
      $('pw-message').textContent = '';
      $('settings').showModal();
    });
    $('close-settings').addEventListener('click', () => $('settings').close());
    $('password-form').addEventListener('submit', onChangePassword);
    $('logout').addEventListener('click', async () => {
      if (!confirm('ログアウトしますか？')) return;
      try { await api('POST', '/logout'); } catch (e) { /* オフラインでも画面はログアウトする */ }
      $('settings').close();
      state.data = null;
      state.queue = [];
      save(STORE.cache, null);
      save(STORE.queue, null);
      showLogin();
    });
    window.addEventListener('online', () => { flushQueue(); renderStatus(); });
    window.addEventListener('offline', renderStatus);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.user) { refresh(null); flushQueue(); }
    });
  }

  async function start() {
    bind();
    state.queue = load(STORE.queue, []);
    const cachedUser = load(STORE.user, null);
    state.data = load(STORE.cache, null);
    // 前回ログインしていたら、通信を待たずに前回の表示を出しておく
    if (cachedUser && state.data) {
      state.user = cachedUser;
      state.payer = cachedUser;
      show('app');
      render();
    }
    try {
      const session = await api('GET', '/session');
      state.session = session;
      if (session.user) startApp(session.user);
      else showLogin();
    } catch (e) {
      // オフライン: 前回の表示のまま使える（記録は送信待ちになる）
      if (cachedUser && state.data) { renderStatus(); return; }
      show('login');
      $('login-error').textContent = '通信できませんでした。電波のよいところで開き直してください';
    }
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  start();
})();
