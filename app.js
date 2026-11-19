/* =====================================================
   HOÀNG BLUEWING – app.js
   Mục lục:
     0. Cấu hình và nạp dữ liệu đề
     1. Hàm tiện ích, lưu trữ cục bộ
     2. Gộp dữ liệu (khách / tài khoản / đám mây)
     3. Toast, hộp thoại, bộ đếm thời gian học
     4. Đăng nhập Google và đồng bộ Firestore
     5. Điều hướng
     6. Bảng điều khiển
     7. Trang đề
     8. Làm bài
     9. Kết quả
    10. Tài khoản, mục tiêu
    11. Phân tích bằng AI
    12. Vòng đời trang và khởi động
   ===================================================== */
(function () {
  'use strict';

  /* =====================================================
     0. CẤU HÌNH VÀ NẠP DỮ LIỆU ĐỀ
     ===================================================== */
  var MAX_PAUSES = 3;               // số lần tạm dừng tối đa cho mỗi đề
  var MAX_POINTS = 1200;            // thang điểm ĐGNL ĐHQG-HCM
  var COUNT_AWAY_TIME = true;       // true: thoát trang mà chưa bấm "Tạm dừng" thì đồng hồ vẫn chạy
  var LOCAL_SAVE_EVERY = 15;        // lưu bài đang làm vào trình duyệt mỗi N giây
  var CLOUD_TIME_SYNC_MS = 5 * 60 * 1000; // đẩy thời gian học lên đám mây mỗi 5 phút
  var HISTORY_LIMIT = 100;          // số lần làm bài tối đa giữ trong hồ sơ
  var AI_MAX_WRONG = 80;            // số câu sai tối đa gửi cho AI
  var AI_REGION = 'asia-southeast1';
  var LETTERS = ['A', 'B', 'C', 'D'];
  var LEVELS = ['Nhận biết', 'Thông hiểu', 'Vận dụng', 'Vận dụng cao'];

  var KEY_ATTEMPT = 'hp_attempt';
  var KEY_RESULT = 'hp_result';
  var KEY_HISTORY = 'hp_history';
  var KEY_GOAL = 'hp_goal';
  var KEY_NAME = 'hp_displayname';
  var KEY_DAILY_TIME = 'hp_daily_time';
  // Lưu chế độ giao diện riêng trên thiết bị
var THEME_STORAGE_KEY = 'bw_theme_preference';
var themePreference = 'light';
var themeMediaQuery = null;

  var RAW_EXAMS = window.HB_EXAMS || (window.HB_EXAM ? { '1': window.HB_EXAM } : {});
  var EXAMS = {};
  Object.keys(RAW_EXAMS).forEach(function (id) {
    var e = RAW_EXAMS[id];
    if (e && e.parts && e.groups) EXAMS[id] = e;
  });
  var EXAM_IDS = Object.keys(EXAMS).sort(function (a, b) { return Number(a) - Number(b); });

  if (EXAM_IDS.length === 0) {
    console.error('BlueWing: không tìm thấy dữ liệu đề thi (data/de-01.js).');
    showFatal('Không tải được dữ liệu đề thi. Hãy kiểm tra file data/de-01.js đã nằm đúng thư mục và được nạp trước app.js.');
    return;
  }

  var curExam = EXAM_IDS[0];
  var EXAM = EXAMS[curExam];
  var QMAP = {};

  function setExam(id) {
    if (!EXAMS[id]) id = EXAM_IDS[0];
    curExam = id;
    EXAM = EXAMS[id];
    QMAP = {};
    EXAM.groups.forEach(function (g) {
      g.questions.forEach(function (q) { QMAP[q.n] = { g: g, q: q }; });
    });
  }
  setExam(curExam);

  // Đề số 1 dùng khóa gốc, các đề khác thêm hậu tố _eN (giữ nguyên để không mất dữ liệu cũ)
  function xk(k, id) { id = id || curExam; return id === '1' ? k : k + '_e' + id; }

  var activeUser = null;
  var firebaseAuth = null;
  var firestore = null;
  var cloudReadyForUid = null;
  var cloudWriteTimer = null;
  var toastTimer = null;
  var lastSyncToast = 0;
  var authSeq = 0;
  var authPending = false;
  var authPendingTimer = null;
  var goalPrompted = false;
  var pendingToast = '';

  function showFatal(msg) {
    var d = document.createElement('div');
    d.setAttribute('role', 'alert');
    d.style.cssText = 'margin:24px auto;max-width:640px;padding:16px 20px;border:1px solid #C8372D;border-radius:8px;background:#FDEDEB;color:#8C1D12;font:16px/1.6 system-ui,sans-serif';
    d.textContent = msg;
    document.body.insertBefore(d, document.body.firstChild);
  }

  /* =====================================================
     1. HÀM TIỆN ÍCH, LƯU TRỮ CỤC BỘ
     ===================================================== */
  function $(id) { return document.getElementById(id); }
  function num(v, d) { v = Number(v); return isFinite(v) ? v : (d || 0); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function asArray(v) { return Array.isArray(v) ? v : []; }
  function mmss(sec) {
    sec = Math.max(0, Math.floor(num(sec)));
    return pad2(Math.floor(sec / 60)) + ':' + pad2(sec % 60);
  }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  // Chấp nhận cả định dạng cũ "2026-11-7" và định dạng mới "2026-11-07"
  function normDate(s) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s || ''));
    return m ? m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]) : '';
  }
  function typeset(el) {
    if (el && window.renderMathInElement) {
      window.renderMathInElement(el, {
        delimiters: [{ left: '\\(', right: '\\)', display: false }, { left: '\\[', right: '\\]', display: true }],
        throwOnError: false
      });
    }
  }
  function isScreen(name) {
    var el = $('screen-' + name);
    return !!(el && el.classList.contains('active'));
  }

/* =====================================================
   THEME – QUẢN LÝ GIAO DIỆN SÁNG / TỐI
   ===================================================== */

// Lấy lựa chọn đã lưu trên thiết bị
function readThemePreference() {
  try {
    var saved = localStorage.getItem(THEME_STORAGE_KEY);

    if (['light', 'dark', 'system'].indexOf(saved) !== -1) {
      return saved;
    }
  } catch (e) {
    console.warn('BlueWing: không đọc được cài đặt giao diện.', e);
  }

  // Giữ giao diện sáng làm mặc định
  return 'light';
}

