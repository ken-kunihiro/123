/*
 * MF帳簿点検ハイライト — 画面側
 *
 * やること
 *   1. いまどの画面か判別する（総勘定元帳／補助元帳／残高試算表／推移表）
 *   2. 表を読んで rules.js に渡し、指摘をもらう
 *   3. 指摘のあったセルを塗り、バッジを挿す。右下にまとめパネルを出す
 *   4. 「確認済み」にした指摘は store.js に記録して、次からは塗らない
 *
 * MFへの書き込みはしない。読むのは画面のHTMLと、科目名を引くためのGET APIだけ。
 */
(function () {
  'use strict';

  var R = window.MFCK_RULES;
  var S = window.MFCK_STORE;
  if (!R || !S) return;

  var PAGE = detectPage();
  if (!PAGE) return;

  var cti = null;
  var itemNames = null;      // plainId(文字列) -> 科目名
  var findings = [];
  var filterCode = null;
  var applying = false;
  var scanTimer = null;

  /* ---------------------------------------------------------------- 小道具 */

  function norm(s) {
    return String(s == null ? '' : s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  }

  function parseAmount(text) {
    var t = norm(text);
    if (!t || t === '-' || t === '—') return 0;
    var neg = /^[（(]/.test(t) || /^[△▲-]/.test(t) || /[)）]$/.test(t);
    var n = parseFloat(t.replace(/[^\d.]/g, ''));
    if (isNaN(n)) return 0;
    return neg ? -n : n;
  }

  function detectPage() {
    var p = location.pathname;
    if (/\/books\/general_ledger/.test(p)) return 'ledger';
    if (/\/books\/subsidiary_ledger/.test(p)) return 'sub_ledger';
    if (/\/balance_books\/tb_transition/.test(p)) return 'transition';
    if (/\/balance_books\/tb/.test(p)) return 'tb';
    return null;
  }

  function getCti() {
    var el = document.querySelector('input[name="cti"]');
    if (el && el.value) return el.value;
    var m = location.search.match(/[?&]cti=([^&]+)/);
    if (m) return decodeURIComponent(m[1]);
    var link = document.querySelector('a[href*="cti="]');
    if (link) {
      var mm = link.getAttribute('href').match(/[?&]cti=([^&]+)/);
      if (mm) return decodeURIComponent(mm[1]);
    }
    return null;
  }

  /* ------------------------------------------------- 科目名（元帳の見出し用） */

  /**
   * 元帳の明細行には科目名が出ないので、hidden の own_side_item_id（plainId）から引く。
   * 変換表は /api/v1/categorized_items を1日1回だけ取って chrome.storage にためる。
   */
  function loadItemNames() {
    if (itemNames) return Promise.resolve(itemNames);
    var key = 'mfck:items:' + cti;
    return new Promise(function (resolve) {
      chrome.storage.local.get(key, function (data) {
        var cached = data && data[key];
        if (cached && cached.at && (Date.now() - cached.at) < 86400000 && cached.map) {
          itemNames = cached.map;
          resolve(itemNames);
          return;
        }
        fetchItemNames().then(function (map) {
          itemNames = map;
          var obj = {};
          obj[key] = { at: Date.now(), map: map };
          chrome.storage.local.set(obj, function () { resolve(map); });
        }).catch(function () {
          itemNames = cached && cached.map ? cached.map : {};
          resolve(itemNames);
        });
      });
    });
  }

  function fetchItemNames() {
    var url = '/api/v1/categorized_items?cti=' + encodeURIComponent(cti) + '&per_page=500';
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(res.status); })
      .then(function (json) {
        // 実際のレスポンスは { data: [{ categoryName, items: [...] }], metadata }
        var groups = (json && (json.data || json.items || json.categorized_items)) || (Array.isArray(json) ? json : []);
        var map = {};
        groups.forEach(function (g) {
          var items = (g && g.items) ? g.items : [g];
          items.forEach(function (it) {
            if (!it) return;
            var pid = it.plainId != null ? it.plainId : it.plain_id;
            var name = it.label || it.name || it.display_name;
            if (pid != null && name) map[String(pid)] = name;
          });
        });
        return map;
      });
  }

  function currentLedgerAccount() {
    // hidden input（plainId）→ 変換表
    var hid = document.querySelector('input[name="own_side_item_id"], input[name*="item_id"]');
    if (hid && hid.value && itemNames && itemNames[String(hid.value)]) return itemNames[String(hid.value)];
    // 画面の見出しに科目名が出ていればそれを使う
    var h = document.querySelector('h1, h2, [class*="ledgerTitle"], [class*="pageTitle"]');
    if (h) {
      var t = norm(h.textContent);
      if (t && t.length <= 30 && !/元帳/.test(t)) return t;
    }
    return '';
  }

  /* ------------------------------------------------------------ 表の読み取り */

  /*
   * 試算表・推移表は「見出しだけのtable」と「明細だけのtable」が別々に並んでいる。
   * 明細側にはtheadが無いので、文書順でひとつ前にある同じ列数の見出しを借りてくる。
   */
  var headerRows = [];

  function collectHeaderRows() {
    headerRows = [];
    Array.prototype.forEach.call(document.querySelectorAll('table'), function (t) {
      var hs = t.querySelectorAll('thead tr');
      if (!hs.length) return;
      var h = hs[hs.length - 1];
      headerRows.push({
        table: t,
        cells: Array.prototype.map.call(h.children, function (c) { return norm(c.textContent); }),
        count: h.children.length
      });
    });
  }

  function headerCellsFor(table) {
    var hs = table.querySelectorAll('thead tr');
    if (hs.length) {
      var h = hs[hs.length - 1];
      return Array.prototype.map.call(h.children, function (c) { return norm(c.textContent); });
    }
    var body = table.querySelector('tbody tr') || table.querySelector('tr');
    if (!body) return [];
    var n = body.children.length;
    var best = null;
    headerRows.forEach(function (hr) {
      if (hr.count !== n || hr.table === table) return;
      if (hr.table.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING) best = hr;
    });
    return best ? best.cells : [];
  }

  function headerIndex(table) {
    var cells = headerCellsFor(table);
    var map = {};
    cells.forEach(function (t, i) {
      if (!t) return;
      var opposite = /相手/.test(t);
      if (map.account == null && /勘定科目|科目/.test(t) && !opposite && !/補助/.test(t)) map.account = i;
      if (map.subItem == null && /補助科目/.test(t) && !opposite) map.subItem = i;
      if (map.excise == null && /税区分|消費税/.test(t) && !opposite) map.excise = i;
      if (map.remark == null && /摘要/.test(t)) map.remark = i;
      if (map.debit == null && /借方/.test(t)) map.debit = i;
      if (map.credit == null && /貸方/.test(t)) map.credit = i;
      if (map.balance == null && /残高/.test(t) && !/前期|前月|期首/.test(t)) map.balance = i;
      if (map.no == null && /取引No|取引ID|No\./i.test(t)) map.no = i;
      if (map.date == null && /取引日|日付/.test(t)) map.date = i;
    });
    return map;
  }

  /** ヘッダーが読めなかったときの保険。CSS Modulesのクラス名（部分一致）で拾う */
  function classIndex(tr) {
    var map = {};
    var amounts = [];
    Array.prototype.forEach.call(tr.children, function (td, i) {
      var c = String(td.className || '');
      if (/colSubItem/.test(c) && map.subItem == null) map.subItem = i;
      else if (/colExcise/.test(c) && map.excise == null) map.excise = i;
      else if (/colRemark/.test(c) && map.remark == null) map.remark = i;
      else if (/colAmount/.test(c)) amounts.push(i);
    });
    if (amounts.length >= 1 && map.debit == null) map.debit = amounts[0];
    if (amounts.length >= 2 && map.credit == null) map.credit = amounts[1];
    if (amounts.length >= 3 && map.balance == null) map.balance = amounts[2];
    return map;
  }

  function cellText(tr, idx) {
    if (idx == null) return '';
    var td = tr.children[idx];
    if (!td) return '';
    // 取引No・取引日のように1セル2行のことがあるので、改行は空白として残す
    var t = norm(td.innerText);
    return t || norm(td.textContent);
  }

  /** MFは空欄を「未選択」「補助科目なし」と表示するので、空として扱う */
  function blankIfPlaceholder(text) {
    var t = norm(text);
    if (!t || t === '-' || t === '—' || /^(未選択|補助科目なし|取引先なし|なし)$/.test(t)) return '';
    return t;
  }

  function pickTables() {
    return Array.prototype.filter.call(document.querySelectorAll('table'), function (t) {
      return t.querySelectorAll('tbody tr').length > 0;
    });
  }

  /* ------------------------------------------------------------- 各画面の走査 */

  function scanLedger() {
    var out = [];
    var account = currentLedgerAccount();
    pickTables().forEach(function (table) {
      var head = headerIndex(table);
      var rows = table.querySelectorAll('tbody tr');
      Array.prototype.forEach.call(rows, function (tr) {
        if (!tr.children.length) return;
        var map = {};
        Object.keys(head).forEach(function (k) { map[k] = head[k]; });
        var byClass = classIndex(tr);
        Object.keys(byClass).forEach(function (k) { if (map[k] == null) map[k] = byClass[k]; });
        if (map.debit == null && map.credit == null) return;

        // 金額のない行（前期繰越・新規入力行・小計）は点検しない
        var debitText = cellText(tr, map.debit);
        var creditText = cellText(tr, map.credit);
        if (!debitText && !creditText) return;

        var rowAccount = cellText(tr, map.account) || account;
        var whole = norm(tr.textContent);
        var data = {
          account: rowAccount,
          subItem: blankIfPlaceholder(cellText(tr, map.subItem)),
          excise: cellText(tr, map.excise),
          remark: cellText(tr, map.remark),
          debit: parseAmount(debitText),
          credit: parseAmount(creditText),
          isCarryOver: /前期繰越|前月繰越|期首残高|翌期繰越/.test(whole) && !cellText(tr, map.no)
        };

        var ref = cellText(tr, map.no) || cellText(tr, map.date) || norm(data.remark).slice(0, 20);
        R.checkLedgerRow(data).forEach(function (f) {
          var cell = tr.children[map[f.target] != null ? map[f.target] : map.debit];
          out.push({
            code: f.code, level: f.level, text: f.text,
            account: rowAccount, ref: ref,
            label: (rowAccount ? rowAccount + ' / ' : '') + ref,
            el: cell || tr
          });
        });
      });
    });
    return out;
  }

  function scanTrial() {
    var out = [];
    pickTables().forEach(function (table) {
      var head = headerIndex(table);
      if (head.balance == null) return;
      Array.prototype.forEach.call(table.querySelectorAll('tbody tr'), function (tr) {
        if (!tr.children.length) return;
        var name = cellText(tr, head.account != null ? head.account : 0);
        if (!name || /合計|計$/.test(name)) return;
        var data = { name: name, balance: parseAmount(cellText(tr, head.balance)) };
        R.checkTrialRow(data).forEach(function (f) {
          out.push({
            code: f.code, level: f.level, text: f.text,
            account: name, ref: name, label: name,
            el: tr.children[head.balance] || tr
          });
        });
      });
    });
    return out;
  }

  function scanTransition() {
    var out = [];
    pickTables().forEach(function (table) {
      var cells = headerCellsFor(table);
      if (!cells.length) return;

      // 月の列だけを拾う（決算整理・合計・構成比は対象外）
      var months = [];
      cells.forEach(function (t, i) {
        if (!t || i === 0) return;
        if (/合計|累計|平均|構成比|前年|前期/.test(t)) return;
        if (/\d+\s*月|\d{4}\/\d{1,2}|\d{1,2}\/\d{1,2}/.test(t)) months.push({ index: i, label: t });
      });
      if (months.length < 3) return;

      var names = [];
      var rows = Array.prototype.filter.call(table.querySelectorAll('tbody tr'), function (tr) {
        return tr.children.length > months[months.length - 1].index;
      });
      rows.forEach(function (tr) { names.push(cellText(tr, 0)); });
      var isBS = names.some(function (n) { return /資本金|繰越利益剰余金|利益剰余金|資産合計|負債合計|純資産/.test(n); });

      rows.forEach(function (tr) {
        var name = cellText(tr, 0);
        if (!name || /合計|計$/.test(name)) return;
        var values = months.map(function (m) { return parseAmount(cellText(tr, m.index)); });
        R.checkTrendRow(name, values, { isBalanceSheet: isBS }).forEach(function (f) {
          var col = months[f.index];
          out.push({
            code: f.code, level: f.level, text: f.text,
            account: name, ref: name + '@' + col.label,
            label: name + ' ' + col.label,
            el: tr.children[col.index] || tr
          });
        });
      });
    });
    return out;
  }

  /* ------------------------------------------------------------ 反映と後始末 */

  function clearMarks() {
    Array.prototype.forEach.call(document.querySelectorAll('.mfck-badge'), function (b) { b.remove(); });
    Array.prototype.forEach.call(document.querySelectorAll('.mfck-hit'), function (el) {
      el.classList.remove('mfck-hit', 'mfck-high', 'mfck-mid');
    });
  }

  function renderMarks(list) {
    var byCell = new Map();
    list.forEach(function (f) {
      if (!f.el) return;
      if (!byCell.has(f.el)) byCell.set(f.el, []);
      byCell.get(f.el).push(f);
    });

    byCell.forEach(function (items, el) {
      var open = items.filter(function (f) { return !f.done; });
      if (open.length) {
        var level = open.some(function (f) { return f.level === 'high'; }) ? 'high' : 'mid';
        el.classList.add('mfck-hit', 'mfck-' + level);
      }
      var badge = document.createElement('span');
      badge.className = 'mfck-badge' + (open.length ? (open.some(function (f) { return f.level === 'high'; }) ? '' : ' mfck-badge-mid') : ' mfck-badge-done');
      badge.textContent = open.length ? '確認' + (open.length > 1 ? ' ' + open.length : '') : '済';
      badge.title = items.map(function (f) { return R.LABELS[f.code] + '：' + f.text; }).join('\n');
      badge.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        openPopover(badge, items);
      });
      el.appendChild(badge);
    });
  }

  /* ------------------------------------------------------------------- UI */

  var fab, panel, listEl, summaryEl, pop;

  function buildUI() {
    fab = document.createElement('button');
    fab.id = 'mfck-fab';
    fab.type = 'button';
    fab.addEventListener('click', function () { panel.classList.toggle('mfck-open'); });
    document.body.appendChild(fab);

    panel = document.createElement('div');
    panel.id = 'mfck-panel';
    panel.innerHTML =
      '<div class="mfck-head"><span class="mfck-title">帳簿点検</span>' +
      '<button type="button" class="mfck-close">閉じる</button></div>' +
      '<div class="mfck-summary"></div>' +
      '<div class="mfck-list"></div>' +
      '<div class="mfck-foot"><span class="mfck-note"></span>' +
      '<button type="button" class="mfck-btn mfck-btn-quiet mfck-rescan">再点検</button></div>';
    document.body.appendChild(panel);

    summaryEl = panel.querySelector('.mfck-summary');
    listEl = panel.querySelector('.mfck-list');
    panel.querySelector('.mfck-close').addEventListener('click', function () { panel.classList.remove('mfck-open'); });
    panel.querySelector('.mfck-rescan').addEventListener('click', function () { scan(); });

    pop = document.createElement('div');
    pop.id = 'mfck-pop';
    document.body.appendChild(pop);

    document.addEventListener('click', function (ev) {
      if (pop.classList.contains('mfck-open') && !pop.contains(ev.target)) closePopover();
    });
  }

  function renderPanel(list) {
    var open = list.filter(function (f) { return !f.done; });
    fab.textContent = open.length ? '点検 ' + open.length + '件' : '点検 指摘なし';
    fab.className = open.length ? '' : 'mfck-clean';

    var counts = {};
    open.forEach(function (f) { counts[f.code] = (counts[f.code] || 0) + 1; });
    summaryEl.innerHTML = '';
    Object.keys(R.LABELS).forEach(function (code) {
      if (!counts[code]) return;
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'mfck-chip' + (filterCode === code ? ' mfck-chip-on' : '');
      chip.textContent = R.LABELS[code] + ' ' + counts[code];
      chip.addEventListener('click', function () {
        filterCode = (filterCode === code) ? null : code;
        renderPanel(findings);
      });
      summaryEl.appendChild(chip);
    });

    var shown = list.filter(function (f) { return !filterCode || f.code === filterCode; });
    shown.sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.level !== b.level) return a.level === 'high' ? -1 : 1;
      return 0;
    });

    listEl.innerHTML = '';
    if (!shown.length) {
      listEl.innerHTML = '<div class="mfck-empty">この画面で気になる行は見つからなかったよ。</div>';
    }
    shown.forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'mfck-item' + (f.done ? ' mfck-item-done' : '');
      var codeCls = f.done ? 'mfck-lv-done' : (f.level === 'mid' ? 'mfck-lv-mid' : '');
      row.innerHTML =
        '<div class="mfck-item-top"><span class="mfck-item-code ' + codeCls + '"></span>' +
        '<span class="mfck-item-ref"></span></div>' +
        '<div class="mfck-item-text"></div>' +
        (f.memo ? '<div class="mfck-item-memo"></div>' : '');
      row.querySelector('.mfck-item-code').textContent = R.LABELS[f.code];
      row.querySelector('.mfck-item-ref').textContent = f.label;
      row.querySelector('.mfck-item-text').textContent = f.text;
      if (f.memo) row.querySelector('.mfck-item-memo').textContent = 'メモ：' + f.memo;
      row.addEventListener('click', function () {
        if (!f.el) return;
        f.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        f.el.classList.add('mfck-flash');
        setTimeout(function () { f.el.classList.remove('mfck-flash'); }, 1300);
      });
      listEl.appendChild(row);
    });

    panel.querySelector('.mfck-note').textContent = '全' + list.length + '件（確認済み ' + (list.length - open.length) + '）';
  }

  function openPopover(anchor, items) {
    var f = items.filter(function (x) { return !x.done; })[0] || items[0];
    pop.innerHTML =
      '<div class="mfck-pop-code"></div><div class="mfck-pop-text"></div>' +
      '<textarea placeholder="確認した内容をメモ（例：本人立替のため対象外で正）"></textarea>' +
      '<div class="mfck-pop-actions"></div>';
    pop.querySelector('.mfck-pop-code').textContent = R.LABELS[f.code] + '　' + f.label;
    pop.querySelector('.mfck-pop-text').textContent = f.text;
    var ta = pop.querySelector('textarea');
    ta.value = f.memo || '';

    var actions = pop.querySelector('.mfck-pop-actions');
    if (f.done) {
      addBtn(actions, 'メモを更新', 'mfck-btn mfck-btn-fill', function () {
        S.mark(cti, f.key, ta.value).then(function () { closePopover(); scan(); });
      });
      addBtn(actions, 'ハイライトを戻す', 'mfck-btn mfck-btn-quiet', function () {
        S.unmark(cti, f.key).then(function () { closePopover(); scan(); });
      });
    } else {
      addBtn(actions, '確認済みにする', 'mfck-btn mfck-btn-fill', function () {
        S.mark(cti, f.key, ta.value).then(function () { closePopover(); scan(); });
      });
      addBtn(actions, '閉じる', 'mfck-btn mfck-btn-quiet', function () { closePopover(); });
    }

    var rect = anchor.getBoundingClientRect();
    pop.style.top = (window.scrollY + rect.bottom + 6) + 'px';
    pop.style.left = Math.max(8, Math.min(window.scrollX + rect.left - 140, window.scrollX + document.documentElement.clientWidth - 340)) + 'px';
    pop.classList.add('mfck-open');
    ta.focus();
  }

  function addBtn(parent, label, cls, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    parent.appendChild(b);
  }

  function closePopover() {
    pop.classList.remove('mfck-open');
  }

  /* ------------------------------------------------------------------ 実行 */

  function scan() {
    if (applying) return;
    applying = true;
    try {
      clearMarks();
      collectHeaderRows();
      var raw = PAGE === 'transition' ? scanTransition()
        : PAGE === 'tb' ? scanTrial()
        : scanLedger();

      var pageKey = PAGE;
      raw.forEach(function (f) {
        f.key = S.makeKey(pageKey, f.account, f.ref, f.code);
        var saved = S.get(cti, f.key);
        f.done = !!saved;
        f.memo = saved ? saved.memo : '';
      });
      findings = raw;
      renderMarks(findings);
      renderPanel(findings);
    } finally {
      applying = false;
    }
  }

  /** バッジの付け外しなど、自分で入れた変更でMutationObserverが回り続けないようにする */
  function isOurMutation(m) {
    if (m.target && m.target.nodeType === 1 && m.target.closest &&
        m.target.closest('#mfck-panel, #mfck-pop, #mfck-fab')) return true;
    var nodes = [].concat(Array.prototype.slice.call(m.addedNodes), Array.prototype.slice.call(m.removedNodes));
    if (!nodes.length) return false;
    return nodes.every(function (n) {
      return n.nodeType === 1 && /(^|\s)mfck-/.test(String(n.className || ''));
    });
  }

  function scheduleScan() {
    if (applying) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 400);
  }

  function start() {
    cti = getCti();
    buildUI();
    var ready = (PAGE === 'ledger' || PAGE === 'sub_ledger') && cti
      ? loadItemNames()
      : Promise.resolve();
    ready.then(function () { return S.load(cti); }).then(function () {
      scan();
      var target = document.querySelector('main') || document.body;
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          if (isOurMutation(muts[i])) continue;
          scheduleScan();
          return;
        }
      }).observe(target, { childList: true, subtree: true });

      // 別タブで確認済みにしたときも追随する
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (Object.keys(changes).indexOf('mfck:' + cti) < 0) return;
        S.load(cti, true).then(scheduleScan);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
