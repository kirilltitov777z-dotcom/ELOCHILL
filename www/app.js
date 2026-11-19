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
  var fileObj = null;
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
    var navIds = ['screen-main', 'screen-submit', 'screen-lb'];
    var withNav = navIds.indexOf(id) >= 0;
    var nav = $('navbar');
    if (nav) {
      nav.hidden = !withNav;
      var items = nav.querySelectorAll('.nav-item');
      for (var k = 0; k < items.length; k++) {
        items[k].classList.toggle('active', items[k].getAttribute('data-nav') === id);
      }
    }
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
      user = { username: r.username, elo: r.elo, level: r.level, submissions_today: 0, total_submissions: 0 };
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

    $('mSubs').textContent = String(user.submissions_today || 0);
    $('mTotal').textContent = String(user.total_submissions || 0);
    $('btnSubmit').disabled = busy || !online;
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
        user.total_submissions = p.total_submissions || 0;
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

    busy = true;
    $('btnSend').disabled = true;
    await runCheck();
    busy = false;
    $('btnSend').disabled = false;
  }

  var STEPS = [
    '🤖 Запускаю OCR-движок...',
    '   Читаю текст с изображения...',
    '   Ищу счёт матча в кадре...',
    '   Ищу слово «победа/поражение»...',
    '   Сверяю прочитанное с исходом...'
  ];

  // Лёгкий ИИ-анализатор кадра: отпечаток + признаки изображения.
  // Решение принимается по признакам, а не по случайности.
  async function loadBitmap(file) {
    try { return await createImageBitmap(file); }
    catch (e) {
      return await new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error('Не удалось открыть изображение')); };
        img.src = URL.createObjectURL(file);
      });
    }
  }

  async function inspectFile(file) {
    var buf = await file.arrayBuffer();
    var digest = await crypto.subtle.digest('SHA-256', buf);
    var bytes = new Uint8Array(digest);
    var sha = '';
    for (var i = 0; i < bytes.length; i++) sha += ('0' + bytes[i].toString(16)).slice(-2);

    var bmp = await loadBitmap(file);
    var w = bmp.width || bmp.naturalWidth;
    var h = bmp.height || bmp.naturalHeight;

    // --- dHash: 9x8 grayscale, 64 бита ---
    var c1 = document.createElement('canvas');
    c1.width = 9; c1.height = 8;
    var x1 = c1.getContext('2d');
    x1.drawImage(bmp, 0, 0, 9, 8);
    var small = x1.getImageData(0, 0, 9, 8).data;
    var sg = [];
    for (var p = 0; p < 72; p++) {
      var q = p * 4;
      sg.push(Math.round(small[q] * 0.299 + small[q + 1] * 0.587 + small[q + 2] * 0.114));
    }
    var bits = '';
    for (var y = 0; y < 8; y++) {
      for (var x = 0; x < 8; x++) bits += (sg[y * 9 + x] > sg[y * 9 + x + 1]) ? '1' : '0';
    }
    var phash = '';
    for (var b = 0; b < 64; b += 4) phash += parseInt(bits.substr(b, 4), 2).toString(16);

    // --- признаки кадра: 96x96 ---
    var N = 96;
    var c2 = document.createElement('canvas');
    c2.width = N; c2.height = N;
    var x2 = c2.getContext('2d', { willReadFrequently: true });
    x2.drawImage(bmp, 0, 0, N, N);
    var d = x2.getImageData(0, 0, N, N).data;
    var g = new Float32Array(N * N);
    var palette = {};
    var sum = 0;
    for (var k = 0; k < N * N; k++) {
      var o = k * 4, r = d[o], gg = d[o + 1], bb = d[o + 2];
      g[k] = 0.299 * r + 0.587 * gg + 0.114 * bb;
      sum += g[k];
      palette[((r >> 3) << 10) | ((gg >> 3) << 5) | (bb >> 3)] = 1;
    }
    var colorCount = Object.keys(palette).length;
    var mean = sum / (N * N);
    var varSum = 0;
    for (var m = 0; m < g.length; m++) varSum += (g[m] - mean) * (g[m] - mean);
    var contrast = Math.sqrt(varSum / g.length);

    var edgeCount = 0, edgeTotal = 0;
    for (var yy = 1; yy < N - 1; yy++) {
      for (var xx = 1; xx < N - 1; xx++) {
        var idx = yy * N + xx;
        var mag = Math.abs(g[idx + 1] - g[idx - 1]) + Math.abs(g[idx + N] - g[idx - N]);
        edgeTotal++;
        if (mag > 60) edgeCount++;
      }
    }
    var edgeFrac = edgeCount / edgeTotal;

    // строки с текстом/интерфейсом в верхней части кадра
    var rowEnergy = [];
    for (var ry = 2; ry < 58; ry++) {
      var e = 0;
      for (var rx = 1; rx < N - 1; rx++) {
        var j = ry * N + rx;
        e += Math.abs(g[j + 1] - g[j - 1]) + Math.abs(g[j + N] - g[j - N]);
      }
      rowEnergy.push(e / (N - 2));
    }
    var avgE = 0;
    for (var a = 0; a < rowEnergy.length; a++) avgE += rowEnergy[a];
    avgE /= rowEnergy.length;
    var textRows = 0;
    for (var t = 0; t < rowEnergy.length; t++) {
      if (rowEnergy[t] > avgE * 1.8 && rowEnergy[t] > 18) textRows++;
    }

    var minSide = Math.min(w, h), maxSide = Math.max(w, h);
    var aiOk = minSide >= 400 && maxSide / minSide <= 2.3 &&
      colorCount >= 30 && edgeFrac >= 0.015 && textRows >= 2 && contrast >= 18;

    var score = Math.round(Math.min(100,
      (Math.min(colorCount, 140) / 140) * 18 +
      (Math.min(edgeFrac, 0.12) / 0.12) * 22 +
      (Math.min(textRows, 14) / 14) * 24 +
      (Math.min(contrast, 75) / 75) * 22 +
      (Math.min(minSide, 1080) / 1080) * 14));

    return {
      phash: phash,
      sha: sha,
      aiOk: aiOk,
      features: {
        w: w, h: h,
        colors: colorCount,
        edges: Number(edgeFrac.toFixed(4)),
        textRows: textRows,
        contrast: Math.round(contrast),
        score: score
      }
    };
  }

  // Настоящее чтение скриншота: Tesseract OCR ( rus + eng ), запущенный на устройстве.
  var ocrWorker = null;
  async function runOcr(file) {
    if (!window.Tesseract || !window.Tesseract.createWorker) throw new Error('OCR-движок не загружен');
    if (!ocrWorker) {
      ocrWorker = await window.Tesseract.createWorker('eng+rus', 1, {
        langPath: 'vendor/tesseract/lang',
        corePath: 'vendor/tesseract/core',
        workerPath: 'vendor/tesseract/worker.min.js',
        workerBlobURL: false,
        gzip: false,
        logger: function () {}
      });
    }
    var res = await ocrWorker.recognize(file);
    var text = ((res && res.data && res.data.text) || '').trim();
    var up = text.toUpperCase();
    var hasWin = /ПОБЕД|VICTOR|\bWIN\b|\bWON\b|УСПЕШ/.test(up);
    var hasLose = /ПОРАЖ|DEFEAT|\bLOSE\b|ПРОИГР|FAILED/.test(up);
    var hasScore = /(\d{1,2})\s*[:\-–]\s*(\d{1,2})/.test(text);
    var chars = text.replace(/\s+/g, '').length;
    var outcomeMatch = outcome === 'win' ? (hasWin && !hasLose) : (hasLose && !hasWin);
    return {
      ok: chars >= 8 && hasScore && (hasWin || hasLose) && outcomeMatch,
      chars: chars,
      hasScore: hasScore,
      hasResult: hasWin || hasLose,
      outcomeMatch: outcomeMatch,
      text: text.slice(0, 500)
    };
  }

  async function runCheck() {
    show('screen-check');
    var inspect;
    try {
      inspect = await inspectFile(fileObj);
    } catch (e) {
      showResult({ error: 'Не удалось прочитать скриншот' });
      return;
    }
    var ocr;
    try {
      ocr = await runOcr(fileObj);
    } catch (e) {
      ocr = { ok: false, chars: 0, hasScore: false, hasResult: false, outcomeMatch: false, text: '' };
    }
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
      r = await rpc('submit_result', {
        p_username: user.username,
        p_outcome: outcome,
        p_phash: inspect.phash,
        p_sha: inspect.sha,
        p_ai_ok: inspect.aiOk,
        p_features: inspect.features,
        p_ocr_ok: ocr.ok,
        p_ocr: {
          chars: ocr.chars,
          hasScore: ocr.hasScore,
          hasResult: ocr.hasResult,
          outcomeMatch: ocr.outcomeMatch
        }
      });
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
    if (r.error === 'duplicate') {
      showResult({
        title: 'Скриншот уже использован',
        icon: '⚠',
        text: r.reason || 'Этот кадр уже проходил проверку. Отпечаток совпал с существующим.',
        delta: 0,
        stats: 'Эло без изменений: ' + user.elo
      });
      return;
    }
    if (r.error === 'ai_reject') {
      showResult({
        title: 'ИИ не принял кадр',
        icon: '❌',
        text: r.reason || 'Не удалось распознать элементы интерфейса матча',
        delta: 0,
        stats: 'Оценка ИИ: ' + (r.score || 0) + '/100<br>Эло без изменений: ' + user.elo
      });
      return;
    }
    if (r.error === 'ocr_reject') {
      showResult({
        title: 'OCR не подтвердил матч',
        icon: '❌',
        text: r.reason || 'Не удалось прочитать счёт и исход на скриншоте',
        delta: 0,
        stats: 'Распознано символов: ' + (r.chars || 0) + '<br>Эло без изменений: ' + user.elo
      });
      return;
    }
    if (r.error) { showResult({ error: String(r.error) }); return; }

    user.elo = r.elo; user.level = r.level;
    user.submissions_today = r.submissions_today != null ? r.submissions_today : ((user.submissions_today || 0) + 1);
    user.total_submissions = r.total_submissions != null ? r.total_submissions : ((user.total_submissions || 0) + 1);
    save(LS_USER, user);

    if (r.accepted) {
      showResult({
        title: 'Подтверждено!',
        icon: '✅',
        text: 'ИИ распознал элементы матча и подтвердил результат',
        delta: r.delta || 0,
        stats: 'Оценка ИИ: ' + (r.score || 0) + '/100<br>Эло: ' + r.elo + ' · Уровень: ' + r.level + '<br>Проверок сегодня: ' + user.submissions_today + ' · Всего: ' + user.total_submissions
      });
    } else {
      showResult({
        title: 'Отклонено',
        icon: '❌',
        text: 'Причина: ' + (r.reason || 'Не удалось распознать данные на скриншоте'),
        delta: 0,
        stats: 'Эло без изменений: ' + r.elo + ' · Уровень: ' + r.level + '<br>Проверок сегодня: ' + user.submissions_today + ' · Всего: ' + user.total_submissions
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
    fileObj = f;
    $('fileName').dataset.name = f.name;
    $('fileName').textContent = f.name;
  });

  var radios = document.querySelectorAll('input[name="outcome"]');
  for (var j = 0; j < radios.length; j++) {
    radios[j].addEventListener('change', function () { outcome = this.value; });
  }

  $('btnSend').addEventListener('click', sendResult);

  // нижняя навигация
  var navItems = document.querySelectorAll('.nav-item');
  for (var n = 0; n < navItems.length; n++) {
    navItems[n].addEventListener('click', function () {
      var target = this.getAttribute('data-nav');
      if (target === 'screen-submit') openSubmit();
      else if (target === 'screen-lb') openLeaderboard();
      else show(target);
    });
  }

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
