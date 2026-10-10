/* わりかん: 2 人の生活費を記録して 2:1 で割り勘する PWA。
 * データは Google スプレッドシート（Apps Script の API 経由）に保存する。 */
(function () {
  'use strict';

  const STORE = {
    config: 'warikan.config', // { api, key }
    me: 'warikan.me',
    queue: 'warikan.queue', // 送信待ちの記録
    cache: 'warikan.cache', // 最後に表示した月のデータ
  };
  const RETRY_MS = 15000;

  const $ = (id) => document.getElementById(id);
  const state = {
    config: null,
    me: null,
    data: null, // API の monthData
    queue: [],
    payer: null,
    category: '',
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
  function sheetNameOfDate(iso) {
    const [y, m] = iso.split('-').map(Number);
    return [y + '/' + m, m + '月'];
  }

  // ---- API ----
  async function api(body) {
    const res = await fetch(state.config.api, {
      method: 'POST',
      // text/plain にするとプリフライト（OPTIONS）が飛ばず、Apps Script で受け取れる
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ key: state.config.key }, body)),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (!json.ok && json.error === 'unauthorized') {
      showSetup('合言葉が正しくありません。セットアップ用リンクを開き直してください。');
      throw Object.assign(new Error('unauthorized'), { fatal: true });
    }
    return json;
  }

  function applyData(data) {
    if (!data) return;
    state.data = data;
    save(STORE.cache, data);
    render();
  }

  // sheet: シート名。省略すると表示中の月、null なら今月
  async function refresh(sheet) {
    if (!state.config) return;
    const target = sheet === null ? null : (sheet || (state.data && state.data.sheet) || null);
    state.loading = true;
    renderStatus();
    try {
      const res = await api({ action: 'load', sheet: target });
      if (res.ok) applyData(res.data);
      else toast(res.error, true);
    } catch (e) {
      if (!e.fatal) toast('通信できませんでした。電波のよいところで更新してください', true);
    } finally {
      state.loading = false;
      renderStatus();
    }
  }

  // ---- 送信待ちキュー（電波がなくても記録できるように） ----
  async function flushQueue() {
    if (state.flushing || !state.queue.length || !state.config) return;
    state.flushing = true;
    clearTimeout(state.retryTimer);
    renderStatus();
    try {
      while (state.queue.length) {
        const item = state.queue[0];
        let res;
        try {
          res = await api({ action: 'add', entry: item.entry, clientId: item.id });
        } catch (e) {
          if (!e.fatal) state.retryTimer = setTimeout(flushQueue, RETRY_MS);
          return;
        }
        state.queue.shift();
        save(STORE.queue, state.queue);
        if (res.ok) applyData(res.data);
        else toast('記録できませんでした: ' + res.error, true);
      }
    } finally {
      state.flushing = false;
      render();
    }
  }

  function enqueue(entry) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    state.queue.push({ id, entry });
    save(STORE.queue, state.queue);
    render();
    flushQueue();
  }

  // ---- セットアップ ----
  function parseSetup(text) {
    const m = String(text || '').match(/setup=([A-Za-z0-9_\-]+=*)/) || String(text || '').trim().match(/^([A-Za-z0-9_\-]{40,}=*)$/);
    if (!m) return null;
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = JSON.parse(atob(b64 + '==='.slice((b64.length + 3) % 4)));
      if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(json.a) || !json.k) return null;
      return { api: json.a, key: json.k };
    } catch (e) {
      return null;
    }
  }

  function showSetup(error) {
    $('app').hidden = true;
    $('setup').hidden = false;
    $('setup-error').textContent = error || '';
    const needLink = !state.config || !!error;
    $('setup-link-step').hidden = !needLink;
    $('setup-me-step').hidden = needLink;
    if (!needLink) renderMemberChoice($('setup-members'), (name) => {
      setMe(name);
      showApp();
    });
  }

  function renderMemberChoice(container, onPick) {
    const members = (state.data && state.data.members) || ['てん', 'あおい'];
    container.replaceChildren(...members.map((name) => el('button', {
      type: 'button', text: name, role: 'radio', 'aria-checked': String(name === state.me),
      onclick: () => onPick(name),
    })));
  }

  function setMe(name) {
    state.me = name;
    state.payer = name;
    save(STORE.me, name);
  }

  function useConfig(config) {
    state.config = config;
    save(STORE.config, config);
  }

  function showApp() {
    $('setup').hidden = true;
    $('app').hidden = false;
    render();
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
    const sheets = (state.data && state.data.sheets) || [];
    const current = state.data ? state.data.sheet : '';
    select.replaceChildren(...sheets.map((name) => el('option', { value: name, text: name, selected: name === current })));
    const i = sheets.indexOf(current);
    $('prev-month').disabled = i < 0 || i >= sheets.length - 1; // 右のシートほど古い
    $('next-month').disabled = i <= 0;
  }

  function renderSummary() {
    const s = state.data && state.data.summary;
    const people = (s && s.people) || [];
    const debtor = people.find((p) => p.diff > 0);
    const creditor = people.find((p) => p.diff < 0);
    if (!s || people.length < 2) {
      $('settle-label').textContent = '精算';
      $('settle-amount').textContent = '—';
    } else if (debtor && creditor) {
      $('settle-label').textContent = debtor.name + ' → ' + creditor.name;
      $('settle-amount').textContent = yen(debtor.diff);
    } else {
      $('settle-label').textContent = '精算';
      $('settle-amount').textContent = 'なし';
    }
    $('summary-total').textContent = s && s.total !== null && s.total !== undefined
      ? (state.data.sheet + ' の合計 ' + yen(s.total)) : '';
    $('people').replaceChildren(...people.map((p) => el('div', { class: 'person' }, [
      el('strong', { text: p.name }),
      el('span', { text: '支払 ' + yen(p.paid) }), el('br'),
      el('span', { text: '負担 ' + yen(p.share) }),
    ])));
  }

  function renderForm() {
    const members = (state.data && state.data.members) || ['てん', 'あおい'];
    if (!state.payer) state.payer = state.me || members[0];
    $('payer').replaceChildren(...members.map((name) => el('button', {
      type: 'button', role: 'radio', text: name + (name === state.me ? '（自分）' : ''),
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

    if (!$('date').value) $('date').value = todayIso();
  }

  function renderEntries() {
    const data = state.data;
    const entries = data ? data.entries.slice().reverse() : [];
    // 送信待ちのうち、表示中の月のものを先頭に出す
    const pending = state.queue
      .filter((q) => data && sheetNameOfDate(q.entry.date).includes(data.sheet))
      .map((q) => Object.assign({ pending: true, day: q.entry.date.split('-')[2].replace(/^0/, '') }, q.entry))
      .reverse();
    const rows = pending.concat(entries);
    $('list-title').textContent = data ? data.sheet + ' の記録' : '記録';
    $('list-count').textContent = rows.length ? rows.length + '件' : '';
    $('empty').hidden = rows.length > 0;
    $('entries').replaceChildren(...rows.map((e) => el('li', { class: 'entry-row' + (e.pending ? ' pending' : '') }, [
      el('span', { class: 'entry-day', text: e.day ? (/^\d+$/.test(e.day) ? e.day + '日' : e.day) : '' }),
      el('div', { class: 'entry-main' }, [
        el('div', { class: 'entry-comment', text: e.comment || e.category || '（メモなし）' }),
        el('div', { class: 'entry-meta' }, [
          el('span', { class: 'badge' + (e.payer === state.me ? ' me' : ''), text: e.payer }),
          e.category && e.comment ? el('span', { text: e.category }) : null,
          e.pending ? el('span', { class: 'badge pending', text: '送信待ち' }) : null,
        ]),
      ]),
      el('span', { class: 'entry-amount', text: (e.amount < 0 ? '−' : '') + yen(e.amount) }),
      e.pending ? el('span') : el('button', {
        class: 'delete-btn', type: 'button', 'aria-label': '削除', text: '×',
        onclick: () => removeEntry(e),
      }),
    ])));
  }

  function renderStatus() {
    $('refresh').classList.toggle('spinning', state.loading || state.flushing);
    const parts = [];
    if (state.queue.length) parts.push('送信待ち ' + state.queue.length + '件' + (navigator.onLine ? '' : '（オフライン）'));
    $('status-line').textContent = parts.join(' · ');
  }

  // ---- 操作 ----
  function onSubmit(ev) {
    ev.preventDefault();
    const amount = Number($('amount').value.replace(/[^\d]/g, ''));
    if (!amount) {
      toast('金額を入力してください', true);
      $('amount').focus();
      return;
    }
    const entry = {
      date: $('date').value || todayIso(),
      amount,
      payer: state.payer || state.me,
      category: state.category,
      comment: $('comment').value.trim(),
    };
    enqueue(entry);
    toast(entry.payer + ' ' + yen(amount) + ' を記録しました');
    // 次の入力に備えてリセット（払った人は自分に戻す）
    $('amount').value = '';
    $('comment').value = '';
    $('date').value = todayIso();
    state.category = '';
    state.payer = state.me;
    $('amount').blur();
    $('comment').blur();
    // 記録した月を表示していなければ切り替える
    const names = sheetNameOfDate(entry.date);
    if (state.data && !names.includes(state.data.sheet)) refresh(names[0]);
    render();
  }

  async function removeEntry(e) {
    if (!confirm(`${e.day ? e.day + '日 ' : ''}${e.payer} ${yen(e.amount)} ${e.comment || ''}\nこの記録を削除しますか？`)) return;
    state.loading = true;
    renderStatus();
    try {
      const res = await api({ action: 'delete', sheet: state.data.sheet, row: e.row, expect: { amount: e.amount, payer: e.payer } });
      if (res.data) applyData(res.data);
      if (res.ok) toast('削除しました');
      else toast(res.error, true);
    } catch (err) {
      if (!err.fatal) toast('通信できませんでした。もう一度お試しください', true);
    } finally {
      state.loading = false;
      renderStatus();
    }
  }

  function moveMonth(step) {
    const sheets = (state.data && state.data.sheets) || [];
    const i = sheets.indexOf(state.data && state.data.sheet);
    const next = sheets[i - step]; // 左のシートほど新しい
    if (next) refresh(next);
  }

  function formatAmountInput() {
    const input = $('amount');
    const digits = input.value.normalize('NFKC').replace(/[^\d]/g, '').replace(/^0+/, '').slice(0, 8);
    input.value = digits ? Number(digits).toLocaleString('ja-JP') : '';
  }

  // ---- 起動 ----
  function bind() {
    $('entry-form').addEventListener('submit', onSubmit);
    $('amount').addEventListener('input', formatAmountInput);
    $('refresh').addEventListener('click', () => { refresh(); flushQueue(); });
    $('prev-month').addEventListener('click', () => moveMonth(-1));
    $('next-month').addEventListener('click', () => moveMonth(1));
    $('month-select').addEventListener('change', (ev) => refresh(ev.target.value));
    $('open-settings').addEventListener('click', () => {
      $('settings-me').textContent = state.me || '';
      const pick = (name) => {
        setMe(name);
        $('settings-me').textContent = name;
        renderMemberChoice($('settings-members'), pick);
        render();
      };
      renderMemberChoice($('settings-members'), pick);
      $('settings').showModal();
    });
    $('reset-setup').addEventListener('click', () => {
      if (!confirm('このスマホの設定を消して、セットアップをやり直しますか？\n（スプレッドシートの記録は消えません）')) return;
      save(STORE.config, null);
      save(STORE.me, null);
      save(STORE.cache, null);
      state.config = null;
      state.me = null;
      state.data = null;
      $('settings').close();
      showSetup();
    });
    $('setup-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const config = parseSetup($('setup-input').value);
      if (!config) {
        $('setup-error').textContent = 'セットアップ用リンクを読み取れませんでした';
        return;
      }
      startWithConfig(config);
    });
    window.addEventListener('online', () => { flushQueue(); renderStatus(); });
    window.addEventListener('offline', renderStatus);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.config && state.me) { refresh(null); flushQueue(); }
    });
  }

  async function startWithConfig(config) {
    useConfig(config);
    $('setup-error').textContent = '';
    try {
      const res = await api({ action: 'load' });
      if (!res.ok) throw new Error(res.error);
      applyData(res.data);
    } catch (e) {
      if (!e.fatal) $('setup-error').textContent = '接続できませんでした: ' + e.message;
      return;
    }
    if (state.me && state.data.members.includes(state.me)) showApp();
    else showSetup();
  }

  function start() {
    bind();
    state.queue = load(STORE.queue, []);
    state.me = load(STORE.me, null);
    state.payer = state.me;
    state.data = load(STORE.cache, null);

    // セットアップ用リンク（…/#setup=xxxx）から開いたとき。
    // iPhone はホーム画面のアプリと Safari で保存領域が別なので、URL の #setup はあえて消さずに残す
    // （そのまま「ホーム画面に追加」すると、アプリ側でも自動で設定される）。
    const fromLink = parseSetup(location.hash);
    const saved = load(STORE.config, null);
    if (fromLink && (!saved || saved.key !== fromLink.key || saved.api !== fromLink.api)) {
      startWithConfig(fromLink);
      return;
    }
    state.config = saved;
    if (!state.config) return showSetup();
    if (!state.me) {
      showSetup();
      refresh(); // メンバー一覧を取得
      return;
    }
    showApp();
    refresh(null); // 開いたときは今月を表示
    flushQueue();
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  start();
})();
