(function () {
  'use strict';

  var URL = 'https://yfcwrdxeihsbggtmemcf.supabase.co';
  var KEY = 'sb_publishable_lwFAGdagCXMHaSpsL3Yqpg_jAhPshiQ';
  var LS_USER = 'elochill.user';
  var LS_LB = 'elochill.leaderboard';

  var LEVELS = [0, 200, 500, 900, 1400, 1800, 2100, 2300, 2500, 3000, 3800, 4700, 5700, 6800, 8000];

  var sb = null;
  try {
    if (window.supabase && window.supabase.createClient) {
      sb = window.supabase.createClient(URL, KEY, { auth: { persistSession: false } });
    }
  } catch (e) { sb = null; }

  var online = true; // проверяем реальным запросом, navigator.onLine во WebView unreliable
  var user = load(LS_USER, null);
  var outcome = 'win';
  var fileChosen = false;
  var busy = false;

  function $(id) { return document.getElementById(id); }
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function show(id) {
    var all = document.querySelectorAll('.screen');
    for (var i = 0; i < all.length; i++) all[i].classList.remove('active');
    $(id).classList.add('active');
    window.scrollTo(0, 0);
  }
  function fmtTime(s) {
    s = Math.max(0, Math.floor(s));
    var m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function setNet(v) {
    online = !!v;
    var el = $('net');
    el.className = 'net ' + (online ? 'online' : 'offline');
    el.querySelector('span').textContent = online ? 'Онлайн' : 'Офлайн';
    document.body.classList.toggle('is-offline', !online);
    if (user) updateMainStats();
  }
  window.addEventListener('online', function () { ping(); });
  window.addEventListener('offline', function () { setNet(false); });

  function isNetworkError(e) {
    var m = String((e && (e.message || e)) || e);
    return /failed to fetch|networkerror|network request failed|load failed|offline/i.test(m) || (e instanceof TypeError);
  }

  // Проверка соединения через health-endpoint Supabase (не зависит от SQL)
  async function ping() {
    try {
      var r = await fetch(URL + '/auth/v1/health', { cache: 'no-store', headers: { 'apikey': KEY } });
      setNet(r.ok || r.status === 401 || r.status === 404);
      return true;
    } catch (e) { setNet(false); return false; }
  }

  // ---------- API ----------
  async function rpc(name, args) {
    args = args || {};
    if (sb) {
      try {
        var res = await sb.rpc(name, args);
        if (res.error) throw res.error;
        setNet(true);
        return res.data;
      } catch (e) {
        if (isNetworkError(e)) { setNet(false); throw new Error('Нет соединения с сервером'); }
        // ошибка БД/функции — пробуем REST и показываем настоящий текст
      }
    }
    var r;
    try {
      r = await fetch(URL + '/rest/v1/rpc/' + name, {
        method: 'POST',
        headers: {
          'apikey': KEY,
          'Authorization': 'Bearer ' + KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(args)
      });
      setNet(true);
    } catch (e) {
      setNet(false);
      throw new Error('Нет соединения с сервером');
    }
    if (!r.ok) {
      var body = {};
      try { body = await r.json(); } catch (e) {}
      var err = new Error(body.message || body.details || ('HTTP ' + r.status));
      err.code = (body && body.code) || String(r.status);
      throw err;
    }
    return await r.json();
  }

  function prettyError(e) {
    var code = String((e && e.code) || '');
    var m = String((e && e.message) || e);
    if (/PGRST202|PGRST205|404|42P01|42883/.test(code + ' ' + m)) {
      return 'База не настроена: выполните supabase/schema.sql в Supabase SQL Editor';
    }
    if (/401|403|PGRST301/.test(code + ' ' + m)) return 'Ошибка доступа к Supabase';
    return m;
  }

  async function loadLeaderboard() {
    try {
      var rows;
      if (sb) {
        var q = await sb.from('leaderboard').select('username,elo,level').order('elo', { ascending: false }).limit(100);
        if (q.error) throw q.error;
        rows = q.data;
      } else {
        var r = await fetch(URL + '/rest/v1/leaderboard?select=username,elo,level&order=elo.desc&limit=100', {
          headers: { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY }
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        rows = await r.json();
      }
      save(LS_LB, rows);
      setNet(true);
      return { rows: rows, cached: false };
    } catch (e) {
      if (isNetworkError(e)) setNet(false);
      return { rows: load(LS_LB, []), cached: true };
    }
  }

  // ---------- Логин ----------
  async function doLogin() {
    if (busy) return;
    var nick = ($('nickInput').value || '').trim();
    var err = $('loginError');
    err.textContent = '';
    if (nick.length < 2 || nick.length > 24) { err.textContent = 'Ник: от 2 до 24 символов'; return; }

    busy = true;
    var btn = $('btnLogin');
    btn.disabled = true; btn.textContent = 'Вход...';
    try {
      var r = await rpc('get_or_create_user', { p_username: nick });
      if (!r || r.error) { err.textContent = (r && r.error) ? String(r.error) : 'Ошибка ответа сервера'; return; }
      user = { username: r.username, elo: r.elo, level: r.level, submissions_today: 0, cooldown_seconds: 0 };
      save(LS_USER, user);
      $('mAva').textContent = String(r.username).charAt(0).toUpperCase();
      renderMain();
      show('screen-main');
    } catch (e) {
      err.textContent = prettyError(e);
    } finally {
      busy = false; btn.disabled = false; btn.textContent = 'Войти';
    }
  }

  // ---------- Главное меню ----------
  function updateMainStats() {
    if (!user) return;
    $('mNick').textContent = user.username;
    $('mLevel').textContent = user.level || 1;
    $('mElo').textContent = user.elo || 0;

    var lvl = Math.min(15, Math.max(1, user.level || 1));
    var cur = LEVELS[lvl - 1], next = lvl < 15 ? LEVELS[lvl] : null;
    if (next) {
      $('mNext').textContent = next + ' Эло';
      var pct = ((user.elo - cur) / (next - cur)) * 100;
      $('mProgress').style.width = Math.max(0, Math.min(100, pct)) + '%';
    } else {
      $('mNext').textContent = 'макс. уровень';
      $('mProgress').style.width = '100%';
    }

    var subs = user.submissions_today || 0;
    var cd = user.cooldown_seconds || 0;
    $('mSubs').textContent = subs + ' / 10';
    $('mCooldown').textContent = cd > 0 ? fmtTime(cd) : 'доступно';
    $('btnSubmit').disabled = busy || !online || cd > 0 || subs >= 10;
  }

  async function renderMain() {
    if (!user) return;
    updateMainStats();
    if (!online) return;
    try {
      var p = await rpc('get_profile', { p_username: user.username });
      if (p && !p.error) {
        user.elo = p.elo; user.level = p.level;
        user.submissions_today = p.submissions_today || 0;
        user.cooldown_seconds = p.cooldown_seconds || 0;
        save(LS_USER, user);
        updateMainStats();
      }
    } catch (e) { /* офлайн — покажем кэш */ }
  }

  // ---------- Отправка ----------
  function openSubmit() {
    $('submitError').textContent = '';
    $('fileName').textContent = fileChosen ? $('fileName').dataset.name : 'Выбрать скриншот';
    show('screen-submit');
  }

  async function sendResult() {
    if (busy) return;
    var err = $('submitError');
    err.textContent = '';
    if (!fileChosen) { err.textContent = 'Выберите скриншот'; return; }
    if ((user.cooldown_seconds || 0) > 0) { err.textContent = 'Подождите ' + fmtTime(user.cooldown_seconds); return; }
    if ((user.submissions_today || 0) >= 10) { err.textContent = 'Дневной лимит исчерпан'; return; }

    busy = true;
    $('btnSend').disabled = true;
    await runCheck();
    busy = false;
    $('btnSend').disabled = false;
  }

  var STEPS = [
    '🤖 Проверяю скриншот...',
    '   Ищу счёт матча...',
    '   Ищу ник игрока...',
    '   Проверяю интерфейс...',
    '   Проверяю дату...'
  ];

  async function runCheck() {
    show('screen-check');
    var box = $('checkSteps');
    box.innerHTML = '';
    var prog = $('checkProgress');
    prog.style.width = '0%';
    var nodes = [];
    for (var i = 0; i < STEPS.length; i++) {
      (function (text, idx) {
        var d = document.createElement('div');
        d.className = 'step'; d.textContent = text;
        box.appendChild(d); nodes.push(d);
      })(STEPS[i], i);
      nodes[i].classList.add('show');
      prog.style.width = ((i + 1) / STEPS.length * 85) + '%';
      await delay(620);
      nodes[i].classList.remove('show');
      nodes[i].classList.add('done');
    }
    prog.style.width = '92%';

    var r;
    try {
      r = await rpc('submit_result', { p_username: user.username, p_outcome: outcome });
      setNet(true);
    } catch (e) {
      showResult({ error: prettyError(e) });
      prog.style.width = '100%';
      return;
    }
    prog.style.width = '100%';
    await delay(350);
    applyResult(r);
  }

  function applyResult(r) {
    if (!r) { showResult({ error: 'Пустой ответ сервера' }); return; }
    if (r.error === 'cooldown') {
      user.cooldown_seconds = r.cooldown_seconds || 0;
      save(LS_USER, user);
      showResult({ title: 'Слишком рано', icon: '⏳', text: 'Следующая проверка будет доступна через ' + fmtTime(user.cooldown_seconds), delta: 0 });
      return;
    }
    if (r.error === 'daily_limit') {
      user.submissions_today = 10;
      save(LS_USER, user);
      showResult({ title: 'Лимит исчерпан', icon: '⏳', text: 'Максимум 10 проверок в день. Лимит сбросится завтра.', delta: 0 });
      return;
    }
    if (r.error) { showResult({ error: String(r.error) }); return; }

    user.elo = r.elo; user.level = r.level;
    user.submissions_today = r.submissions_today != null ? r.submissions_today : ((user.submissions_today || 0) + 1);
    user.cooldown_seconds = 180;
    save(LS_USER, user);

    if (r.accepted) {
      showResult({
        title: 'Подтверждено!',
        icon: '✅',
        text: 'Результат прошёл автоматическую проверку',
        delta: r.delta || 0,
        stats: 'Эло: ' + r.elo + ' · Уровень: ' + r.level + '<br>Проверок сегодня: ' + user.submissions_today + ' / 10'
      });
    } else {
      showResult({
        title: 'Отклонено',
        icon: '❌',
        text: 'Причина: ' + (r.reason || 'Не удалось распознать данные на скриншоте'),
        delta: 0,
        stats: 'Эло без изменений: ' + r.elo + ' · Уровень: ' + r.level + '<br>Проверок сегодня: ' + user.submissions_today + ' / 10'
      });
    }
  }

  function showResult(o) {
    $('resultIcon').textContent = o.icon || (o.error ? '⚠' : '✅');
    $('resultTitle').textContent = o.title || 'Ошибка';
    $('resultText').textContent = o.text || o.error || '';
    var d = $('resultDelta');
    var v = o.delta || 0;
    d.textContent = v > 0 ? '+' + v + ' Эло' : (v < 0 ? v + ' Эло' : '');
    d.className = 'delta ' + (v > 0 ? 'plus' : (v < 0 ? 'minus' : 'zero'));
    $('resultStats').innerHTML = o.stats || '';
    show('screen-result');
  }

  // ---------- Таблица лидеров ----------
  async function openLeaderboard() {
    show('screen-lb');
    var list = $('lbList');
    list.innerHTML = '<div class="muted">Загрузка...</div>';
    $('lbBadge').style.display = 'none';
    var data = await loadLeaderboard();
    if (data.cached) $('lbBadge').style.display = 'inline-block';
    if (!data.rows || !data.rows.length) {
      list.innerHTML = '<div class="muted">Данных пока нет</div>';
      return;
    }
    list.innerHTML = '';
    for (var i = 0; i < data.rows.length; i++) {
      var row = data.rows[i];
      var div = document.createElement('div');
      div.className = 'lb-row' + (user && row.username === user.username ? ' me' : '');
      div.innerHTML =
        '<div class="lb-pos">' + (i + 1) + '</div>' +
        '<div class="lb-name">' + esc(row.username) + '</div>' +
        '<div class="lb-lvl">LVL ' + (row.level || 1) + '</div>' +
        '<div class="lb-elo">' + (row.elo || 0) + '</div>';
      list.appendChild(div);
    }
  }

  // ---------- События ----------
  $('btnLogin').addEventListener('click', doLogin);
  $('nickInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  $('btnSubmit').addEventListener('click', openSubmit);
  $('btnLeaderboard').addEventListener('click', openLeaderboard);
  $('btnResultMenu').addEventListener('click', function () { renderMain(); show('screen-main'); });
  $('btnLogout').addEventListener('click', function () {
    user = null; localStorage.removeItem(LS_USER);
    $('nickInput').value = ''; show('screen-login');
  });

  var backs = document.querySelectorAll('[data-back]');
  for (var i = 0; i < backs.length; i++) {
    backs[i].addEventListener('click', function () { show(this.getAttribute('data-back')); });
  }

  $('fileInput').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    fileChosen = true;
    $('fileName').dataset.name = f.name;
    $('fileName').textContent = f.name;
  });

  var radios = document.querySelectorAll('input[name="outcome"]');
  for (var j = 0; j < radios.length; j++) {
    radios[j].addEventListener('change', function () { outcome = this.value; });
  }

  $('btnSend').addEventListener('click', sendResult);

  // таймер кдаунта в меню
  setInterval(function () {
    if (user && (user.cooldown_seconds || 0) > 0) {
      user.cooldown_seconds = Math.max(0, user.cooldown_seconds - 1);
      updateMainStats();
    }
  }, 1000);

  // ---------- Старт ----------
  ping();
  if (user) {
    $('mAva').textContent = String(user.username || 'E').charAt(0).toUpperCase();
    renderMain();
    show('screen-main');
  } else {
    show('screen-login');
  }
})();
