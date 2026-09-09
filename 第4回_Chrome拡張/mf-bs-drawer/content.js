/*
 * MF BSサイドドロワー - 本体（「連携サービスから入力」画面）
 *
 * 画面右からスライドするドロワーに、消し込み対象のBS残高（営業債権・営業債務・
 * 借入金）を出す。科目行を開くと、その科目の総勘定元帳から取引先別・補助科目別の
 * 内訳を集計して表示する。
 *
 * freee版（20_事務所/tools/freee-bs-drawer）の移植。データの取り方は2系統ある。
 *   残高 … 試算表 /balance_books/tb のHTMLをパース（この画面だけはRailsのHTML）
 *   内訳 … 内部JSON API /api/v1/ledger_entries ほか（元帳画面はReactで中身が空のため）
 *
 * 通信は accounting.moneyforward.com への同一オリジンfetch（GET）のみ。
 * 書き込みは一切しないし、外部へは何も送らない。
 */
(function () {
  'use strict';

  var ROOT_ID = 'hkmf-root';
  var ORIGIN = 'https://accounting.moneyforward.com';
  var PATH_TB = '/balance_books/tb';               // 残高試算表（HTML）
  var PATH_GL = '/books/general_ledger';           // 総勘定元帳（画面リンク用）
  var PATH_SL = '/books/subsidiary_ledger';        // 補助元帳（画面リンク用）
  var API_LEDGER = '/api/v1/ledger_entries';       // 元帳明細
  var API_ITEMS = '/api/v1/categorized_items';     // 勘定科目マスター
  var API_SUBS = '/api/v1/sub_items';              // 補助科目マスター
  var API_PARTNERS = '/api/v1/trade_partners';     // 取引先マスター
  var PER_PAGE = 200;
  var MAX_LEDGER_PAGES = 20;
  var MAX_MASTER_PAGES = 20;
  var MAX_LINES_SHOWN = 200;

  // ドロワーの幅。MIN未満だと金額列が読めず、画面いっぱいまで広げるとMF側が操作できなくなる
  var DEFAULT_WIDTH = 380;
  var MIN_WIDTH = 300;
  var MIN_PAGE_LEFT = 320; // MF本文に最低限残す幅

  /*
   * 内訳の軸。けんとさんの事業所は取引先マスターを使わず補助科目に相手先名を入れる運用なので、
   * 補助科目別だけを出している（2026-09-08 けんとさん指示）。
   * 取引先別の集計自体は残してあるので、['partner', '取引先別'] を足せばタブが復活する。
   */
  var AXES = [['sub', '補助科目別']];
  var DEFAULT_AXIS = 'sub';

  var NO_PARTNER = '（取引先なし）';
  var NO_SUB = '補助科目なし';   // 試算表の表記に合わせる
  var CARRY_OVER = '前期繰越';
  var VARIOUS = '諸口';
  var CARRY_KEY = '__carry__';

  /*
   * 表示するのは「連携サービスから入力」で消し込む科目だけ。営業債権・営業債務・借入金の3つ。
   * 残高そのものを眺めるのが目的ではないので、預貯金・棚卸資産・固定資産などは出さない。
   *
   * side は残高の向き（資産＝借方プラス／負債＝貸方プラス）。
   * 増やしたいときはここに1行足す（例: 預り金・仮払金）。
   */
  var GROUPS = [
    { key: 'saiken', label: '営業債権', side: 'asset', match: /受取手形|売掛金|売掛債権|未収入金|未収金|未収収益/ },
    { key: 'saimu', label: '営業債務', side: 'liability', match: /支払手形|買掛金|未払金|未払費用/ },
    { key: 'kariire', label: '借入金', side: 'liability', match: /借入金/ }
  ];

  /*
   * 開閉・押し出しの正本はこの state。DOMから読み取ると、MFが本文を
   * 差し替えてドロワーごと消えた瞬間に「閉じている」と誤認するため。
   */
  var state = {
    cti: '',             // 事業所トークン。試算表HTMLの input[name=cti] から取る
    period: null,        // { startDate, endDate, label }
    groups: [],          // [{ key, label, side, accounts: [{name, amount, side, itemId, ledgerId}] }]
    names: { acc: {}, sub: {}, partner: {} },  // ID(22文字) → 表示名
    ledgerIdByPlain: {}, // 試算表の own_side_item_id（数値ID） → 勘定科目ID（22文字）
    ledgerIdByName: {},  // 勘定科目名 → 勘定科目ID（数値IDが取れなかったときの保険）
    loading: false,
    open: false,
    pushed: true,        // 既定は押し出す
    width: DEFAULT_WIDTH, // ドロワーの幅(px)。左端のつまみをドラッグして変えられる
    showZero: false,
    ledgerCache: {}      // 勘定科目ID → { partner: [...], sub: [...], total, diff }
  };

  /* ===================== 小物 ===================== */

  // MFの金額表記は "35,130,550" / "-17,856,500"。△・▲・括弧書きも一応拾う
  function toNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var s = String(v == null ? '' : v).replace(/[\s,¥￥円]/g, '');
    if (!s) return 0;
    var neg = /^[△▲-]/.test(s) || /^\(.*\)$/.test(s);
    s = s.replace(/^[△▲-]/, '').replace(/^\((.*)\)$/, '$1');
    var n = parseFloat(s);
    if (!isFinite(n)) return 0;
    return neg ? -n : n;
  }

  function yen(n) {
    return (n < 0 ? '-' : '') + '¥' + Math.abs(Math.round(n)).toLocaleString('ja-JP');
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function txt(node) {
    return node ? String(node.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  // ヘッダーの見出しは2段組みが改行で連結されるので、突き合わせ用に空白を全部落とす
  function tightText(node) {
    return node ? String(node.textContent || '').replace(/\s+/g, '') : '';
  }

  function cellText(cells, i) {
    return (i == null || !cells || !cells[i]) ? '' : txt(cells[i]);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function paramsOf(href) {
    return new URLSearchParams(String(href || '').split('?')[1] || '');
  }

  /*
   * 試算表だけはサーバー側で組み立てたHTMLが返る（元帳・マスターはJSON API）。
   * ログインが切れているとログイン画面のHTMLが200で返ってくるので、
   * 呼び出し側で「目当てのテーブルがあるか」を見て判定している。
   */
  function fetchDoc(url) {
    return fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'text/html' }
    }).then(function (res) {
      if (!res.ok) throw new Error('取得に失敗しました（HTTP ' + res.status + '）');
      return res.text();
    }).then(function (html) {
      return new DOMParser().parseFromString(html, 'text/html');
    });
  }

  function inputValue(doc, name) {
    var e = doc.querySelector('[name="' + name + '"]');
    if (!e) return '';
    return String(e.value || e.getAttribute('value') || '').trim();
  }

  /* ===================== 内部JSON API ===================== */

  /*
   * MFの内部APIは cti（事業所トークン）が必須。付け忘れると別事業所の数字が返るのではなく
   * エラーになるので、URLの組み立てはこの関数に一本化して付け漏れを防ぐ。
   */
  function apiUrl(path, params) {
    var u = new URL(ORIGIN + path);
    u.searchParams.set('cti', state.cti);
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] != null && params[k] !== '') u.searchParams.set(k, String(params[k]));
    });
    return u.toString();
  }

  function fetchJson(url) {
    return fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    }).then(function (res) {
      if (!res.ok) throw new Error('取得に失敗しました（HTTP ' + res.status + '）');
      return res.json();
    }).catch(function () {
      // ログインが切れているとJSONではなくHTMLが返る
      throw new Error('MFの応答を読めませんでした。ログインし直してから「再取得」を押してね。');
    });
  }

  function listOf(res) {
    if (Array.isArray(res)) return res;
    if (res && Array.isArray(res.data)) return res.data;
    return [];
  }

  function totalPages(res) {
    var p = res && res.metadata && res.metadata.pagination;
    return (p && Number(p.total_pages)) || 1;
  }

  /*
   * マスター系（補助科目・取引先）はページングで返る。1000件指定でも1ページに収まらない
   * 事業所があり得るので total_pages ぶん回す。
   */
  function fetchAllPages(path, params) {
    var out = [];
    var page = 1;

    return (function loop() {
      var q = Object.assign({}, params, { page: page, per_page: 500 });
      return fetchJson(apiUrl(path, q)).then(function (res) {
        out = out.concat(listOf(res));
        if (page >= totalPages(res) || page >= MAX_MASTER_PAGES) return out;
        page++;
        return loop();
      });
    })();
  }

  /*
   * 元帳APIが返すのはIDだけ（勘定科目・補助科目・取引先とも名前は入っていない）。
   * 内訳を人が読める形にするには、先にマスターを引いて ID→名前 の辞書を作る必要がある。
   *
   * あわせて「試算表の数値ID → 元帳APIの22文字ID」の変換表もここで作る。
   * 試算表の科目リンクは古い数値ID（own_side_item_id）で、元帳APIは22文字IDしか受け付けない。
   */
  function loadMasters() {
    return Promise.all([
      fetchJson(apiUrl(API_ITEMS, {})),
      fetchAllPages(API_SUBS, {}),
      fetchAllPages(API_PARTNERS, {})
    ]).then(function (res) {
      var acc = {};
      var sub = {};
      var partner = {};
      var byPlain = {};
      var byName = {};

      listOf(res[0]).forEach(function (cat) {
        (cat.items || []).forEach(function (it) {
          if (!it || !it.id) return;
          acc[it.id] = it.label;
          if (it.plainId != null) byPlain[String(it.plainId)] = it.id;
          if (it.label && !byName[it.label]) byName[it.label] = it.id;
        });
      });
      res[1].forEach(function (s) { if (s && s.id) sub[s.id] = s.label; });
      res[2].forEach(function (p) { if (p && p.id) partner[p.id] = p.name || p.label || ''; });

      state.names = { acc: acc, sub: sub, partner: partner };
      state.ledgerIdByPlain = byPlain;
      state.ledgerIdByName = byName;
    });
  }

  /* ===================== 会計期間 ===================== */

  /*
   * 期間の正本は試算表画面の月セレクト（month_search_from / month_search_to）。
   * freee版は「今日時点」で切っていたが、MF版は試算表が出している期間をそのまま使う。
   * 試算表と元帳で期間がずれると内訳合計が残高と合わなくなるため。
   * 月の指定は "2025/11" 形式なので、期首＝その月の1日、期末＝to月の月末に直す。
   */
  function readPeriod(doc) {
    var mf = /^(\d{4})[\/\-](\d{1,2})$/.exec(inputValue(doc, 'month_search_from'));
    var mt = /^(\d{4})[\/\-](\d{1,2})$/.exec(inputValue(doc, 'month_search_to'));
    if (!mf || !mt) return null;

    var sy = Number(mf[1]);
    var sm = Number(mf[2]);
    var ey = Number(mt[1]);
    var em = Number(mt[2]);
    var lastDay = new Date(ey, em, 0).getDate(); // em月の0日 ＝ em月の末日

    var label = '';
    var m = /\d{4}年度（[^）]*）/.exec(doc.body ? doc.body.textContent : '');
    if (m) label = m[0];

    return {
      startDate: sy + '-' + pad(sm) + '-01',
      endDate: ey + '-' + pad(em) + '-' + pad(lastDay),
      label: label
    };
  }

  /* ===================== 試算表（BS残高） ===================== */

  /*
   * 試算表のBS表とPL表は同じクラス（ca-balance-books-bs-trial-table）で、
   * ヘッダーだけを持つテーブルが各表の直前に1行ぶん入っている。
   * ヘッダー用は rows.length === 1 なので、複数行ある最初のテーブルがBS本体。
   */
  function bsTable(doc) {
    var all = doc.querySelectorAll('table.ca-balance-books-bs-trial-table');
    for (var i = 0; i < all.length; i++) {
      if (all[i].rows.length > 1) return all[i];
    }
    return null;
  }

  // 列は [科目, 前期残高, 借方金額, 貸方金額, 期末残高, 構成比]。見出しから引く
  function balanceCol(doc) {
    var head = doc.querySelector('table.ca-balance-books-double-tiered-table-thead');
    if (head && head.rows.length) {
      var cells = head.rows[0].cells;
      for (var i = 0; i < cells.length; i++) {
        if (/期末残高/.test(tightText(cells[i]))) return i;
      }
    }
    return 4;
  }

  function groupOf(name) {
    for (var i = 0; i < GROUPS.length; i++) {
      if (GROUPS[i].match.test(name)) return GROUPS[i];
    }
    return null;
  }

  /*
   * 試算表のBSは行のクラスで役割が分かれている。
   *   （クラスなし）+ label-indent-01 / -03  … 勘定科目。リンクから own_side_item_id を取る
   *   sub-item-row  + label-indent-04       … 補助科目。内訳は元帳APIから取るのでここでは使わない
   *   report-unit-summary                   … 小計・合計行。読み飛ばす
   */
  function extractGroups(doc, table) {
    var col = balanceCol(doc);
    var buckets = {};
    GROUPS.forEach(function (g) {
      buckets[g.key] = { key: g.key, label: g.label, side: g.side, accounts: [] };
    });

    var seen = {};
    var rows = table.rows;

    for (var i = 0; i < rows.length; i++) {
      var tr = rows[i];
      var c0 = tr.cells[0];
      if (!c0) continue;

      var cls = tr.className || '';
      if (/report-unit-summary/.test(cls) || /sub-item-row/.test(cls)) continue;

      var name = txt(c0);
      if (!name) continue;

      var link = c0.querySelector('a');
      var itemId = paramsOf(link ? link.getAttribute('href') : '').get('own_side_item_id') || '';

      var group = groupOf(name);
      if (!group || seen[name]) continue;
      seen[name] = true;
      buckets[group.key].accounts.push({
        name: name,
        amount: toNumber(cellText(tr.cells, col)),
        side: group.side,
        itemId: itemId,
        ledgerId: ''   // マスター取得後に埋める
      });
    }

    return GROUPS.map(function (g) {
      var b = buckets[g.key];
      b.accounts.sort(function (a, c) { return Math.abs(c.amount) - Math.abs(a.amount); });
      b.total = b.accounts.reduce(function (s, a) { return s + a.amount; }, 0);
      return b;
    });
  }

  // 試算表の数値IDを元帳APIの22文字IDに直す。取れなければ科目名で引き直す
  function attachLedgerIds(groups) {
    groups.forEach(function (g) {
      g.accounts.forEach(function (a) {
        a.ledgerId = state.ledgerIdByPlain[a.itemId] || state.ledgerIdByName[a.name] || '';
      });
    });
  }

  /*
   * cti は事業所を指すトークン。「連携サービスから入力」のURLには付いていないので、
   * 最初は付けずに試算表を叩き、返ってきたHTMLの input[name=cti] を正本にする。
   * 以降のAPI呼び出しと画面リンクにはその cti を必ず付けて、事業所の取り違えを防ぐ。
   */
  function loadBalances() {
    state.loading = true;
    render();

    var u = new URL(ORIGIN + PATH_TB);
    if (state.cti) u.searchParams.set('cti', state.cti);

    return fetchDoc(u.toString()).then(function (doc) {
      var cti = inputValue(doc, 'cti');
      if (cti) state.cti = cti;

      var period = readPeriod(doc);
      var table = bsTable(doc);
      if (!table || !period || !state.cti) {
        throw new Error('試算表を読めませんでした。MFクラウド会計にログインし直してから「再取得」を押してね。');
      }

      var groups = extractGroups(doc, table);
      state.period = period;
      state.groups = groups;
      state.ledgerCache = {};

      // マスターが揃わなくても残高だけは出す（内訳を開いたときにエラーを出す）
      return loadMasters().then(function () {
        attachLedgerIds(state.groups);
      }).catch(function () {}).then(function () {
        state.loading = false;
        render();
      });
    }).catch(function (err) {
      state.loading = false;
      state.groups = [];
      render(err && err.message ? err.message : '残高を取得できませんでした。');
    });
  }

  /* ===================== 元帳（取引先別・補助科目別の内訳） ===================== */

  function ledgerApiUrl(account, period, page) {
    return apiUrl(API_LEDGER, {
      own_side_ledger_account_id: account.ledgerId,
      recognized_at_from: period.startDate,
      recognized_at_to: period.endDate,
      is_realized: 'true',
      exclude_excise: 'true',
      page: page,
      per_page: PER_PAGE
    });
  }

  /*
   * MFの元帳「画面」のURL。絞り込みの受け付け方が画面ごとに違う（実測）。
   *   総勘定元帳 … own_side_ledger_account_id / own_side_trade_partner_id は効く。
   *                補助科目（own_side_ledger_sub_account_id）は渡しても無視される
   *   補助元帳   … own_side_ledger_sub_account_id が効く
   * そのため補助科目で絞るときだけ補助元帳に切り替える。
   *
   * filter.date を渡すと期間をその1日に狭める。明細1行から飛ぶときに使う。
   */
  function buildLedgerPageUrl(account, period, filter) {
    var subId = filter && filter.subId;
    var u = new URL(ORIGIN + (subId ? PATH_SL : PATH_GL));
    var sp = u.searchParams;
    var day = filter && filter.date;

    if (state.cti) sp.set('cti', state.cti);
    // 画面は古い数値IDでも22文字IDでも開ける。22文字を優先し、無ければ試算表のIDに落とす
    if (account.ledgerId) sp.set('own_side_ledger_account_id', account.ledgerId);
    else sp.set('own_side_item_id', account.itemId);

    if (subId) {
      sp.set('own_side_ledger_sub_account_id', subId);
      sp.set('group_by_ledger_sub_account', 'true');
    }
    if (filter && filter.partnerId) sp.set('own_side_trade_partner_id', filter.partnerId);

    sp.set('recognized_at_from', day || period.startDate);
    sp.set('recognized_at_to', day || period.endDate);
    sp.set('exclude_excise', 'true');
    sp.set('per_page', String(PER_PAGE));
    sp.set('page', '1');
    return u.toString();
  }

  // 相手勘定科目の表示。MFの元帳と同じく「勘定科目 補助科目」で出す
  function corrName(e) {
    if (e.other_side_is_various_accounts) return VARIOUS;
    var o = e.other_side || {};
    var acc = state.names.acc[o.ledger_account_id] || '';
    var sub = state.names.sub[o.ledger_sub_account_id] || '';
    if (acc && sub) return acc + ' / ' + sub;
    return acc || sub || '';
  }

  /*
   * own_side.ledger_sub_account_id / trade_partner_id には、補助科目・取引先が
   * 付いていない明細でも別のID（部門IDなど）が入って返ってくることがある。
   * マスターに無いIDは「なし」として扱う。
   */
  function knownId(id, dict) {
    return (id && Object.prototype.hasOwnProperty.call(dict, id)) ? id : '';
  }

  function normalizeEntry(e) {
    var own = e.own_side || {};
    return {
      date: String(e.recognized_at || '').slice(0, 10),
      corr: corrName(e),
      desc: String(e.remark || e.memo || '').replace(/\s+/g, ' ').trim(),
      partnerId: knownId(own.trade_partner_id, state.names.partner),
      subId: knownId(own.ledger_sub_account_id, state.names.sub),
      debit: toNumber(e.dr_value),
      credit: toNumber(e.cr_value)
    };
  }

  /*
   * 期首繰越は明細ではなく data.balance_value として1ページ目に入っている。
   * ページングの停止条件は metadata.pagination.total_pages。
   */
  function fetchLedgerAll(account, period, onProgress) {
    var rows = [];
    var carry = 0;
    var page = 1;

    return (function loop() {
      return fetchJson(ledgerApiUrl(account, period, page)).then(function (res) {
        var data = (res && res.data) || {};
        if (page === 1) carry = toNumber(data.balance_value);
        (data.ledgers || []).forEach(function (e) { rows.push(normalizeEntry(e)); });
        if (onProgress) onProgress(rows.length);

        if (page >= totalPages(res) || page >= MAX_LEDGER_PAGES) {
          return { carry: carry, rows: rows };
        }
        page++;
        return loop();
      });
    })();
  }

  function addTo(map, id, name, delta, line) {
    var b = map.get(id);
    if (!b) {
      // filterId が null の行はMFの元帳を絞り込めない（前期繰越・取引先なし・補助科目なし）
      b = { name: name, filterId: id === CARRY_KEY || !id ? null : id, amount: 0, lines: [] };
      map.set(id, b);
    }
    b.amount += delta;
    b.lines.push(line);
  }

  function sortedRows(map) {
    var rows = [];
    map.forEach(function (b) { rows.push(b); });
    rows.sort(function (a, b) { return Math.abs(b.amount) - Math.abs(a.amount); });
    return rows;
  }

  /*
   * 残高内訳＝（期首繰越）＋（期中の借方－貸方）を軸ごとに積む。
   * 負債側の科目は符号を反転して、試算表の表示金額と向きを揃える。
   * 期首繰越は科目単位でしか取れないので、freee版と同じく1バケットとして立てる。
   *
   * 同一科目内の振替（売掛金／売掛金 など）は借方・貸方が同額で1行に入って返るので、
   * 差し引き0になって落ちる。MFの元帳画面の残高の動き方と同じ。
   */
  function aggregateLedger(data, side) {
    var sign = side === 'liability' ? -1 : 1;
    var partner = new Map();
    var sub = new Map();
    var total = 0;

    if (data.carry) {
      // 繰越額は資産でも負債でも試算表と同じ向きで返るので、符号反転は掛けない
      var carryLine = { date: '', corr: '', desc: '', amount: data.carry, carry: true };
      addTo(partner, CARRY_KEY, CARRY_OVER, data.carry, carryLine);
      addTo(sub, CARRY_KEY, CARRY_OVER, data.carry, carryLine);
      total += data.carry;
    }

    data.rows.forEach(function (r) {
      var delta = (r.debit - r.credit) * sign;
      if (!delta) return;

      var line = { date: r.date, corr: r.corr, desc: r.desc, amount: delta, carry: false };
      addTo(partner, r.partnerId, state.names.partner[r.partnerId] || NO_PARTNER, delta, line);
      addTo(sub, r.subId, state.names.sub[r.subId] || NO_SUB, delta, line);
      total += delta;
    });

    return {
      partner: sortedRows(partner),
      sub: sortedRows(sub),
      total: total
    };
  }

  function loadBreakdown(account, side, onProgress) {
    var key = account.ledgerId || account.itemId || account.name;
    if (state.ledgerCache[key]) return Promise.resolve(state.ledgerCache[key]);
    if (!account.ledgerId) {
      return Promise.reject(new Error('この科目の元帳IDを取れなかったので内訳を出せません。「再取得」を押してね。'));
    }

    return fetchLedgerAll(account, state.period, onProgress).then(function (data) {
      var agg = aggregateLedger(data, side);
      agg.diff = account.amount - agg.total;
      agg.rowCount = data.rows.length;
      state.ledgerCache[key] = agg;
      return agg;
    });
  }

  /* ===================== UI ===================== */

  var ui = {};

  function buildShell() {
    var root = el('div');
    root.id = ROOT_ID;

    var handle = el('button', 'hkmf-handle', 'BS残高');
    handle.type = 'button';
    handle.title = 'BS残高ドロワーを開く';
    handle.addEventListener('click', function () { setOpen(true); });

    var drawer = el('aside', 'hkmf-drawer');
    drawer.hidden = true;

    // --- 幅を変えるつまみ（左端） ---
    var grip = el('div', 'hkmf-grip');
    grip.title = '左右にドラッグで幅を変える（ダブルクリックで既定の' + DEFAULT_WIDTH + 'pxに戻す）';
    grip.addEventListener('pointerdown', startResize);
    grip.addEventListener('dblclick', function () { setWidth(DEFAULT_WIDTH); });
    drawer.appendChild(grip);

    // --- ヘッダー ---
    var head = el('div', 'hkmf-head');
    var titleRow = el('div', 'hkmf-titlerow');
    titleRow.appendChild(el('h2', 'hkmf-title', 'BS残高'));

    var close = el('button', 'hkmf-close', '×');
    close.type = 'button';
    close.title = '閉じる';
    close.addEventListener('click', function () { setOpen(false); });
    titleRow.appendChild(close);
    head.appendChild(titleRow);

    var meta = el('p', 'hkmf-meta', '');
    head.appendChild(meta);

    var tools = el('div', 'hkmf-tools');
    var search = el('input', 'hkmf-search');
    search.type = 'search';
    search.placeholder = '科目名で絞り込み';
    search.addEventListener('input', function () { applyFilter(search.value); });
    tools.appendChild(search);

    var reload = el('button', 'hkmf-btn', '再取得');
    reload.type = 'button';
    reload.addEventListener('click', function () { loadBalances(); });
    tools.appendChild(reload);

    var pushBtn = el('button', 'hkmf-btn', '押し出す');
    pushBtn.type = 'button';
    pushBtn.title = 'MFの本文を左に寄せてドロワーと重ならないようにする';
    pushBtn.addEventListener('click', function () { setPushed(!state.pushed); });
    tools.appendChild(pushBtn);

    head.appendChild(tools);
    drawer.appendChild(head);

    // --- 通知 ---
    var notice = el('p', 'hkmf-notice');
    notice.hidden = true;
    drawer.appendChild(notice);

    // --- 一覧 ---
    var body = el('div', 'hkmf-body');
    drawer.appendChild(body);

    // --- フッター ---
    var foot = el('div', 'hkmf-foot');
    drawer.appendChild(foot);

    root.appendChild(handle);
    root.appendChild(drawer);

    ui = {
      root: root, handle: handle, drawer: drawer, grip: grip, meta: meta,
      search: search, pushBtn: pushBtn, notice: notice, body: body, foot: foot
    };
    return root;
  }

  /* ---------- 幅の変更 ---------- */

  // 画面が狭いときに広げすぎるとMF側が触れなくなるので、その場の画面幅で頭打ちにする
  function clampWidth(px) {
    var max = Math.max(MIN_WIDTH, window.innerWidth - MIN_PAGE_LEFT);
    return Math.round(Math.min(Math.max(px, MIN_WIDTH), max));
  }

  /*
   * 幅は html 要素のCSS変数として持つ。ドロワー本体の width と、
   * 押し出しモードの body の padding-right が同じ変数を見ているので、これだけで両方動く。
   */
  function applyWidth() {
    document.documentElement.style.setProperty('--hkmf-w', state.width + 'px');
  }

  function setWidth(px, options) {
    state.width = clampWidth(px);
    applyWidth();
    if (options && options.dragging) return; // ドラッグ中は書かない（離したときにまとめて保存する）
    try {
      chrome.storage.local.set({ hkmf_width: state.width });
    } catch (e) { /* 保存できなくても動作には影響しない */ }
  }

  function startResize(ev) {
    if (ev.button !== 0) return;
    ev.preventDefault();

    var move = function (e) {
      // ドロワーは右端に固定なので、幅＝画面右端からポインタまでの距離
      setWidth(window.innerWidth - e.clientX, { dragging: true });
    };
    var up = function () {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.documentElement.classList.remove('hkmf-resizing');
      if (ui.grip) ui.grip.classList.remove('hkmf-gripping');
      setWidth(state.width); // ここで保存
    };

    document.documentElement.classList.add('hkmf-resizing');
    ev.currentTarget.classList.add('hkmf-gripping');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // state の開閉・押し出しを、いま生きているDOMに反映するだけの関数
  function applyChrome() {
    applyWidth();
    ui.drawer.hidden = !state.open;
    ui.handle.hidden = state.open;
    ui.pushBtn.setAttribute('aria-pressed', state.pushed ? 'true' : 'false');
    document.documentElement.classList.toggle('hkmf-pushed', state.open && state.pushed);
  }

  function setPushed(on) {
    state.pushed = !!on;
    applyChrome();
    try {
      chrome.storage.local.set({ hkmf_pushed: state.pushed });
    } catch (e) { /* 保存できなくても動作には影響しない */ }
  }

  function setOpen(open, options) {
    state.open = !!open;
    applyChrome();
    try {
      chrome.storage.local.set({ hkmf_open: state.open });
    } catch (e) { /* 同上 */ }
    if (!state.open || state.loading) return;
    if ((options && options.reload) || !state.groups.length) loadBalances();
  }

  function applyFilter(q) {
    var needle = (q || '').trim();
    var groups = ui.body.querySelectorAll('.hkmf-group');
    for (var i = 0; i < groups.length; i++) {
      var rows = groups[i].querySelectorAll('.hkmf-row');
      var visible = 0;
      for (var j = 0; j < rows.length; j++) {
        var name = rows[j].getAttribute('data-name') || '';
        var zeroHidden = !state.showZero && rows[j].getAttribute('data-zero') === '1';
        var hit = !needle || name.indexOf(needle) !== -1;
        rows[j].hidden = !hit || zeroHidden;
        if (!rows[j].hidden) visible++;
      }
      groups[i].hidden = visible === 0;
    }
  }

  function renderMeta() {
    var p = state.period;
    if (!p) {
      ui.meta.textContent = '';
      return;
    }
    ui.meta.textContent = p.startDate + ' 〜 ' + p.endDate + (p.label ? '（' + p.label + '）' : '');
  }

  function showNotice(text, warn) {
    if (!text) {
      ui.notice.hidden = true;
      ui.notice.textContent = '';
      return;
    }
    ui.notice.hidden = false;
    ui.notice.className = 'hkmf-notice' + (warn ? ' hkmf-warn' : '');
    ui.notice.textContent = text;
  }

  function shortDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? m[2] + '/' + m[3] : (s || '');
  }

  function ledgerLink(text, account, filter) {
    var a = el('a', 'hkmf-lnlink', text);
    a.href = buildLedgerPageUrl(account, state.period, filter);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  /*
   * 内訳の1行を開いたときに出す明細。元帳は内訳集計のときに全件取ってあるので、
   * ここで追加の通信はしない（画面を行き来しないのがこの拡張の目的）。
   */
  function renderLedgerLines(container, bucket, account, axis) {
    container.textContent = '';

    // 前期繰越・取引先なし・補助科目なしのバケットは絞り込めないので科目全体に落とす
    var filter = bucket.filterId == null ? null
      : (axis === 'sub' ? { subId: bucket.filterId } : { partnerId: bucket.filterId });

    var head = el('div', 'hkmf-lnhead');
    head.appendChild(el('span', 'hkmf-lncount', bucket.lines.length + '件'));
    head.appendChild(!filter
      ? ledgerLink('MFの元帳（科目全体）', account, null)
      : ledgerLink(axis === 'sub' ? 'MFの補助元帳（この補助科目で絞込）' : 'MFの元帳（この取引先で絞込）', account, filter));
    container.appendChild(head);

    var list = el('div', 'hkmf-lnlist');
    bucket.lines.slice(0, MAX_LINES_SHOWN).forEach(function (ln) {
      var row = el('div', 'hkmf-lnrow');
      var top = el('div', 'hkmf-lntop');

      /*
       * 日付は「その日だけに絞った元帳」へのリンクにする。
       * MFの伝票は元帳の「詳細」ボタン（フォーム送信）でしか開けず直リンクを作れないが、
       * 1日に絞れば開いた先はほぼその行だけになるので、「詳細」を1回押せばたどり着く。
       */
      if (ln.carry) {
        top.appendChild(el('span', 'hkmf-lndate', CARRY_OVER));
      } else {
        var dayFilter = Object.assign({ date: ln.date }, filter || {});
        var dayLink = ledgerLink(shortDate(ln.date), account, dayFilter);
        dayLink.className = 'hkmf-lndate hkmf-lnlink';
        dayLink.title = ln.date + ' の元帳を開く（「詳細」で仕訳が出る）';
        top.appendChild(dayLink);
      }

      var corr = el('span', 'hkmf-lncorr', ln.carry ? '' : (ln.corr || '—'));
      if (ln.corr) corr.title = ln.corr;
      top.appendChild(corr);
      top.appendChild(el('span', 'hkmf-lnamount', yen(ln.amount)));
      row.appendChild(top);
      if (ln.desc) {
        var desc = el('div', 'hkmf-lndesc', ln.desc);
        desc.title = ln.desc;
        row.appendChild(desc);
      }
      list.appendChild(row);
    });
    container.appendChild(list);

    if (bucket.lines.length > MAX_LINES_SHOWN) {
      container.appendChild(el('p', 'hkmf-status', '先頭' + MAX_LINES_SHOWN + '件を表示（全' + bucket.lines.length + '件）。残りはMFの元帳で見てね。'));
    }
  }

  function renderBreakdownTable(container, agg, axis, account) {
    container.textContent = '';

    var tabs = el('div', 'hkmf-tabs');
    AXES.forEach(function (pair) {
      var b = el('button', 'hkmf-tab', pair[1]);
      b.type = 'button';
      b.setAttribute('aria-selected', axis === pair[0] ? 'true' : 'false');
      b.addEventListener('click', function () { renderBreakdownTable(container, agg, pair[0], account); });
      tabs.appendChild(b);
    });
    tabs.appendChild(ledgerLink('元帳', account, null));
    container.appendChild(tabs);

    var rows = agg[axis] || [];
    if (!rows.length) {
      container.appendChild(el('p', 'hkmf-status', 'この期間に仕訳がありません。'));
      return;
    }

    var table = el('table', 'hkmf-bdtable');
    var tbody = document.createElement('tbody');
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.className = 'hkmf-bdrow';
      tr.tabIndex = 0;
      tr.setAttribute('role', 'button');
      tr.setAttribute('aria-expanded', 'false');

      var td1 = el('td');
      td1.appendChild(el('span', 'hkmf-bdcaret', '▸'));
      var nameSpan = el('span', 'hkmf-bdname', r.name);
      if (r.name === NO_PARTNER || r.name === NO_SUB) nameSpan.className += ' hkmf-bdnone';
      td1.appendChild(nameSpan);
      var td2 = el('td', null, yen(r.amount));
      tr.appendChild(td1);
      tr.appendChild(td2);
      tbody.appendChild(tr);

      // 明細はクリックされるまで描かない（内訳行が多い科目で重くならないように）
      var detail = document.createElement('tr');
      detail.className = 'hkmf-lndetail';
      detail.hidden = true;
      var cell = el('td', 'hkmf-lncell');
      cell.colSpan = 2;
      detail.appendChild(cell);
      tbody.appendChild(detail);

      function toggle() {
        if (detail.hidden) {
          if (!cell.childNodes.length) renderLedgerLines(cell, r, account, axis);
          detail.hidden = false;
          tr.setAttribute('aria-expanded', 'true');
          td1.querySelector('.hkmf-bdcaret').textContent = '▾';
        } else {
          detail.hidden = true;
          tr.setAttribute('aria-expanded', 'false');
          td1.querySelector('.hkmf-bdcaret').textContent = '▸';
        }
      }

      tr.addEventListener('click', toggle);
      tr.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });

    var trTotal = document.createElement('tr');
    trTotal.className = 'hkmf-bdtotal';
    trTotal.appendChild(el('td', null, '内訳合計'));
    trTotal.appendChild(el('td', null, yen(agg.total)));
    tbody.appendChild(trTotal);

    table.appendChild(tbody);
    container.appendChild(table);

    // 試算表の残高と内訳合計が合わないときは黙って隠さず、差額を出す
    if (Math.round(agg.diff) !== 0) {
      container.appendChild(el('p', 'hkmf-status', '試算表残高との差額 ' + yen(agg.diff) + '（元帳 ' + agg.rowCount + '行を集計）。期間の設定か元帳の取得件数を確認してね。'));
    }
  }

  function toggleBreakdown(row, panel, account, side) {
    if (!panel.hidden) {
      panel.hidden = true;
      row.querySelector('.hkmf-caret').textContent = '▸';
      return;
    }

    panel.hidden = false;
    row.querySelector('.hkmf-caret').textContent = '▾';

    panel.textContent = '';
    var status = el('p', 'hkmf-status', '元帳を取得中…');
    panel.appendChild(status);

    loadBreakdown(account, side, function (loaded) {
      status.textContent = '元帳を取得中… ' + loaded + '行';
    }).then(function (agg) {
      renderBreakdownTable(panel, agg, DEFAULT_AXIS, account);
    }).catch(function (err) {
      panel.textContent = '';
      panel.appendChild(el('p', 'hkmf-status', (err && err.message) || '元帳を取得できませんでした。'));
    });
  }

  function renderGroups() {
    ui.body.textContent = '';
    var zeroCount = 0;

    state.groups.forEach(function (g) {
      if (!g.accounts.length) return;

      var section = el('section', 'hkmf-group');
      var head = el('div', 'hkmf-grouphead');
      head.appendChild(el('span', 'hkmf-groupname', g.label));
      head.appendChild(el('span', 'hkmf-groupsum', yen(g.total)));
      section.appendChild(head);

      g.accounts.forEach(function (account) {
        var isZero = Math.round(account.amount) === 0;
        if (isZero) zeroCount++;

        var row = el('button', 'hkmf-row');
        row.type = 'button';
        row.setAttribute('data-name', account.name);
        row.setAttribute('data-zero', isZero ? '1' : '0');
        row.appendChild(el('span', 'hkmf-caret', '▸'));
        row.appendChild(el('span', 'hkmf-name', account.name));
        row.appendChild(el('span', 'hkmf-amount' + (isZero ? ' hkmf-zero' : ''), yen(account.amount)));

        var panel = el('div', 'hkmf-breakdown');
        panel.hidden = true;

        row.addEventListener('click', function () { toggleBreakdown(row, panel, account, account.side || g.side); });

        section.appendChild(row);
        section.appendChild(panel);
      });

      ui.body.appendChild(section);
    });

    renderFoot(zeroCount);
    applyFilter(ui.search.value);
  }

  function renderFoot(zeroCount) {
    ui.foot.textContent = '';
    if (!zeroCount) return;
    var toggle = el('button', 'hkmf-btn', state.showZero ? '残高0の科目を隠す' : '残高0の科目 ' + zeroCount + '件を表示');
    toggle.type = 'button';
    toggle.addEventListener('click', function () {
      state.showZero = !state.showZero;
      applyFilter(ui.search.value);
      renderFoot(zeroCount);
    });
    ui.foot.appendChild(toggle);
  }

  function render(errorMessage) {
    renderMeta();

    if (errorMessage) {
      showNotice(errorMessage, true);
      ui.body.textContent = '';
      return;
    }

    if (state.loading) {
      showNotice('');
      ui.body.textContent = '';
      ui.body.appendChild(el('p', 'hkmf-status', '残高を取得中…'));
      return;
    }

    showNotice('');
    renderGroups();
  }

  /* ===================== 入力中の科目に連動したハイライト ===================== */

  var lastHit = null;

  function highlightByText(text) {
    var needle = (text || '').trim();
    if (needle.length < 2) return;

    var rows = ui.body.querySelectorAll('.hkmf-row');
    var target = null;
    for (var i = 0; i < rows.length; i++) {
      var name = rows[i].getAttribute('data-name') || '';
      if (name === needle || name.indexOf(needle) === 0) { target = rows[i]; break; }
    }
    if (!target || target === lastHit) return;

    if (lastHit) lastHit.classList.remove('hkmf-hit');
    // 0円で隠れている行に当たったときは、その行だけ見えるようにする
    if (target.hidden) target.hidden = false;
    target.classList.add('hkmf-hit');
    target.scrollIntoView({ block: 'nearest' });
    lastHit = target;
  }

  function watchAccountInput() {
    var handler = function (ev) {
      if (ui.drawer.hidden) return;
      var t = ev.target;
      if (!t || ui.root.contains(t)) return;
      var tag = (t.tagName || '').toLowerCase();
      if (tag !== 'input' && tag !== 'textarea') return;
      highlightByText(t.value);
    };
    document.addEventListener('input', handler, true);
    document.addEventListener('focusin', handler, true);
  }

  /* ===================== 起動 ===================== */

  /*
   * ドロワーを組み立てて、いまの state をそのまま反映する。
   * MFが本文を差し替えてドロワーごと消したあとの建て直しでもここを通るので、
   * すでに取ってある残高は render() で新しいDOMに描き直す。
   */
  function mount() {
    if (document.getElementById(ROOT_ID)) return;
    document.body.appendChild(buildShell());
    applyChrome();
    if (state.open && (state.groups.length || state.loading)) render();
  }

  /*
   * 保存しておいた開閉状態を復元する。ここを通るのはページの読み込み時だけなので
   * （F5での再読み込みも含む）、開いた状態で戻ってきたら残高は必ず取り直す。
   */
  function restore() {
    var apply = function (data) {
      state.pushed = !(data && data.hkmf_pushed === false); // 既定は押し出す
      state.width = clampWidth(toNumber(data && data.hkmf_width) || DEFAULT_WIDTH);
      setOpen(!!(data && data.hkmf_open), { reload: true });
    };
    try {
      chrome.storage.local.get(['hkmf_open', 'hkmf_pushed', 'hkmf_width'], apply);
    } catch (e) {
      apply(null);
    }
  }

  function boot() {
    mount();
    watchAccountInput(); // document に付ける監視なので、建て直しでは重複させない
    restore();

    // 明細の絞り込みなどで本文を差し替えられてドロワーごと消えたら建て直す
    var observer = new MutationObserver(function () {
      if (!document.getElementById(ROOT_ID)) mount();
    });
    observer.observe(document.body, { childList: true });

    /*
     * ブラウザの戻る／進むでbfcacheから復帰したときは、スクリプトが動き直さない。
     * 残高が古いまま見えるのを避けるため、ここでも取り直す。
     */
    window.addEventListener('pageshow', function (ev) {
      if (ev.persisted && state.open) loadBalances();
    });

    // ウィンドウを狭くしたときにドロワーが画面を占領しないよう、その都度上限に収める
    window.addEventListener('resize', function () {
      var next = clampWidth(state.width);
      if (next !== state.width) {
        state.width = next;
        applyWidth();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