// Kiểm tra chế độ màu của thiết bị
function systemPrefersDark() {
  return !!(
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

// Xác định giao diện thực tế
function resolveTheme(preference) {
  if (preference === 'system') {
    return systemPrefersDark() ? 'dark' : 'light';
  }

  return preference;
}

// Cập nhật trạng thái các nút lựa chọn
function updateThemeControls(preference, actualTheme) {
  document.querySelectorAll('[data-theme-choice]').forEach(function (btn) {
    var selected = btn.getAttribute('data-theme-choice') === preference;

    btn.classList.toggle('is-selected', selected);
    btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });

  var status = $('themeSettingsStatus');

  if (!status) return;

  if (preference === 'system') {
    status.textContent = actualTheme === 'dark'
      ? 'Đang theo thiết bị: giao diện tối.'
      : 'Đang theo thiết bị: giao diện sáng.';
  } else if (preference === 'dark') {
    status.textContent = 'Đang sử dụng giao diện tối.';
  } else {
    status.textContent = 'Đang sử dụng giao diện sáng.';
  }
}

// Áp dụng giao diện
function applyThemePreference(preference) {
  if (['light', 'dark', 'system'].indexOf(preference) === -1) {
    preference = 'light';
  }

  themePreference = preference;

  var actualTheme = resolveTheme(preference);
  var root = document.documentElement;

  // Gắn chế độ màu vào thẻ HTML
  root.setAttribute('data-theme', actualTheme);
  root.setAttribute('data-theme-preference', preference);

  // Đồng bộ màu của các thành phần trình duyệt
  root.style.colorScheme = actualTheme;

  // Cập nhật màu thanh trình duyệt trên điện thoại
  var themeMeta = document.querySelector('meta[name="theme-color"]');

  if (themeMeta) {
    themeMeta.setAttribute(
      'content',
      actualTheme === 'dark' ? '#181416' : '#B92525'
    );
  }

  // Đồng bộ các lựa chọn trong trang Cài đặt
  updateThemeControls(preference, actualTheme);

  return actualTheme;
}

// Lưu và thay đổi chế độ giao diện
function setThemePreference(preference) {
  if (['light', 'dark', 'system'].indexOf(preference) === -1) {
    return;
  }

  themePreference = preference;

  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch (e) {
    console.warn('BlueWing: không lưu được cài đặt giao diện.', e);
  }

  applyThemePreference(preference);
}

// Khởi tạo toàn bộ chức năng giao diện
function initThemeSettings() {
  // Khôi phục lựa chọn trước đó
  themePreference = readThemePreference();
  applyThemePreference(themePreference);

  // Bắt sự kiện khi người dùng chọn giao diện
  document.querySelectorAll('[data-theme-choice]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var preference = btn.getAttribute('data-theme-choice');
      setThemePreference(preference);
    });
  });

  // Theo dõi thay đổi chế độ sáng/tối của thiết bị
  if (window.matchMedia) {
    themeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    var handleSystemThemeChange = function () {
      if (themePreference === 'system') {
        applyThemePreference('system');
      }
    };

    // Trình duyệt hiện đại
    if (themeMediaQuery.addEventListener) {
      themeMediaQuery.addEventListener(
        'change',
        handleSystemThemeChange
      );
    } else if (themeMediaQuery.addListener) {
      // Hỗ trợ trình duyệt cũ
      themeMediaQuery.addListener(handleSystemThemeChange);
    }
  }

  // Đồng bộ nếu người dùng thay đổi giao diện ở tab khác
  window.addEventListener('storage', function (event) {
    if (event.key === THEME_STORAGE_KEY) {
      themePreference = readThemePreference();
      applyThemePreference(themePreference);
    }
  });
}

  function partSize(p) { return p.to - p.from + 1; }
  function levelOf(q) {
    if (LEVELS.indexOf(q.level) !== -1) return q.level;
    var d = Number(q.difficulty);
    return d >= 1 && d <= 4 ? LEVELS[d - 1] : LEVELS[1];
  }
  function pointsFrom(correct, total) { return Math.round(MAX_POINTS * num(correct) / (total || 120)); }

  function scopedKey(k, uid) {
    uid = uid === undefined ? (activeUser && activeUser.uid) : uid;
    return uid ? k + '__' + uid : k;
  }
  function readKey(fullKey) {
    try { return JSON.parse(localStorage.getItem(fullKey)); } catch (e) { return null; }
  }
  function writeKey(fullKey, value) {
    try {
      if (value === null || value === undefined) localStorage.removeItem(fullKey);
      else localStorage.setItem(fullKey, JSON.stringify(value));
    } catch (e) { /* hết dung lượng hoặc bị chặn lưu trữ: bỏ qua */ }
  }
  function load(k) { return readKey(scopedKey(k)); }
  // opts.localOnly: chỉ lưu trong trình duyệt, chưa đẩy lên đám mây (dùng cho bài đang làm để đỡ tốn lượt ghi)
  function save(k, v, opts) {
    writeKey(scopedKey(k), v);
    if (!(opts && opts.localOnly)) scheduleCloudSync();
  }
  function drop(k, opts) { save(k, null, opts); }
  function readHistory() {
    return asArray(load(KEY_HISTORY)).filter(function (x) { return x && typeof x === 'object'; });
  }

  /* ---------- Chấm điểm ---------- */
  function gradeExam(ex, answers) {
    var out = { correct: 0, parts: {} };
    ex.parts.forEach(function (p) { out.parts[p.key] = 0; });
    ex.groups.forEach(function (g) {
      g.questions.forEach(function (q) {
        if (answers[q.n] === q.answer) {
          out.correct++;
          out.parts[g.part] = (out.parts[g.part] || 0) + 1;
        }
      });
    });
    return out;
  }
  // Chỉ giữ đáp án hợp lệ (câu có thật, lựa chọn 0 đến 3), tránh dữ liệu hỏng làm vỡ giao diện
  function cleanAnswers(a, ex) {
    var out = {};
    if (!a || typeof a !== 'object') return out;
    ex = ex || EXAM;
    Object.keys(a).forEach(function (k) {
      var n = +k, v = a[k];
      if (n >= 1 && n <= ex.total && v === Math.floor(v) && v >= 0 && v <= 3) out[n] = v;
    });
    return out;
  }
  function cleanFlags(f, ex) {
    var out = {};
    if (!f || typeof f !== 'object') return out;
    ex = ex || EXAM;
    Object.keys(f).forEach(function (k) { var n = +k; if (f[k] && n >= 1 && n <= ex.total) out[n] = true; });
    return out;
  }

  /* =====================================================
     2. GỘP DỮ LIỆU (khách / tài khoản / đám mây)
     Một "shape" là toàn bộ dữ liệu học tập của một người:
     { history, result, attempt, goal, name, dailyTime, extra:{ [mãĐề]: {result, attempt} } }
     ===================================================== */
  function emptyShape() {
    var extra = {};
    EXAM_IDS.forEach(function (id) { if (id !== '1') extra[id] = { result: null, attempt: null }; });
    return { history: [], result: null, attempt: null, goal: null, name: null, dailyTime: null, extra: extra };
  }
  function readShape(keyFn) {
    function r(k) { return readKey(keyFn(k)); }
    var s = emptyShape();
    s.history = asArray(r(KEY_HISTORY));
    s.result = r(KEY_RESULT);
    s.attempt = r(KEY_ATTEMPT);
    s.goal = r(KEY_GOAL);
    s.name = r(KEY_NAME);
    s.dailyTime = r(KEY_DAILY_TIME);
    EXAM_IDS.forEach(function (id) {
      if (id === '1') return;
      s.extra[id] = { result: r(xk(KEY_RESULT, id)), attempt: r(xk(KEY_ATTEMPT, id)) };
    });
    return s;
  }
  function guestShape() { return readShape(function (k) { return k; }); }
  function scopedShape(uid) { return readShape(function (k) { return k + '__' + uid; }); }
  function cloudShape(d) {
    d = d || {};
    var s = emptyShape(), ex = d.extra || {};
    s.history = asArray(d.history);
    s.result = d.result || null;
    s.attempt = d.attempt || null;
    s.goal = d.goal || null;
    s.name = d.displayNameCustom || null;
    s.dailyTime = d.dailyTime || null;
    EXAM_IDS.forEach(function (id) {
      if (id === '1') return;
      var e = ex[id] || {};
      s.extra[id] = { result: e.result || null, attempt: e.attempt || null };
    });
    return s;
  }
  function writeShape(s, uid) {
    function w(k, v) { writeKey(k + '__' + uid, v); }
    w(KEY_HISTORY, s.history || []);
    w(KEY_RESULT, s.result || null);
    w(KEY_ATTEMPT, s.attempt || null);
    w(KEY_GOAL, s.goal || null);
    w(KEY_NAME, s.name || null);
    w(KEY_DAILY_TIME, s.dailyTime || null);
    EXAM_IDS.forEach(function (id) {
      if (id === '1') return;
      var e = (s.extra && s.extra[id]) || {};
      w(xk(KEY_RESULT, id), e.result || null);
      w(xk(KEY_ATTEMPT, id), e.attempt || null);
    });
  }
  function shapeHasData(s) {
    if (!s) return false;
    if (s.history.length || s.result || s.attempt || s.goal || s.name) return true;
    return EXAM_IDS.some(function (id) { var e = s.extra[id]; return e && (e.result || e.attempt); });
  }
  function clearGuestData() {
    [KEY_HISTORY, KEY_RESULT, KEY_ATTEMPT, KEY_GOAL, KEY_NAME, KEY_DAILY_TIME].forEach(function (k) { writeKey(k, null); });
    EXAM_IDS.forEach(function (id) {
      if (id === '1') return;
      writeKey(xk(KEY_RESULT, id), null);
      writeKey(xk(KEY_ATTEMPT, id), null);
    });
  }
  function newer(a, b, field) {
    if (!a) return b || null;
    if (!b) return a;
    return num(b[field]) > num(a[field]) ? b : a;
  }
  function mergeHistory(a, b) {
    var seen = {}, out = [];
    asArray(a).concat(asArray(b)).forEach(function (x) {
      if (!x || typeof x !== 'object') return;
      var key = (x.exam || '1') + '|' + num(x.at);
      if (seen[key]) return;
      seen[key] = 1;
      out.push(x);
    });
    out.sort(function (p, q) { return num(p.at) - num(q.at); });
    return out.slice(-HISTORY_LIMIT);
  }
  function mergeDaily(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    var da = normDate(a.date), db = normDate(b.date);
    if (da === db) return { date: a.date, seconds: Math.max(num(a.seconds), num(b.seconds)) };
    return db > da ? b : a;
  }
  // Bài đã nộp sau thời điểm lưu bài dở thì bài dở đã cũ, bỏ đi
  function reconcile(result, attempt) {
    if (result && attempt && num(result.at) >= num(attempt.savedAt)) attempt = null;
    return { result: result, attempt: attempt };
  }
  // a thắng khi hai bên bằng nhau (a = nguồn đáng tin hơn)
  function mergeShapes(a, b) {
    var out = emptyShape();
    out.history = mergeHistory(a.history, b.history);
    var base = reconcile(newer(a.result, b.result, 'at'), newer(a.attempt, b.attempt, 'savedAt'));
    out.result = base.result;
    out.attempt = base.attempt;
    out.goal = newer(a.goal, b.goal, 'updatedAt');
    out.name = a.name || b.name || null;
    out.dailyTime = mergeDaily(a.dailyTime, b.dailyTime);
    EXAM_IDS.forEach(function (id) {
      if (id === '1') return;
      var ea = a.extra[id] || {}, eb = b.extra[id] || {};
      var r = reconcile(newer(ea.result, eb.result, 'at'), newer(ea.attempt, eb.attempt, 'savedAt'));
      out.extra[id] = { result: r.result, attempt: r.attempt };
    });
    return out;
  }

  /* =====================================================
     3. TOAST, HỘP THOẠI, BỘ ĐẾM THỜI GIAN HỌC
     ===================================================== */
  function showToast(message) {
    var el = $('bwToast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 4200);
  }

  var lastFocus = null;
  var MODAL_IDS = ['authModal', 'accountModal', 'goalModal'];
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

  function openModal(id) {
    var el = $(id);
    if (!el) return;
    lastFocus = document.activeElement;
    el.hidden = false;
    var first = el.querySelector('.google-login-btn:not(:disabled), input, .account-action, .bw-modal-close');
    if (first && first.focus) first.focus();
  }
  function closeModal(id) {
    var el = $(id);
    if (!el || el.hidden) return;
    el.hidden = true;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    lastFocus = null;
  }
  function setAuthStatus(msg) { var el = $('authStatus'); if (el) el.textContent = msg || ''; }
  function openModalElement() {
    var ids = MODAL_IDS.concat(['pauseModal']);
    for (var i = 0; i < ids.length; i++) { var el = $(ids[i]); if (el && !el.hidden) return el; }
    return null;
  }
  // Esc đóng hộp thoại, Tab xoay vòng trong hộp thoại
  document.addEventListener('keydown', function (e) {
    var modal = openModalElement();
    if (!modal) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (modal.id === 'pauseModal') closePause(); else closeModal(modal.id);
      return;
    }
    if (e.key !== 'Tab') return;
    var items = Array.prototype.filter.call(modal.querySelectorAll(FOCUSABLE), function (n) { return n.offsetParent !== null || n === document.activeElement; });
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  /* ---------- Bộ đếm thời gian học ---------- */
  var timeTrackerId = null;
  var lastTickTime = Date.now();
  var lastCloudTimeSync = Date.now(); // lần đầu đẩy thời gian học sau CLOUD_TIME_SYNC_MS, không đẩy ngay khi mở trang

  function loadDaily() {
    var d = load(KEY_DAILY_TIME), today = todayStr();
    if (d && normDate(d.date) === today) return { date: today, seconds: Math.max(0, num(d.seconds)) };
    return { date: today, seconds: 0 };
  }
  function renderStudyMinutes(data) {
    var el = $('dbTime');
    if (el && isScreen('dashboard')) el.innerHTML = Math.floor(data.seconds / 60) + '<span class="d18"> phút</span>';
  }
  function trackTime() {
    var now = Date.now();
    // Giới hạn 10 giây mỗi lần để máy ngủ hoặc tab treo không làm phình số phút
    var diff = Math.min(Math.floor((now - lastTickTime) / 1000), 10);
    if (diff <= 0) return;
    lastTickTime = now;
    var data = loadDaily();
    data.seconds += diff;
    writeKey(scopedKey(KEY_DAILY_TIME), data);
    if (now - lastCloudTimeSync >= CLOUD_TIME_SYNC_MS) {
      lastCloudTimeSync = now;
      scheduleCloudSync();
    }
    renderStudyMinutes(data);
  }
  function startTimeTracker() {
    lastTickTime = Date.now();
    if (!timeTrackerId) timeTrackerId = setInterval(trackTime, 1000);
  }
  function stopTimeTracker() {
    if (timeTrackerId) {
      clearInterval(timeTrackerId);
      timeTrackerId = null;
      trackTime();
    }
  }

  /* =====================================================
     4. ĐĂNG NHẬP GOOGLE VÀ ĐỒNG BỘ FIRESTORE
     ===================================================== */
  function isInAppBrowser() {
    return /FBAN|FBAV|FB_IAB|Instagram|Zalo|Line\/|MicroMessenger|; wv\)/i.test(navigator.userAgent || '');
  }
  function firebaseConfigIsReady() {
    var c = window.BLUEWING_FIREBASE_CONFIG;
    if (!window.firebase || !c) return false;
    return ['apiKey', 'authDomain', 'projectId', 'appId'].every(function (key) {
      return typeof c[key] === 'string' && c[key].trim() && c[key].indexOf('YOUR_') !== 0;
    });
  }
  function authErrorMessage(err) {
    switch (err && err.code) {
      case 'auth/popup-closed-by-user': return 'Bạn đã đóng cửa sổ đăng nhập.';
      case 'auth/cancelled-popup-request': return '';
      case 'auth/unauthorized-domain': return 'Tên miền này chưa được thêm vào Firebase (Authentication, Settings, Authorized domains).';
      case 'auth/operation-not-allowed': return 'Chưa bật đăng nhập Google trong Firebase Authentication.';
      case 'auth/network-request-failed': return 'Mất kết nối mạng. Hãy kiểm tra Internet rồi thử lại.';
      case 'auth/too-many-requests': return 'Thử quá nhiều lần. Vui lòng đợi một lát rồi thử lại.';
      default: return 'Đăng nhập chưa thành công. Vui lòng thử lại.';
    }
  }

  function updateAuthUI() {
    document.querySelectorAll('[data-auth-trigger]').forEach(function (btn) {
      btn.replaceChildren();
      btn.classList.toggle('is-signed-in', !!activeUser);
      if (activeUser && activeUser.photoURL) {
        var avatar = document.createElement('img');
        avatar.src = activeUser.photoURL;
        avatar.alt = 'Ảnh đại diện';
        avatar.className = 'auth-avatar';
        avatar.referrerPolicy = 'no-referrer';
        btn.appendChild(avatar);
        btn.setAttribute('aria-label', 'Mở tài khoản ' + (activeUser.displayName || ''));
        btn.title = activeUser.displayName || 'Tài khoản';
      } else {
        btn.textContent = activeUser ? 'Tài khoản' : 'Đăng nhập';
        btn.setAttribute('aria-label', activeUser ? 'Mở tài khoản' : 'Đăng nhập bằng Google');
        btn.removeAttribute('title');
      }
    });
    var custom = load(KEY_NAME);
    var name = (custom && String(custom).trim())
      ? String(custom).trim()
      : (activeUser && activeUser.displayName ? activeUser.displayName.split(' ').pop() : 'bạn');
    if ($('dbUserName')) $('dbUserName').textContent = name;
    if ($('accountTitle') && activeUser) {
  var customName = load(KEY_NAME);
  $('accountTitle').textContent =
    (customName && String(customName).trim())
      ? String(customName).trim()
      : (activeUser.displayName || 'Tài khoản BlueWing');
}
  }

  function openAuthOrAccount() {
    if (activeUser) {
      var avatar = $('accountAvatar');
      if (avatar) {
        if (activeUser.photoURL) { avatar.src = activeUser.photoURL; avatar.referrerPolicy = 'no-referrer'; avatar.hidden = false; }
        else { avatar.removeAttribute('src'); avatar.hidden = true; }
      }
      if ($('accountTitle')) {
  var customName = load(KEY_NAME);
  $('accountTitle').textContent =
    (customName && String(customName).trim())
      ? String(customName).trim()
      : (activeUser.displayName || 'Tài khoản BlueWing');
}
      if ($('accountEmail')) $('accountEmail').textContent = activeUser.email || '';
      openModal('accountModal');
    } else {
      setAuthStatus('');
      openModal('authModal');
    }
  }

  function openGoalModal() {
    if (!activeUser) { openAuthOrAccount(); return; }
    var goal = load(KEY_GOAL) || {};
    // Mục tiêu cũ tính theo số câu (tối đa 120): đổi sang thang 1200
    if (goal.score && goal.unit !== 'points1200' && Number(goal.score) <= EXAM.total) {
      goal.score = Math.round(Number(goal.score) * MAX_POINTS / EXAM.total);
      goal.unit = 'points1200';
      goal.updatedAt = Date.now();
      save(KEY_GOAL, goal);
    }
    if ($('goalTitle')) $('goalTitle').textContent = goal.score ? 'Chỉnh sửa mục tiêu' : 'Đặt mục tiêu đầu tiên';
    if ($('goalScore')) { $('goalScore').value = goal.score || 900; $('goalScore').max = MAX_POINTS; }
    if ($('goalDeadline')) $('goalDeadline').value = goal.deadline || '';
    if ($('goalProgressHelp')) $('goalProgressHelp').textContent = goal.score
      ? 'Mục tiêu hiện tại: ' + goal.score + '/' + MAX_POINTS + ' điểm.'
      : 'Tiến độ được tính dựa trên kết quả tốt nhất của bạn.';
    openModal('goalModal');
  }

  /* ---------- Đồng bộ đám mây ---------- */
  function cloudExtra() {
    var out = {};
    EXAM_IDS.forEach(function (id) {
      if (id === '1') return;
      out[id] = { result: load(xk(KEY_RESULT, id)) || null, attempt: load(xk(KEY_ATTEMPT, id)) || null };
    });
    return out;
  }
  function cloudSnapshot() {
    return {
      displayName: (activeUser && activeUser.displayName) || '',
      email: (activeUser && activeUser.email) || '',
      photoURL: (activeUser && activeUser.photoURL) || '',
      displayNameCustom: load(KEY_NAME) || null,
      dailyTime: load(KEY_DAILY_TIME) || null,
      history: readHistory().slice(-HISTORY_LIMIT),
      result: load(xk(KEY_RESULT, '1')) || null,
      attempt: load(xk(KEY_ATTEMPT, '1')) || null,
      extra: cloudExtra(),
      goal: load(KEY_GOAL) || null,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
  }
  function cloudIsReady() { return !!(activeUser && firestore && cloudReadyForUid === activeUser.uid); }
  function scheduleCloudSync() {
    if (!cloudIsReady()) return;
    clearTimeout(cloudWriteTimer);
    cloudWriteTimer = setTimeout(persistCloudNow, 700);
  }
  async function persistCloudNow() {
    if (!cloudIsReady()) return;
    try {
      await firestore.collection('users').doc(activeUser.uid).set(cloudSnapshot(), { merge: true });
    } catch (err) {
      console.warn('BlueWing cloud sync failed:', err);
      var now = Date.now();
      if (now - lastSyncToast > 60000) { lastSyncToast = now; showToast('Chưa đồng bộ được dữ liệu. Dữ liệu vẫn được lưu trên thiết bị này.'); }
    }
  }

  // Đọc hồ sơ đám mây rồi gộp với dữ liệu trên máy (và dữ liệu khách nếu có)
  async function loadProfile(user, guest, seq, tries) {
    var local = scopedShape(user.uid);
    var merged = local, readOk = true;
    try {
      var doc = await firestore.collection('users').doc(user.uid).get();
      if (seq !== authSeq) return;
      if (doc.exists) merged = mergeShapes(cloudShape(doc.data()), local);
    } catch (err) {
      readOk = false;
      console.error('BlueWing profile load failed:', err);
    }
    if (seq !== authSeq) return;

    var hasGuest = guest && shapeHasData(guest);
    if (hasGuest) merged = mergeShapes(merged, guest);
    writeShape(merged, user.uid);
    if (hasGuest) clearGuestData();

    if (!readOk) {
      // Không đọc được đám mây thì chưa bật đồng bộ, tránh ghi đè dữ liệu cũ trên đám mây
      showToast('Đăng nhập thành công, nhưng chưa đọc được dữ liệu đám mây. Dữ liệu vẫn được lưu trên thiết bị.');
      if (tries < 3) {
        setTimeout(function () {
          if (seq === authSeq && activeUser && activeUser.uid === user.uid && cloudReadyForUid !== user.uid) loadProfile(user, null, seq, tries + 1);
        }, 30000);
      }
      rerenderActive();
      finishAuthPending();
      return;
    }

    cloudReadyForUid = user.uid;
    await persistCloudNow();
    rerenderActive();
    finishAuthPending();
    if (!load(KEY_GOAL) && !goalPrompted) { goalPrompted = true; openGoalModal(); }
    else showToast('Đã đăng nhập và đồng bộ dữ liệu BlueWing.');
  }

  async function handleAuthState(user) {
    var seq = ++authSeq;
    if (!user) {
      activeUser = null;
      cloudReadyForUid = null;
      updateAuthUI();
      rerenderActive();
      finishAuthPending();
      return;
    }
    if (activeUser && activeUser.uid === user.uid) {
      activeUser = user;
      updateAuthUI();
      finishAuthPending();
      return;
    }
    var guest = activeUser ? null : guestShape();
    activeUser = user;
    cloudReadyForUid = null;
    updateAuthUI();
    try {
      await loadProfile(user, guest, seq, 0);
    } finally {
      finishAuthPending();
    }
  }

  // Chặn vào trang làm bài cho tới khi biết đã đăng nhập hay chưa (tránh ghi đè bài đang làm của tài khoản khi tải lại trang)
  function finishAuthPending() {
    if (!authPending) return;
    authPending = false;
    clearTimeout(authPendingTimer);
    if (parseHash().name === 'test') route();
  }

  function initFirebase() {
    var googleBtn = $('googleLoginBtn');
    if (!firebaseConfigIsReady()) {
      if (googleBtn) googleBtn.disabled = true;
      if ($('authHelp')) $('authHelp').textContent = 'Chủ website cần kết nối Firebase trong file firebase-config.js.';
      updateAuthUI();
      return;
    }
    try {
      if (!firebase.apps.length) firebase.initializeApp(window.BLUEWING_FIREBASE_CONFIG);
      firebaseAuth = firebase.auth();
      firestore = firebase.firestore();
      authPending = true;
      authPendingTimer = setTimeout(finishAuthPending, 8000);
      if (isInAppBrowser() && $('authHelp')) {
        $('authHelp').textContent = 'Bạn đang mở trong ứng dụng khác (Zalo, Facebook...). Google có thể chặn đăng nhập tại đây, hãy mở liên kết bằng Chrome hoặc Safari.';
      }
      // Kết quả đăng nhập theo kiểu chuyển trang (dùng khi trình duyệt chặn cửa sổ bật lên)
      firebaseAuth.getRedirectResult().catch(function (err) {
        if (!err || err.code === 'auth/no-auth-event') return;
        console.warn('Redirect sign-in failed:', err);
        setAuthStatus(authErrorMessage(err));
        openModal('authModal');
      });
      firebaseAuth.onAuthStateChanged(handleAuthState);
    } catch (err) {
      console.error('Firebase initialization failed:', err);
      authPending = false;
      if (googleBtn) googleBtn.disabled = true;
      if ($('authHelp')) $('authHelp').textContent = 'Không thể khởi tạo Firebase.';
    }
  }

  /* =====================================================
     5. ĐIỀU HƯỚNG
     ===================================================== */
  var screens = document.querySelectorAll('.screen');
var validNames = ['home', 'dashboard', 'intro', 'test', 'result', 'settings'];
  var lastName = null;

  function parseHash() {
    var raw = window.location.hash.replace(/^#\/?/, '');
    var parts = raw.split('?');
    var name = validNames.indexOf(parts[0]) === -1 ? 'home' : parts[0];
    return { name: name, params: new URLSearchParams(parts[1] || '') };
  }
  function applyHashExam(r) {
    var id = r.params.get('exam');
    if (id && EXAMS[id] && id !== curExam) setExam(id);
  }
  function examHref(page, id) { return '#/' + page + '?exam=' + (id || curExam); }
  function bindExamTitle() {
    document.querySelectorAll('[data-exam-title]').forEach(function (el) {
      el.textContent = el.getAttribute('data-exam-title') === 'short' ? 'Đề số ' + (EXAM.num || curExam) : (EXAM.title || 'Đề thi');
    });
    document.querySelectorAll('[data-go]').forEach(function (a) {
      a.setAttribute('href', examHref(a.getAttribute('data-go')));
    });
  }
  function rerenderActive() {
    var hr = parseHash();
    applyHashExam(hr);
    bindExamTitle();
    if (hr.name === 'dashboard') renderDashboard();
    else if (hr.name === 'intro') renderIntro();
    else if (hr.name === 'result') renderResult();
  }

  function route() {
    var r = parseHash();
    if (lastName === 'test' && r.name !== 'test') leaveTest();
    applyHashExam(r);
    bindExamTitle();
    screens.forEach(function (s) {
      var active = s.id === 'screen-' + r.name;
      s.classList.toggle('active', active);
      if (active) document.title = s.getAttribute('data-title');
    });
    if (r.name === 'dashboard') renderDashboard();
    if (r.name === 'intro') renderIntro();
    if (r.name === 'test') {
      closePause();
      if (authPending) showTestLoading();
      else if (!(state && state.examId === curExam)) enterTest();
    }
    if (r.name === 'result') renderResult();
    lastName = r.name;
    window.scrollTo(0, 0);
    if (pendingToast) { showToast(pendingToast); pendingToast = ''; }
  }

  document.addEventListener('click', function (e) {
    var link = e.target.closest('[data-scroll]');
    if (!link) return;
    e.preventDefault();
    if (parseHash().name !== 'home') window.location.hash = '#/home';
    var target = document.getElementById(link.getAttribute('data-scroll'));
    if (target) setTimeout(function () { target.scrollIntoView({ behavior: 'smooth' }); }, 0);
  });
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-soon]')) e.preventDefault();
  });
  window.addEventListener('hashchange', route);

  /* =====================================================
     6. BẢNG ĐIỀU KHIỂN
     ===================================================== */
  function savedAttempt(id) {
    var s = load(xk(KEY_ATTEMPT, id));
    return s && s.answers ? s : null;
  }

  function renderDashboard() {
    EXAM_IDS.forEach(function (id) { settleExpired(id); });

    var h = readHistory(), last = h[h.length - 1];
    var totalQ = EXAM.total;
    var corrects = h.map(function (x) { return num(x.correct); });
    var best = corrects.length ? Math.max.apply(null, corrects) : 0;
    var avg = h.length ? Math.round(corrects.reduce(function (s, v) { return s + v; }, 0) / h.length) : null;

    if ($('dbSub')) {
      $('dbSub').textContent = activeUser
        ? (h.length ? 'Đây là tiến độ ôn luyện được đồng bộ trong tài khoản của bạn.' : 'Tài khoản đã sẵn sàng. Hãy làm đề đầu tiên để bắt đầu theo dõi tiến độ.')
        : (h.length ? 'Bạn đang dùng chế độ khách. Đăng nhập để đồng bộ tiến độ giữa các thiết bị.' : 'Chào mừng bạn đến với Hoàng BlueWing. Đăng nhập để lưu mục tiêu và đồng bộ kết quả học tập.');
    }

    if ($('dbLast')) $('dbLast').innerHTML = last ? num(last.correct) + '<span class="d18"> / ' + totalQ + ' câu</span>' : '—';
    if ($('dbLastMeta')) {
      var delta = h.length > 1 ? num(last.correct) - num(h[h.length - 2].correct) : null;
      $('dbLastMeta').textContent = !last ? 'Chưa có lần làm bài nào'
        : delta === null ? 'Kết quả của lần làm đầu tiên'
        : delta > 0 ? 'Tăng ' + delta + ' câu so với lần trước'
        : delta < 0 ? 'Giảm ' + Math.abs(delta) + ' câu so với lần trước'
        : 'Bằng với kết quả lần trước';
    }

    var seen = {};
    h.forEach(function (x) { seen[x.exam || '1'] = 1; });
    if ($('dbCount')) $('dbCount').innerHTML = Object.keys(seen).length + '<span class="d18"> đề</span>';
    if ($('dbAvgScore')) {
      $('dbAvgScore').textContent = 'Trung bình các lần làm: ' + (avg === null ? '—' : avg + '/' + totalQ + ' câu') + (h.length ? ' · Cao nhất: ' + best + ' câu' : '');
    }

    var daily = loadDaily();
    if ($('dbTime')) $('dbTime').innerHTML = Math.floor(daily.seconds / 60) + '<span class="d18"> phút</span>';
    if ($('dbTimeMeta')) $('dbTimeMeta').textContent = 'Thời gian bạn mở và học trên web hôm nay.';

    if (!h.length) {
      if ($('dbChart')) $('dbChart').innerHTML = '<div class="x-empty-chart">Chưa có dữ liệu.<br>Biểu đồ sẽ hiện sau lần làm bài đầu tiên.</div>';
      if ($('dbChartMeta')) $('dbChartMeta').textContent = 'Hoàn thành đề đầu tiên để bắt đầu theo dõi mức tiến bộ.';
    } else {
      var chartRows = h.slice(-6), base = h.length - chartRows.length;
      if ($('dbChart')) {
        $('dbChart').innerHTML =
          '<div class="x-chart" role="img" aria-label="Số câu đúng qua các lần làm bài">' +
          chartRows.map(function (x) {
            var c = num(x.correct);
            return '<div><b>' + c + '</b><i style="height:' + Math.max(4, Math.round(150 * c / totalQ)) + 'px"></i></div>';
          }).join('') +
          '</div><div class="x-chartlabels">' +
          chartRows.map(function (x, i) { return '<span>Lần ' + (base + i + 1) + '</span>'; }).join('') +
          '</div>';
      }
      if ($('dbChartMeta')) $('dbChartMeta').textContent = 'Cao nhất: ' + best + '/' + totalQ + ' câu · Trung bình: ' + avg + '/' + totalQ + ' câu.';
    }

    // Tỉ lệ đúng theo phần, gộp mọi lần làm (mỗi lần tính theo cấu trúc của đúng đề đó)
    var agg = {};
    h.forEach(function (item) {
      var ex = EXAMS[item.exam || '1'];
      if (!ex) return;
      ex.parts.forEach(function (p) {
        var a = agg[p.key] || (agg[p.key] = { ok: 0, n: 0 });
        a.ok += num(item.parts && item.parts[p.key]);
        a.n += partSize(p);
      });
    });
    var weakest = null;
    if ($('dbParts')) {
      $('dbParts').innerHTML = EXAM.parts.map(function (p) {
        var a = agg[p.key];
        var pct = a && a.n ? Math.round(100 * a.ok / a.n) : null;
        if (pct !== null && (weakest === null || pct < weakest.pct)) weakest = { pct: pct, p: p };
        return '<div class="x-prow"><div><span>' + p.name + '</span><span>' + (pct === null ? '—' : pct + '%') + '</span></div><div class="bar"><i style="width:' + (pct || 0) + '%"></i></div></div>';
      }).join('');
    }

    // Mục tiêu điểm: điểm ước lượng = số câu đúng quy đổi theo thang 1200 (chỉ để tham khảo)
    var goal = load(KEY_GOAL);
    var bestPoints = pointsFrom(best, totalQ);
    if ($('dbGoalValue')) {
      if (goal && goal.score) {
        var progress = Math.max(0, Math.min(100, Math.round(100 * bestPoints / num(goal.score, 1))));
        $('dbGoalValue').textContent = goal.score + '/' + MAX_POINTS + ' điểm';
        if ($('dbGoalBar')) $('dbGoalBar').style.width = progress + '%';
        var deadlineText = goal.deadline ? ' · Hạn ' + new Date(goal.deadline + 'T00:00:00').toLocaleDateString('vi-VN') : '';
        if ($('dbGoalHint')) $('dbGoalHint').textContent = (h.length
          ? 'Điểm ước lượng cao nhất: ' + bestPoints + '/' + MAX_POINTS + ' (' + progress + '%) · chỉ để tham khảo'
          : 'Hãy làm đề đầu tiên để đo tiến độ mục tiêu.') + deadlineText;
        if ($('goalEditBtn')) $('goalEditBtn').textContent = 'Chỉnh sửa';
      } else {
        $('dbGoalValue').textContent = activeUser ? 'Chưa đặt' : 'Đăng nhập';
        if ($('dbGoalBar')) $('dbGoalBar').style.width = '0%';
        if ($('dbGoalHint')) $('dbGoalHint').textContent = activeUser ? 'Đặt mục tiêu để BlueWing theo dõi tiến độ.' : 'Đăng nhập để thiết lập mục tiêu cá nhân.';
        if ($('goalEditBtn')) $('goalEditBtn').textContent = activeUser ? 'Thiết lập' : 'Đăng nhập';
      }
    }

    // Gợi ý hôm nay: ưu tiên bài đang làm dở, sau đó phần yếu nhất, cuối cùng là đề đầu tiên
    var pendingId = EXAM_IDS.filter(function (id) { return savedAttempt(id); })[0];
    var tipHref = examHref('intro', EXAM_IDS[0]);
    if (pendingId) {
      var sv = savedAttempt(pendingId);
      if ($('dbTipTitle')) $('dbTipTitle').textContent = 'Bạn đang làm dở Đề số ' + EXAMS[pendingId].num;
      if ($('dbTipText')) $('dbTipText').textContent = 'Đã trả lời ' + Object.keys(cleanAnswers(sv.answers, EXAMS[pendingId])).length + '/' + EXAMS[pendingId].total + ' câu, thời gian còn lại ' + mmss(effectiveLeft(sv)) + '. Hãy hoàn thành bài làm của bạn.';
      if ($('dbTipBtn')) { $('dbTipBtn').textContent = 'Tiếp tục làm bài'; tipHref = examHref('test', pendingId); }
    } else if (last && weakest) {
      if ($('dbTipTitle')) $('dbTipTitle').textContent = 'Ôn lại phần ' + weakest.p.name;
      if ($('dbTipText')) $('dbTipText').textContent = 'Phần này có tỉ lệ đúng trung bình thấp nhất qua các lần làm (' + weakest.pct + '%). Xem lại lời giải các câu sai để củng cố kiến thức.';
      if ($('dbTipBtn')) { $('dbTipBtn').textContent = 'Xem lại bài làm'; tipHref = examHref('result', EXAMS[last.exam] ? last.exam : EXAM_IDS[0]); }
    } else {
      if ($('dbTipTitle')) $('dbTipTitle').textContent = 'Bắt đầu với Đề số ' + EXAMS[EXAM_IDS[0]].num;
      if ($('dbTipText')) $('dbTipText').textContent = 'Làm trọn một đề ' + EXAM.total + ' câu trong ' + EXAM.minutes + ' phút để xác định điểm xuất phát. BlueWing sẽ dùng kết quả để gợi ý phần cần ôn.';
      if ($('dbTipBtn')) $('dbTipBtn').textContent = 'Làm Đề số ' + EXAMS[EXAM_IDS[0]].num;
    }
    if ($('dbTipBtn')) $('dbTipBtn').setAttribute('href', tipHref);

    var examRows = EXAM_IDS.map(function (id) {
      var ex = EXAMS[id], saved = savedAttempt(id), r = load(xk(KEY_RESULT, id));
      var action = saved
        ? '<em>Đang làm dở</em><a href="' + examHref('test', id) + '">Tiếp tục</a>'
        : r ? '<a class="alt" href="' + examHref('result', id) + '">Xem lại</a>' : '<a href="' + examHref('intro', id) + '">Bắt đầu</a>';
      var sub = ex.total + ' câu · ' + ex.minutes + ' phút · ' + (saved ? 'Đang làm dở' : r ? 'Đã làm · ' + num(r.correct) + '/' + ex.total + ' câu đúng' : 'Chưa làm');
      return '<div class="x-examrow"><div class="t"><b>Đề số ' + ex.num + '</b><span>' + sub + '</span></div>' + action + '</div>';
    });
    examRows.push('<div class="x-examrow"><div class="t"><b>Đề số ' + (EXAM_IDS.length + 1) + '</b><span>Đang soạn</span></div><em>Sắp ra mắt</em></div>');
    if ($('dbExams')) $('dbExams').innerHTML = examRows.join('');
  }

  /* =====================================================
     7. TRANG ĐỀ
     ===================================================== */
  function renderIntro() {
    settleExpired(curExam);
    var res = load(xk(KEY_RESULT)), saved = savedAttempt(curExam), h = readHistory();
    var status = saved ? 'paused' : res ? 'done' : 'new';
    var pauses = saved ? num(saved.pauses) : 0;
    var done = saved ? Object.keys(cleanAnswers(saved.answers)).length : 0;
    var pausedText = '';
    if (saved) {
      pausedText = 'Đã trả lời ' + done + '/' + EXAM.total + ' câu · Thời gian còn lại ' + mmss(effectiveLeft(saved)) + '. ';
      pausedText += saved.paused || !COUNT_AWAY_TIME
        ? 'Bạn có thể tiếp tục từ đúng chỗ đã dừng.'
        : 'Bạn chưa bấm "Tạm dừng và lưu" nên đồng hồ vẫn chạy khi bạn rời trang.';
    }
    var text = {
      scoreText: status === 'done' ? num(res.correct) + '/' + EXAM.total : '—',
      pauseCount: pauses + '/' + MAX_PAUSES,
      attemptCount: String(h.filter(function (x) { return (x.exam || '1') === curExam; }).length),
      ringHint: status === 'done' ? 'Số câu đúng lần làm gần nhất' : status === 'paused' ? 'Bài làm đang được lưu' : 'Đề ' + EXAM.total + ' câu · ' + EXAM.minutes + ' phút',
      pausedText: pausedText,
      doneText: res ? 'Lần làm gần nhất: đúng ' + num(res.correct) + '/' + EXAM.total + ' câu. Xem lại để biết mình sai ở đâu.' : ''
    };
    document.querySelectorAll('#screen-intro [data-bind]').forEach(function (el) {
      el.textContent = text[el.getAttribute('data-bind')] || '';
    });
    document.querySelectorAll('#screen-intro [data-state]').forEach(function (el) {
      el.style.display = el.getAttribute('data-state') === status ? 'contents' : 'none';
    });
    var ring = $('ring');
    if (ring) ring.setAttribute('stroke-dasharray', status === 'done' ? Math.round(339 * num(res.correct) / EXAM.total) + ' 339' : '0 339');
    if ($('introParts')) {
      $('introParts').innerHTML = EXAM.parts.map(function (p, i) {
        return '<div class="i34"><span class="d35">Phần ' + (i + 1) + ' · ' + p.name + '</span><span class="i35">Câu ' + p.from + ' đến ' + p.to + '</span></div>';
      }).join('');
    }
    renderIntroExtras(status === 'done');
  }

  // Đáp án PDF chỉ hiện sau khi đã nộp bài
  function pdfLinksHTML(showAnswer) {
    var pdf = EXAM.pdf;
    if (!pdf || !pdf.de) return '';
    var html = '<div class="pdf-row">';
    html += '<a class="pdf-link" href="' + pdf.de + '" target="_blank" rel="noopener">Xem đề thi (PDF)</a>';
    html += '<a class="pdf-link alt" href="' + pdf.de + '" target="_blank" rel="noopener" download>Tải đề thi</a>';
    html += '</div>';
    if (pdf.dapan && showAnswer) {
      html += '<div class="pdf-row">';
      html += '<a class="pdf-link alt" href="' + pdf.dapan + '" target="_blank" rel="noopener">Xem đáp án (PDF)</a>';
      html += '<a class="pdf-link alt" href="' + pdf.dapan + '" target="_blank" rel="noopener" download>Tải đáp án</a>';
      html += '</div>';
    }
    return html;
  }

  function renderIntroExtras(done) {
    if ($('examList')) {
      $('examList').innerHTML = EXAM_IDS.map(function (id) {
        return '<a href="' + examHref('intro', id) + '" class="' + (id === curExam ? 'i48' : 'i50') + '"' + (id === curExam ? ' aria-current="page"' : '') + '>' + EXAMS[id].title + '</a>';
      }).join('') + '<span class="i50 x-locked">Đề số ' + (EXAM_IDS.length + 1) + ' · sắp ra mắt</span>';
    }
    var box = $('introPdfBox');
    if (box) {
      var hasPdf = !!(EXAM.pdf && EXAM.pdf.de);
      box.style.display = hasPdf ? '' : 'none';
      if ($('introPdf')) $('introPdf').innerHTML = pdfLinksHTML(done);
      if ($('introPdfNote')) $('introPdfNote').textContent = hasPdf && EXAM.pdf.dapan && !done ? 'Đáp án PDF sẽ hiển thị sau khi bạn nộp bài.' : '';
    }
    if ($('introMatrix')) {
      var cnt = {}, tot = {};
      EXAM.parts.forEach(function (p) { cnt[p.key] = {}; });
      EXAM.groups.forEach(function (g) {
        g.questions.forEach(function (q) {
          var lv = levelOf(q);
          cnt[g.part] = cnt[g.part] || {};
          cnt[g.part][lv] = (cnt[g.part][lv] || 0) + 1;
        });
      });
      var rows = EXAM.parts.map(function (p) {
        return '<tr><th>' + p.name + '</th>' + LEVELS.map(function (l) {
          var c = (cnt[p.key] && cnt[p.key][l]) || 0;
          tot[l] = (tot[l] || 0) + c;
          return '<td>' + c + '</td>';
        }).join('') + '<td><b>' + partSize(p) + '</b></td></tr>';
      }).join('');
      rows += '<tr><th>Tổng</th>' + LEVELS.map(function (l) { return '<td><b>' + (tot[l] || 0) + '</b></td>'; }).join('') + '<td><b>' + EXAM.total + '</b></td></tr>';
      $('introMatrix').innerHTML = '<div class="table-scroll"><table class="bank-table level-matrix"><thead><tr><th>Phần</th>' + LEVELS.map(function (l) { return '<th>' + l + '</th>'; }).join('') + '<th>Tổng</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }
  }

  // "Làm lại" / "Làm lại từ đầu": hỏi xác nhận rồi bắt đầu bài mới (trước đây nút này chỉ mở lại bài cũ)
  var startFresh = false;
  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-restart], #screen-intro .i31');
    if (!a) return;
    if (!window.confirm('Làm lại đề này từ đầu? Bài đang làm dở (nếu có) sẽ bị xóa. Kết quả các lần đã nộp vẫn được giữ trong lịch sử.')) {
      e.preventDefault();
      return;
    }
    startFresh = true;
  });

  /* =====================================================
     8. LÀM BÀI
     ===================================================== */
  var state = null;       // { examId, answers, flags, left, part, pauses }
  var timerId = null;
  var endAt = 0;          // mốc thời gian (ms) hết giờ, tính theo đồng hồ thật nên không bị lệch khi tab bị treo
  var submitting = false;
  var warned = {};
  var $modal = $('pauseModal');

  // Số giây còn lại của bài đang lưu (tính cả thời gian rời trang nếu chưa bấm Tạm dừng)
  function effectiveLeft(saved) {
    var left = num(saved.left);
    if (!saved.paused && COUNT_AWAY_TIME && saved.savedAt) {
      left -= Math.max(0, Math.floor((Date.now() - num(saved.savedAt)) / 1000));
    }
    return left;
  }

  function finalizeAttempt(id, answers, used, auto) {
    var ex = EXAMS[id];
    var graded = gradeExam(ex, answers);
    var res = { answers: answers, used: used, at: Date.now(), auto: !!auto, correct: graded.correct, parts: graded.parts };
    save(xk(KEY_RESULT, id), res, { localOnly: true });
    var hh = readHistory();
    hh.push({ exam: id, correct: graded.correct, parts: graded.parts, used: used, at: res.at });
    save(KEY_HISTORY, hh.slice(-HISTORY_LIMIT), { localOnly: true });
    drop(xk(KEY_ATTEMPT, id)); // lần ghi này kích hoạt đồng bộ đám mây cho cả ba thay đổi
    return res;
  }

  // Bài dở đã hết giờ (ví dụ đóng tab rồi quay lại sau 3 tiếng): tự nộp
  function settleExpired(id) {
    var saved = savedAttempt(id);
    if (!saved || saved.paused || effectiveLeft(saved) > 0) return false;
    var ex = EXAMS[id];
    finalizeAttempt(id, cleanAnswers(saved.answers, ex), ex.minutes * 60, true);
    showToast('Bài làm dở của ' + ex.title + ' đã hết giờ nên được tự động nộp.');
    return true;
  }

  function showTestLoading() {
    if ($('partTabs')) $('partTabs').innerHTML = '';
    if ($('cells')) $('cells').innerHTML = '';
    if ($('partBody')) $('partBody').innerHTML = '<div class="x-empty">Đang tải bài làm của bạn...</div>';
  }

  function syncLeft() {
    if (state) state.left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
  }

  function enterTest() {
    if (startFresh) {
      startFresh = false;
      drop(xk(KEY_ATTEMPT));
    }
    if (settleExpired(curExam)) {
      pendingToast = 'Đề này đã hết giờ nên bài làm dở được tự động nộp.';
      window.location.hash = examHref('result');
      return;
    }
    var saved = savedAttempt(curExam);
    var total = EXAM.minutes * 60;
    submitting = false;
    warned = {};
    if (saved) {
      state = {
        examId: curExam,
        answers: cleanAnswers(saved.answers),
        flags: cleanFlags(saved.flags),
        left: Math.min(total, Math.max(1, Math.floor(effectiveLeft(saved)))),
        part: Math.min(EXAM.parts.length - 1, Math.max(0, num(saved.part))),
        pauses: Math.min(MAX_PAUSES, Math.max(0, num(saved.pauses)))
      };
    } else {
      state = { examId: curExam, answers: {}, flags: {}, left: total, part: 0, pauses: 0 };
    }
    endAt = Date.now() + state.left * 1000;
    persist(false);
    renderPart();
    renderCells();
    updateTimer();
    startTimer();
  }

  function leaveTest() {
    if (!state) return;
    if (timerId) { syncLeft(); stopTimer(); persist(false, true); }
    state = null;
  }

  // cloud = true: đẩy lên đám mây ngay (khi tạm dừng, rời trang); mặc định chỉ lưu trong trình duyệt
  function persist(paused, cloud) {
    if (!state) return;
    if (timerId) syncLeft();
    save(xk(KEY_ATTEMPT, state.examId), {
      paused: !!paused,
      answers: state.answers,
      flags: state.flags,
      left: state.left,
      part: state.part,
      pauses: state.pauses,
      savedAt: Date.now()
    }, { localOnly: !cloud });
  }

  function tick() {
    if (!state) return;
    syncLeft();
    updateTimer();
    if (state.left <= 0) submit(true);
  }
  function startTimer() {
    stopTimer();
    var ticks = 0;
    timerId = setInterval(function () {
      tick();
      if (!state || !timerId) return;
      ticks++;
      if (ticks % LOCAL_SAVE_EVERY === 0) persist(false);
    }, 1000);
  }
  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }

  function updateTimer() {
    if (!state) return;
    var t = mmss(state.left);
    if ($('timer')) {
      $('timer').textContent = t;
      var box = $('timer').closest('.t7');
      if (box) {
        box.classList.toggle('is-warning', state.left <= 600 && state.left > 120);
        box.classList.toggle('is-danger', state.left <= 120);
      }
    }
    if ($('timer2')) $('timer2').textContent = t;
    if (state.left <= 600 && !warned[600]) { warned[600] = 1; if (state.left > 300) showToast('Còn khoảng 10 phút.'); }
    if (state.left <= 300 && !warned[300]) { warned[300] = 1; if (state.left > 60) showToast('Còn khoảng 5 phút.'); }
    if (state.left <= 60 && !warned[60]) { warned[60] = 1; showToast('Còn dưới 1 phút. Hãy kiểm tra lại và nộp bài.'); }
  }

  function answeredCount() { return state ? Object.keys(state.answers).length : 0; }
  function flaggedCount() { return state ? Object.keys(state.flags).length : 0; }

  function figHTML(keys) {
    return (keys || []).map(function (k) { return '<div class="x-fig">' + ((EXAM.figures && EXAM.figures[k]) || '') + '</div>'; }).join('');
  }
  function flagLabel(on) { return on ? '⚑ Đã đánh dấu' : '⚐ Đánh dấu xem lại'; }

  function qHTML(q) {
    var flagged = !!(state && state.flags[q.n]);
    var html = '<div class="q-item" id="q-' + q.n + '"><div class="q-text"><span class="qn">Câu ' + q.n + '.</span> ' + q.stem + '</div>' + figHTML(q.figures) + '<div class="q-opts">';
    q.options.forEach(function (text, i) {
      var sel = state && state.answers[q.n] === i;
      html += '<button type="button" class="opt' + (sel ? ' selected' : '') + '" data-q="' + q.n + '" data-i="' + i + '" aria-pressed="' + !!sel + '"><span class="opt-letter">' + LETTERS[i] + '</span><span>' + text + '</span></button>';
    });
    html += '</div><div class="q-tools"><button type="button" class="q-flag' + (flagged ? ' on' : '') + '" data-flag="' + q.n + '" aria-pressed="' + flagged + '">' + flagLabel(flagged) + '</button></div></div>';
    return html;
  }

  function renderPart() {
    if (!state || !$('partTabs') || !$('partBody')) return;
    var P = EXAM.parts[state.part];
    $('partTabs').innerHTML = EXAM.parts.map(function (p, i) {
      return '<button type="button" role="tab" class="x-tab' + (i === state.part ? ' active' : '') + '" data-part="' + i + '" aria-selected="' + (i === state.part) + '">' + p.name + '<small>' + p.from + '–' + p.to + '</small></button>';
    }).join('');
    var body = '';
    EXAM.groups.filter(function (g) { return g.part === P.key; }).forEach(function (g) {
      body += '<section class="x-group">';
      if (g.passage || g.figures) body += '<div class="x-ctx">' + (g.passage || '') + figHTML(g.figures) + '</div>';
      g.questions.forEach(function (q) { body += qHTML(q); });
      body += '</section>';
    });
    $('partBody').innerHTML = body;
    if ($('prevPart')) $('prevPart').style.visibility = state.part === 0 ? 'hidden' : 'visible';
    if ($('nextPart')) $('nextPart').style.visibility = state.part === EXAM.parts.length - 1 ? 'hidden' : 'visible';
    typeset($('partBody'));
  }

  function renderCells() {
    if (!state || !$('cells')) return;
    var html = '';
    EXAM.parts.forEach(function (p, pi) {
      html += '<div class="x-cellhead">' + p.name + '</div><div class="x-cellgrid">';
      for (var n = p.from; n <= p.to; n++) {
        var done = state.answers[n] !== undefined, flag = !!state.flags[n];
        html += '<button type="button" class="cell' + (done ? ' done' : '') + (flag ? ' flagged' : '') + '" data-n="' + n + '" data-part="' + pi + '" aria-label="Câu ' + n + (done ? ', đã trả lời' : ', chưa trả lời') + (flag ? ', đã đánh dấu xem lại' : '') + '">' + n + '</button>';
      }
      html += '</div>';
    });
    $('cells').innerHTML = html;
    document.querySelectorAll('[data-bind="doneCount"]').forEach(function (el) { el.textContent = answeredCount(); });
    document.querySelectorAll('[data-bind="flagCount"]').forEach(function (el) { el.textContent = flaggedCount(); });
  }

  function gotoPart(i, n) {
    if (!state) return;
    if (i < 0 || i >= EXAM.parts.length) return;
    if (i !== state.part) {
      state.part = i;
      renderPart();
      persist(false);
    }
    if (n) {
      var item = document.getElementById('q-' + n);
      if (item) item.scrollIntoView({ block: 'start' });
    } else {
      window.scrollTo(0, 0);
    }
  }

  if ($('partBody')) {
    $('partBody').addEventListener('click', function (e) {
      if (!state) return;
      var flagBtn = e.target.closest('button[data-flag]');
      if (flagBtn) {
        var fn = +flagBtn.getAttribute('data-flag');
        if (state.flags[fn]) delete state.flags[fn]; else state.flags[fn] = true;
        var on = !!state.flags[fn];
        flagBtn.classList.toggle('on', on);
        flagBtn.setAttribute('aria-pressed', on);
        flagBtn.textContent = flagLabel(on);
        persist(false);
        renderCells();
        return;
      }
      var btn = e.target.closest('button[data-q]');
      if (!btn) return;
      var n = +btn.getAttribute('data-q'), i = +btn.getAttribute('data-i');
      if (state.answers[n] === i) delete state.answers[n]; else state.answers[n] = i;
      var item = btn.closest('.q-item');
      if (item) {
        item.querySelectorAll('.opt').forEach(function (b) {
          var sel = state.answers[n] === +b.getAttribute('data-i');
          b.classList.toggle('selected', sel);
          b.setAttribute('aria-pressed', sel);
        });
      }
      persist(false);
      renderCells();
    });
  }
  if ($('partTabs')) {
    $('partTabs').addEventListener('click', function (e) {
      var t = e.target.closest('[data-part]');
      if (t) gotoPart(+t.getAttribute('data-part'));
    });
  }
  if ($('cells')) {
    $('cells').addEventListener('click', function (e) {
      var c = e.target.closest('button[data-n]');
      if (c) gotoPart(+c.getAttribute('data-part'), +c.getAttribute('data-n'));
    });
  }
  if ($('prevPart')) $('prevPart').addEventListener('click', function () { if (state) gotoPart(state.part - 1); });
  if ($('nextPart')) $('nextPart').addEventListener('click', function () { if (state) gotoPart(state.part + 1); });

  function openPause() {
    if (!state) return;
    if (state.pauses >= MAX_PAUSES) { window.alert('Bạn đã dùng hết ' + MAX_PAUSES + ' lần tạm dừng của đề này.'); return; }
    syncLeft();
    document.querySelectorAll('[data-bind="pausesLeft"]').forEach(function (el) { el.textContent = (MAX_PAUSES - state.pauses) + '/' + MAX_PAUSES; });
    document.querySelectorAll('[data-bind="timeLeft"]').forEach(function (el) { el.textContent = mmss(state.left); });
    document.querySelectorAll('[data-bind="doneCount"]').forEach(function (el) { el.textContent = answeredCount(); });
    if ($modal) {
      lastFocus = document.activeElement;
      $modal.hidden = false;
      if ($('closePause')) $('closePause').focus();
    }
  }
  function closePause() {
    if (!$modal || $modal.hidden) return;
    $modal.hidden = true;
    if (lastFocus && lastFocus.focus && document.body.contains(lastFocus)) { try { lastFocus.focus(); } catch (e) {} }
    lastFocus = null;
  }

  if ($('openPause')) $('openPause').addEventListener('click', openPause);
  if ($('closePause')) $('closePause').addEventListener('click', closePause);
  if ($('pauseExit')) {
    $('pauseExit').addEventListener('click', function () {
      if (!state) return;
      syncLeft();
      stopTimer();
      state.pauses++;
      persist(true, true);
    });
  }

  if ($('submitBtn')) {
    $('submitBtn').addEventListener('click', function () {
      if (!state) return;
      var left = EXAM.total - answeredCount(), fl = flaggedCount();
      var msg = (left > 0 ? 'Bạn còn ' + left + ' câu chưa trả lời. ' : '') +
        (fl > 0 ? 'Có ' + fl + ' câu đang đánh dấu xem lại. ' : '') +
        (left > 0 || fl > 0 ? 'Vẫn nộp bài?' : 'Nộp bài và xem kết quả?');
      if (window.confirm(msg)) submit(false);
    });
  }

  function submit(auto) {
    if (!state || submitting) return;
    submitting = true;
    syncLeft();
    stopTimer();
    var ex = EXAMS[state.examId];
    var used = ex.minutes * 60 - Math.max(0, state.left);
    var id = state.examId;
    var answers = state.answers;
    state = null; // sau khi nộp không được lưu lại bài dở nữa
    finalizeAttempt(id, answers, used, auto);
    if (auto) pendingToast = 'Hết giờ! Bài làm đã được tự động nộp.';
    window.location.hash = examHref('result', id);
  }

  // Cảnh báo khi vô tình đóng tab hoặc tải lại trong lúc đang làm bài
  window.addEventListener('beforeunload', function (e) {
    if (state && timerId && isScreen('test')) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /* =====================================================
     9. KẾT QUẢ
     ===================================================== */
  var resFilter = 'all';
  var resCounts = { all: 0, wrong: 0, right: 0 };

  function feedback(pct, done, total, correct) {
    if (done === 0) return { t: 'Bạn chưa trả lời câu nào', m: 'Bài nộp đang để trống. Nếu bạn chỉ bấm thử thì không sao, hãy quay lại làm đề khi sẵn sàng nhé.' };
    if (done < total * 0.6) return { t: 'Bạn mới làm một phần của đề', m: 'Bạn đã trả lời ' + done + '/' + total + ' câu và đúng ' + correct + ' câu. Lần sau hãy cố hoàn thành cả đề để có kết quả phản ánh đúng thực lực.' };
    if (correct === total) return { t: 'Tuyệt đối!', m: 'Bạn trả lời đúng cả ' + total + ' câu. Kết quả xuất sắc, không có câu nào sai.' };
    var base = 'Bạn trả lời đúng ' + correct + '/' + total + ' câu (' + pct + '%). ';
    if (pct >= 85) return { t: 'Xuất sắc!', m: base + 'Kết quả rất cao. Hãy xem lại vài câu sai để giữ vững phong độ.' };
    if (pct >= 65) return { t: 'Làm tốt lắm!', m: base + 'Bạn đã nắm khá chắc kiến thức. Ôn thêm những câu sai là có thể lên mức cao hơn.' };
    if (pct >= 45) return { t: 'Khá ổn, cố thêm chút nữa!', m: base + 'Bạn đã có nền tảng tốt, chỉ cần ôn kĩ đúng những phần còn sai là điểm sẽ tăng rõ.' };
    if (pct >= 25) return { t: 'Bạn đã có nền tảng để bắt đầu', m: base + 'Đừng nản. Mỗi câu sai chỉ ra chính xác điều cần ôn, nên bài này rất có ích cho bạn.' };
    return { t: 'Đừng nản, đây mới là bước đầu', m: base + 'Điểm lần đầu chưa phản ánh hết khả năng. Hãy xem lời giải từng câu và ôn dần từng phần nhé.' };
  }

  function renderResTabs() {
    if (!$('resTabs')) return;
    var tabs = [['all', 'Tất cả'], ['wrong', 'Câu sai và bỏ trống'], ['right', 'Câu đúng']];
    $('resTabs').innerHTML = tabs.map(function (t) {
      return '<button type="button" role="tab" data-f="' + t[0] + '" aria-selected="' + (resFilter === t[0]) + '" class="' + (resFilter === t[0] ? 'r25' : 'r24') + '">' + t[1] + ' (' + resCounts[t[0]] + ')</button>';
    }).join('');
  }

  function renderResult() {
    settleExpired(curExam);
    var res = load(xk(KEY_RESULT));
    if (!res || !res.answers) {
      if ($('resTitle')) $('resTitle').textContent = 'Chưa có bài nộp nào';
      if ($('resMsg')) $('resMsg').textContent = 'Hãy làm đề số ' + (EXAM.num || curExam) + ' rồi nộp bài để xem kết quả tại đây.';
      ['resChips', 'resParts', 'resAI', 'resList', 'resTabs', 'resPdf', 'resSidebarGrid'].forEach(function (id) { if ($(id)) $(id).innerHTML = ''; });
      if ($('resScale')) $('resScale').textContent = '';
      if ($('resScore')) $('resScore').textContent = '0';
      if ($('resRing')) $('resRing').setAttribute('stroke-dasharray', '0 339');
      if ($('sidebarScore')) $('sidebarScore').textContent = '0';
      if ($('sidebarDone')) $('sidebarDone').textContent = '0/' + EXAM.total;
      showCachedAI(null);
      return;
    }

    var total = EXAM.total, ans = cleanAnswers(res.answers), correct = 0, blank = 0, wrong = [];
    var byPart = {};
    EXAM.parts.forEach(function (p) { byPart[p.key] = { ok: 0, n: partSize(p), name: p.name }; });
    var wrongTags = {};
    EXAM.groups.forEach(function (g) {
      g.questions.forEach(function (q) {
        var a = ans[q.n];
        if (a === q.answer) { correct++; byPart[g.part].ok++; return; }
        if (a === undefined) blank++;
        wrong.push(q.n);
        if (a === undefined) return;
        var key = q.topic || 'Chưa phân loại';
        var entry = wrongTags[key] || (wrongTags[key] = { qs: [], tags: {} });
        entry.qs.push(q.n);
        (q.mistake_tags || []).forEach(function (t) { entry.tags[t] = 1; });
      });
    });
    var wrongOnly = wrong.length - blank;
    var pct = Math.round(100 * correct / total);

    if ($('resScore')) $('resScore').textContent = correct;
    if ($('resRing')) $('resRing').setAttribute('stroke-dasharray', Math.round(339 * correct / total) + ' 339');
    var fb = feedback(pct, total - blank, total, correct);
    if ($('resTitle')) $('resTitle').textContent = fb.t;
    if ($('resMsg')) $('resMsg').textContent = fb.m + (wrong.length && total - blank > 0 ? ' Xem lại ' + wrong.length + ' câu chưa đúng bên dưới để biết mình sai ở đâu.' : '');
    if ($('resChips')) $('resChips').innerHTML =
      '<span class="r12">' + correct + ' câu đúng</span>' +
      '<span class="r13">' + wrongOnly + ' câu sai</span>' +
      '<span class="r14">' + blank + ' câu bỏ trống</span>' +
      '<span class="r15">Thời gian ' + mmss(res.used) + '</span>';
    if ($('resParts')) $('resParts').innerHTML = EXAM.parts.map(function (p) {
      var b = byPart[p.key];
      return '<div class="x-part"><b>' + b.ok + '/' + b.n + '</b><span>' + b.name + '</span><div class="x-bar"><i style="width:' + Math.round(100 * b.ok / b.n) + '%"></i></div></div>';
    }).join('');
    if ($('resPdf')) $('resPdf').innerHTML = pdfLinksHTML(true);
    if ($('resScale')) $('resScale').textContent = 'Điểm quy đổi tham khảo: khoảng ' + pointsFrom(correct, total) + '/' + MAX_POINTS + ' (theo tỉ lệ số câu đúng). Điểm thật của kỳ thi ĐGNL được tính theo thang riêng của ĐHQG-HCM (IRT), nên con số này chỉ dùng để theo dõi tiến bộ.';

    var topics = Object.keys(wrongTags).sort(function (a, b) { return wrongTags[b].qs.length - wrongTags[a].qs.length; }).slice(0, 6);
    if ($('resAI')) {
      $('resAI').innerHTML = topics.length ? topics.map(function (t) {
        var o = wrongTags[t], tagText = Object.keys(o.tags).slice(0, 4).join(', ');
        return '<div class="r20"><span class="r21">' + t + ' · ' + o.qs.length + ' câu</span><span class="r22">Câu ' + o.qs.join(', ') + '.' + (tagText ? ' Nhóm lỗi: ' + tagText + '.' : '') + '</span></div>';
      }).join('') : '<p class="x-note">Không có lỗi sai để phân tích.</p>';
    }

    resCounts = { all: total, wrong: wrong.length, right: correct };
    renderResTabs();
    renderReview(res);
    showCachedAI(res);
    renderResultSidebar(res);
  }

  function renderReview(res) {
    if (!$('resList')) return;
    var ans = cleanAnswers(res.answers), html = '', shown = 0;
    for (var n = 1; n <= EXAM.total; n++) {
      var o = QMAP[n];
      if (!o) continue;
      var q = o.q, a = ans[n];
      var ok = a === q.answer;
      if (resFilter === 'wrong' && ok) continue;
      if (resFilter === 'right' && !ok) continue;
      shown++;
      var badge = ok ? '<span class="r45">Đúng</span>' : a === undefined ? '<span class="r41">Bỏ trống</span>' : '<span class="r28">Sai</span>';
      var part = EXAM.parts.filter(function (p) { return n >= p.from && n <= p.to; })[0];
      var partName = part ? part.name.toUpperCase() : '';

      html += '<article class="t11 rv-' + (ok ? 'ok' : a === undefined ? 'blank' : 'wrong') + '" id="review-q-' + n + '"><div class="t20"><div class="r26"><span class="r27">' + partName + ' · CÂU ' + n + '</span>' + badge + '</div>';
      if (!ok && o.g.passage) {
        html += '<details><summary class="x-note review-summary">Xem lại dữ kiện / đoạn văn của câu này</summary><div class="x-ctxbox">' + o.g.passage + figHTML(o.g.figures) + '</div></details>';
      } else if (!ok && o.g.figures) {
        html += '<details open><summary class="x-note">Hình minh họa</summary>' + figHTML(o.g.figures) + '</details>';
      }
      html += '<div class="q-text">' + q.stem + '</div>' + figHTML(q.figures) + '<div class="h26">';
      q.options.forEach(function (t, i) {
        if (i === q.answer) html += '<div class="r31"><span class="r32">' + LETTERS[i] + '</span><span class="t44">' + t + '</span><span class="r33">Đáp án đúng</span></div>';
        else if (i === a) html += '<div class="r34"><span class="r35">' + LETTERS[i] + '</span><span class="t44">' + t + '</span><span class="r36">Bạn đã chọn</span></div>';
        else html += '<div class="r29"><span class="r30">' + LETTERS[i] + '</span><span class="t44">' + t + '</span></div>';
      });
      html += '</div></div><div class="r37"><strong>Lời giải</strong><span>' + (q.explanation || 'Chưa có lời giải cho câu này.') + '</span></div></article>';
    }
    $('resList').innerHTML = shown ? html : '<div class="x-empty">Không có câu nào trong mục này.</div>';
    typeset($('resList'));
  }

  function renderResultSidebar(res) {
    if (!$('resSidebarGrid')) return;
    var total = EXAM.total, ans = cleanAnswers(res.answers);
    var correctCount = 0, doneCount = Object.keys(ans).length;
    var html = '';
    EXAM.parts.forEach(function (p) {
      html += '<div class="res-grid-section"><div class="res-grid-section-title">' + p.name + '</div><div class="res-grid">';
      for (var n = p.from; n <= p.to; n++) {
        var q = QMAP[n] && QMAP[n].q;
        if (!q) continue;
        var a = ans[n], cls = 'blank';
        if (a !== undefined) {
          if (a === q.answer) { cls = 'correct'; correctCount++; } else cls = 'wrong';
        }
        html += '<button type="button" class="res-grid-btn ' + cls + '" data-jump="' + n + '" aria-label="Câu ' + n + ': ' + (cls === 'correct' ? 'đúng' : cls === 'wrong' ? 'sai' : 'bỏ trống') + '">' + n + '</button>';
      }
      html += '</div></div>';
    });
    $('resSidebarGrid').innerHTML = html;
    if ($('sidebarScore')) $('sidebarScore').textContent = correctCount;
    if ($('sidebarDone')) $('sidebarDone').textContent = doneCount + '/' + total;
  }

  if ($('resSidebarGrid')) {
    $('resSidebarGrid').addEventListener('click', function (e) {
      var btn = e.target.closest('.res-grid-btn');
      if (btn) jumpToQuestion(+btn.getAttribute('data-jump'));
    });
  }

  function jumpToQuestion(n) {
    var target = document.getElementById('review-q-' + n);
    if (!target && resFilter !== 'all') {
      resFilter = 'all';
      renderResTabs();
      var res = load(xk(KEY_RESULT));
      if (res) renderReview(res);
      target = document.getElementById('review-q-' + n);
    }
    if (target) flashAndScroll(target);
  }
  function flashAndScroll(el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('highlight-flash');
    setTimeout(function () { el.classList.remove('highlight-flash'); }, 1500);
  }

  if ($('resTabs')) {
    $('resTabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-f]');
      if (!b) return;
      resFilter = b.getAttribute('data-f');
      renderResTabs();
      var res = load(xk(KEY_RESULT));
      if (res) renderReview(res); // chỉ vẽ lại danh sách câu, không vẽ lại cả trang
    });
  }

  /* =====================================================
     10. TÀI KHOẢN, MỤC TIÊU
     ===================================================== */
  document.querySelectorAll('[data-auth-trigger]').forEach(function (btn) {
    btn.addEventListener('click', openAuthOrAccount);
  });
  document.addEventListener('click', function (e) {
    var close = e.target.closest('[data-close-modal]');
    if (close) closeModal(close.getAttribute('data-close-modal'));
  });

  if ($('googleLoginBtn')) {
    $('googleLoginBtn').addEventListener('click', async function () {
      if (!firebaseAuth) {
        setAuthStatus('Chủ website cần hoàn tất cấu hình Firebase trước khi bật đăng nhập Google.');
        return;
      }
      var btn = $('googleLoginBtn');
      btn.disabled = true;
      setAuthStatus('Đang kết nối với Google...');
      var provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try {
        await firebaseAuth.signInWithPopup(provider);
        closeModal('authModal');
        setAuthStatus('');
      } catch (err) {
        console.error('Google sign-in failed:', err);
        if (err && (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment')) {
          setAuthStatus('Đang chuyển sang trang đăng nhập Google...');
          try {
            await firebaseAuth.signInWithRedirect(provider);
            return;
          } catch (redirectError) {
            setAuthStatus(authErrorMessage(redirectError));
          }
        } else {
          setAuthStatus(authErrorMessage(err));
        }
      } finally {
        btn.disabled = false;
      }
    });
  }

  if ($('signOutBtn')) {
    $('signOutBtn').addEventListener('click', async function () {
      if (!firebaseAuth) return;
      try {
        await persistCloudNow();
        await firebaseAuth.signOut();
        closeModal('accountModal');
        showToast('Bạn đã đăng xuất khỏi BlueWing.');
      } catch (err) {
        showToast('Chưa thể đăng xuất. Vui lòng thử lại.');
      }
    });
  }

  if ($('accountGoalBtn')) {
    $('accountGoalBtn').addEventListener('click', function (e) {
      e.preventDefault();
      closeModal('accountModal');
      openGoalModal();
    });
  }

  if ($('accountNameBtn')) {
    $('accountNameBtn').addEventListener('click', function (e) {
      e.preventDefault();
      var cur = load(KEY_NAME) || '';
      var input = window.prompt(
        'Nhập tên bạn muốn hiển thị trên bảng điều khiển:\n(tên này chỉ dùng trong BlueWing, không đổi tên Google)',
        cur || (activeUser && activeUser.displayName) || ''
      );
      if (input === null) return;
      var name = input.trim();
      if (!name) { showToast('Tên không được để trống.'); return; }
      if (name.length > 30) { showToast('Tên tối đa 30 ký tự.'); return; }
      save(KEY_NAME, name);
      updateAuthUI();
      showToast('Đã đổi tên hiển thị thành "' + name + '".');
    });
  }

  // Xóa toàn bộ dữ liệu học tập của tài khoản (nút #accountResetBtn sẽ được thêm trong index.html)
  if ($('accountResetBtn')) {
    $('accountResetBtn').addEventListener('click', async function () {
      if (!activeUser) return;
      if (!window.confirm('Xóa toàn bộ lịch sử làm bài, kết quả, bài đang làm và mục tiêu của tài khoản này? Hành động này không thể hoàn tác.')) return;
      writeShape(emptyShape(), activeUser.uid);
      await persistCloudNow();
      closeModal('accountModal');
      rerenderActive();
      updateAuthUI();
      showToast('Đã xóa dữ liệu học tập của tài khoản.');
    });
  }

  if ($('goalEditBtn')) {
    $('goalEditBtn').addEventListener('click', function (e) {
      e.preventDefault();
      openGoalModal();
    });
  }

  if ($('goalForm')) {
    $('goalForm').addEventListener('submit', function (e) {
      e.preventDefault();
      if (!activeUser) { closeModal('goalModal'); openAuthOrAccount(); return; }
      var scoreInput = $('goalScore');
      var score = Math.round(Number(scoreInput.value));
      if (!isFinite(score) || score < 1 || score > MAX_POINTS) {
        if ($('goalProgressHelp')) $('goalProgressHelp').textContent = 'Hãy nhập mục tiêu từ 1 đến ' + MAX_POINTS + ' điểm.';
        scoreInput.focus();
        return;
      }
      var deadline = $('goalDeadline') ? ($('goalDeadline').value || '') : '';
      save(KEY_GOAL, { score: score, unit: 'points1200', deadline: deadline, updatedAt: Date.now() });
      closeModal('goalModal');
      if (isScreen('dashboard')) renderDashboard();
      showToast('Đã lưu mục tiêu ' + score + '/' + MAX_POINTS + ' điểm.');
    });
  }

  /* =====================================================
     11. PHÂN TÍCH BÀI LÀM TỰ ĐỘNG (tính ngay trên trình duyệt, không cần AI ngoài)
     ===================================================== */
  var PART_TIPS = {
    tv: 'đọc kĩ ngữ liệu trước khi đọc câu hỏi, gạch chân từ khóa rồi đối chiếu từng phương án với văn bản; ôn thêm tiếng Việt thực hành (từ loại, biện pháp tu từ, liên kết câu, lỗi dùng từ).',
    ta: 'ôn từ vựng theo chủ đề và các cấu trúc ngữ pháp trọng tâm (câu điều kiện, đảo ngữ, mệnh đề quan hệ, rút gọn mệnh đề); với bài đọc, xác định ý chính trước rồi mới đối chiếu chi tiết.',
    toan: 'làm lại từng bài sai theo từng bước, chú ý điều kiện xác định, dấu và phép tính; ghi lại công thức hay nhầm rồi tự giải lại mà không nhìn lời giải.',
    tdkh: 'luyện đọc bảng, biểu đồ và số liệu; xác định biến, yếu tố gây nhiễu, tránh kết luận vượt quá dữ kiện; với bài logic, hãy vẽ bảng suy luận để loại trừ.'
  };
  var LEVEL_ORDER = ['Nhận biết', 'Thông hiểu', 'Vận dụng', 'Vận dụng cao'];

  function pc(ok, n) { return n ? Math.round(100 * ok / n) : 0; }
  function qList(arr) { return arr.length > 8 ? arr.slice(0, 8).join(', ') + '…' : arr.join(', '); }

  function analyzeLocal(res) {
    var ans = cleanAnswers(res.answers);
    var GENERIC = { 'Mẫu': 1, 'Khác': 1, 'Tiếng Việt': 1, 'Tiếng Anh': 1, 'Toán học': 1, 'Tư duy khoa học': 1 };
    var parts = {}, levels = {}, topics = {}, tags = {};
    EXAM.parts.forEach(function (p) { parts[p.key] = { key: p.key, name: p.name, ok: 0, n: 0, done: 0, wrong: [], blank: [] }; });
    LEVEL_ORDER.forEach(function (l) { levels[l] = { ok: 0, done: 0 }; });
    var total = 0, correct = 0, done = 0;
    EXAM.groups.forEach(function (g) {
      g.questions.forEach(function (q) {
        var a = ans[q.n], answered = a !== undefined && a !== null, ok = answered && a === q.answer, P = parts[g.part];
        var lv = LEVEL_ORDER.indexOf(q.level) === -1 ? 'Thông hiểu' : q.level;
        total++; P.n++;
        if (!answered) { P.blank.push(q.n); return; }
        done++; P.done++; levels[lv].done++;
        if (ok) { correct++; P.ok++; levels[lv].ok++; return; }
        P.wrong.push(q.n);
        var key = (q.topic && !GENERIC[q.topic]) ? q.topic : (q.skill || '');
        if (key) {
          var T = topics[key] = topics[key] || { name: key, part: g.part, wrong: [], skills: {} };
          T.wrong.push(q.n);
          if (q.skill && q.skill !== key) T.skills[q.skill] = 1;
        }
        (q.mistake_tags || []).forEach(function (t) { tags[t] = (tags[t] || 0) + 1; });
      });
    });

    var out = { overview: '', strengths: [], weaknesses: [], plan: [] };
    var blankAll = total - done, wrongAll = done - correct;
    var limit = EXAM.minutes * 60, used = num(res.used);

    // 1) Chưa làm gì
    if (done === 0) {
      out.overview = 'Bài nộp chưa có câu nào được trả lời (' + total + ' câu bỏ trống), nên chưa có dữ liệu để phân tích điểm mạnh hay điểm yếu của bạn.';
      out.weaknesses.push('Chưa có câu trả lời nào' + (used ? ' (thời gian làm bài ' + mmss(used) + ')' : '') + '. Nếu bạn chỉ bấm thử giao diện thì không sao; còn nếu đã làm bài, hãy kiểm tra lại các đáp án đã chọn trước khi nộp.');
      out.plan.push('Làm lại đề và chọn đáp án cho từng câu. Đề trắc nghiệm không trừ điểm câu sai, nên câu nào chưa chắc vẫn nên loại trừ bớt rồi chọn.');
      out.plan.push('Sau khi nộp, quay lại đây: phân tích sẽ chỉ ra phần, chủ đề và kiểu lỗi cần ôn dựa trên chính bài làm của bạn.');
      return out;
    }
    if (correct === total) { out.overview = 'Bạn trả lời đúng cả ' + total + ' câu. Kết quả xuất sắc, không có lỗi sai để phân tích.'; return out; }

    var plist = Object.keys(parts).map(function (k) { return parts[k]; });
    var allPct = pc(correct, total), donePct = pc(correct, done);
    // chỉ xếp hạng các phần đã làm ít nhất 1/2 số câu
    var ranked = plist.filter(function (p) { return p.done >= p.n * 0.5; })
      .sort(function (a, b) { return pc(a.ok, a.done) - pc(b.ok, b.done); });
    var partial = done < total * 0.6;

    out.overview = 'Bạn trả lời ' + done + '/' + total + ' câu và đúng ' + correct + ' câu (' + allPct + '% cả đề' +
      (blankAll ? '; trong số câu đã làm, đúng ' + donePct + '%' : '') + ').';
    if (partial) out.overview += ' Vì mới làm ' + pc(done, total) + '% số câu nên nhận xét dưới đây chỉ mang tính tham khảo; hãy hoàn thành cả đề để có đánh giá chính xác hơn.';
    else if (ranked.length >= 2) {
      var lo = ranked[0], hi = ranked[ranked.length - 1];
      if (pc(hi.ok, hi.done) - pc(lo.ok, lo.done) >= 10)
        out.overview += ' Phần làm tốt nhất là ' + hi.name + ' (' + pc(hi.ok, hi.done) + '%); phần cần ưu tiên ôn là ' + lo.name + ' (' + pc(lo.ok, lo.done) + '%).';
      else out.overview += ' Các phần có kết quả khá đều nhau, chưa có phần nào nổi trội hoặc yếu hẳn.';
    }

    // 2) Điểm mạnh: chỉ khi đã làm đủ nhiều và đúng nhiều
    plist.forEach(function (p) {
      if (p.done >= p.n * 0.6 && p.done >= 5 && pc(p.ok, p.done) >= 70)
        out.strengths.push(p.name + ': đúng ' + p.ok + '/' + p.done + ' câu đã làm (' + pc(p.ok, p.done) + '%). Hãy giữ phong độ ở phần này.');
    });
    var easyOk = levels['Nhận biết'].ok + levels['Thông hiểu'].ok, easyD = levels['Nhận biết'].done + levels['Thông hiểu'].done;
    var hardOk = levels['Vận dụng'].ok + levels['Vận dụng cao'].ok, hardD = levels['Vận dụng'].done + levels['Vận dụng cao'].done;
    if (!partial && easyD >= 10 && pc(easyOk, easyD) >= 75) out.strengths.push('Câu Nhận biết và Thông hiểu: đúng ' + pc(easyOk, easyD) + '% số câu đã làm. Nền tảng kiến thức khá chắc.');
    if (!partial && hardD >= 8 && pc(hardOk, hardD) >= 50) out.strengths.push('Câu Vận dụng và Vận dụng cao: đúng ' + pc(hardOk, hardD) + '% số câu đã làm, khả năng xử lí câu khó tốt.');
    if (!out.strengths.length && correct > 0) {
      var ok0 = plist.filter(function (p) { return p.ok > 0; }).sort(function (a, b) { return b.ok - a.ok; })[0];
      out.strengths.push('Bạn đã làm đúng ' + correct + ' câu, nhiều nhất ở phần ' + ok0.name + ' (' + ok0.ok + ' câu). Hãy xem lại cách làm các câu đúng để nhân rộng sang câu khác.');
    }

    // 3) Điểm yếu
    var untouched = plist.filter(function (p) { return p.done === 0; });
    if (untouched.length && untouched.length < plist.length)
      out.weaknesses.push('Chưa làm phần nào của: ' + untouched.map(function (p) { return p.name + ' (' + p.n + ' câu)'; }).join(', ') + '. Hãy làm đủ các phần để biết điểm yếu thật sự nằm ở đâu.');
    plist.forEach(function (p) {
      if (p.done === 0 && untouched.length < plist.length) return;
      var bits = [];
      if (p.wrong.length) bits.push('sai ' + p.wrong.length + ' câu (' + qList(p.wrong) + ')');
      if (p.blank.length) bits.push('bỏ trống ' + p.blank.length + ' câu' + (p.blank.length <= 12 ? ' (' + qList(p.blank) + ')' : ''));
      if (!bits.length) return;
      if (p.done >= p.n * 0.5 && pc(p.ok, p.done) >= 70 && p.blank.length < p.n * 0.2) return;
      var tp = Object.keys(topics).map(function (k) { return topics[k]; })
        .filter(function (T) { return T.part === p.key; })
        .sort(function (a, b) { return b.wrong.length - a.wrong.length; }).slice(0, 3);
      out.weaknesses.push(p.name + ': đúng ' + p.ok + '/' + p.n + ' câu; ' + bits.join(', ') + '.' +
        (tp.length ? ' Dạng hay sai: ' + tp.map(function (T) { return T.name + ' (' + T.wrong.length + ')'; }).join('; ') + '.' : ''));
    });
    if (easyD >= 10 && pc(easyOk, easyD) < 70) {
      out.weaknesses.push('Nền tảng chưa vững: trong số câu Nhận biết và Thông hiểu đã làm, bạn chỉ đúng ' + pc(easyOk, easyD) + '%. Đây là nhóm câu lấy điểm chắc chắn, nên ôn lại lí thuyết và dạng bài cơ bản trước khi luyện câu khó.');
    } else if (hardD >= 8 && pc(hardOk, hardD) < 40) {
      out.weaknesses.push('Câu Vận dụng và Vận dụng cao chỉ đúng ' + pc(hardOk, hardD) + '% số câu đã làm. Hãy luyện thêm dạng bài nhiều bước và câu cần kết hợp nhiều kiến thức.');
    }
    var tagList = Object.keys(tags).sort(function (a, b) { return tags[b] - tags[a]; }).slice(0, 3);
    if (tagList.length && wrongAll >= 3) out.weaknesses.push('Kiểu lỗi hay gặp trong bài này: ' + tagList.map(function (t) { return t + ' (' + tags[t] + ' lần)'; }).join('; ') + '. Hãy đọc lời giải các câu liên quan để nhận ra mình nhầm ở bước nào.');
    if (res.auto) out.weaknesses.push('Bài bị nộp tự động khi hết giờ. Hãy phân bổ khoảng 1 phút 15 giây cho mỗi câu, câu nào quá 2 phút thì đánh dấu bỏ qua và quay lại sau.');
    else if (blankAll >= 6) out.weaknesses.push('Bạn bỏ trống ' + blankAll + ' câu' + (used < limit * 0.5 ? ' và nộp sau ' + mmss(used) + ' (chưa đến một nửa thời gian)' : '') + '. Đề trắc nghiệm không trừ điểm câu sai, hãy loại trừ bớt đáp án rồi chọn, đừng để trống.');
    else if (used < limit * 0.5 && allPct < 60) out.weaknesses.push('Bạn nộp bài sau ' + mmss(used) + ' (chưa đến một nửa thời gian) nhưng còn nhiều câu sai. Hãy dành thêm thời gian đọc kĩ đề và rà soát lại trước khi nộp.');

    // 4) Lộ trình
    var focusSrc = plist.filter(function (p) { return (p.wrong.length + p.blank.length >= 3) && !(partial && p.done === 0); })
      .sort(function (a, b) { return (b.n - b.ok) / b.n - (a.n - a.ok) / a.n; }).slice(0, 2);
    focusSrc.forEach(function (p, i) {
      var miss = p.blank.length > p.wrong.length && p.blank.length >= p.n * 0.5;
      out.plan.push('Ưu tiên ' + (i + 1) + ' – ' + p.name + ': ' + (miss ? 'phần này còn nhiều câu chưa làm, hãy luyện giải đề có giới hạn thời gian cho riêng phần này. ' + PART_TIPS[p.key].charAt(0).toUpperCase() + PART_TIPS[p.key].slice(1) : PART_TIPS[p.key]));
    });
    var tops = Object.keys(topics).map(function (k) { return topics[k]; })
      .sort(function (a, b) { return b.wrong.length - a.wrong.length; }).filter(function (T) { return T.wrong.length >= 2; }).slice(0, 3);
    if (tops.length) out.plan.push('Ôn lại các dạng: ' + tops.map(function (T) {
      var sk = Object.keys(T.skills).slice(0, 2);
      return T.name + ' (' + T.wrong.length + ' câu sai' + (sk.length ? '; kĩ năng: ' + sk.join(', ') : '') + ')';
    }).join('; ') + '.');
    if (wrongAll + blankAll > 0) out.plan.push('Mở tab "Câu sai và bỏ trống" bên dưới, đọc lời giải từng câu, rồi tự làm lại mà không nhìn đáp án.');
    out.plan.push('Sau 5–7 ngày, làm lại các câu sai và làm đề tiếp theo để so sánh tiến bộ' + (focusSrc[0] ? ' ở phần ' + focusSrc[0].name : '') + '.');
    return out;
  }

  function renderAnalysis(a) {
    var box = $('aiAnalysisBox');
    if (!box) return;
    box.replaceChildren();
    function add(tag, text) { var e = document.createElement(tag); e.textContent = text; box.appendChild(e); }
    function list(items, cls) {
      var ul = document.createElement('ul');
      ul.className = cls;
      items.forEach(function (t) {
        var li = document.createElement('li'), i = t.indexOf(': ');
        if (i > 0 && i < 60) {
          var b = document.createElement('strong');
          b.textContent = t.slice(0, i + 1);
          li.appendChild(b);
          li.appendChild(document.createTextNode(t.slice(i + 1)));
        } else {
          li.textContent = t;
        }
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
    add('h3', '1. Đánh giá tổng quan');
    add('p', a.overview);
    if (a.strengths.length) { add('h3', '2. Điểm mạnh'); list(a.strengths, 'ai-strength'); }
    if (a.weaknesses.length) { add('h3', '3. Điểm yếu và lỗi sai cần chú ý'); list(a.weaknesses, 'ai-weak'); }
    if (a.plan.length) { add('h3', '4. Lộ trình ôn tập đề xuất'); list(a.plan, 'ai-plan'); }
    box.hidden = false;
  }

  function showCachedAI(res) {
    var btn = $('btnAIAnalysis'), box = $('aiAnalysisBox');
    if (btn) btn.hidden = true;
    if ($('aiIntroText')) $('aiIntroText').hidden = true;
    if (!box) return;
    if (!res) { box.hidden = true; box.replaceChildren(); return; }
    renderAnalysis(analyzeLocal(res));
  }

  /* =====================================================
     12. VÒNG ĐỜI TRANG VÀ KHỞI ĐỘNG
     ===================================================== */
  // Lưu mọi thứ khi rời trang hoặc chuyển tab (bài đang làm, thời gian học, hồ sơ đám mây)
  function flushAll() {
    if (state && timerId) persist(false, true);
    if (cloudIsReady()) {
      clearTimeout(cloudWriteTimer);
      persistCloudNow();
    }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopTimeTracker();
      flushAll();
    } else {
      startTimeTracker();
      if (state && timerId) tick(); // cập nhật ngay đồng hồ sau khi quay lại tab
    }
  });
  window.addEventListener('pagehide', flushAll);

  // KaTeX nạp sau (defer): khi tải xong thì dựng lại công thức cho phần đang hiển thị
  window.addEventListener('load', function () {
    if (state && $('partBody')) typeset($('partBody'));
    if ($('resList')) typeset($('resList'));
  });

  // Khởi tạo giao diện trước khi hiển thị màn hình
initThemeSettings();

initFirebase();

if (!window.location.hash) {
  window.history.replaceState(null, '', '#/home');
}

route();

if (!document.hidden) {
  startTimeTracker();
}
})();