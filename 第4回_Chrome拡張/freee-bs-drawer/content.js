/*
 * freee BSサイドドロワー - 本体（「自動で経理」画面）
 *
 * 画面右からスライドするドロワーに、消し込み対象のBS残高（営業債権・営業債務・
 * 借入金）を出す。科目行を開くと、その科目の元帳から取引先別・品目別の
 * 内訳を集計して表示する。
 *
 * 通信は secure.freee.co.jp への同一オリジンfetch（GET）のみ。
 * 書き込みAPIは呼ばないし、外部へは何も送らない。
 */
(function () {
  'use strict';

  var ROOT_ID = 'hkbs-root';
  var ORIGIN = 'https://secure.freee.co.jp';
  var API_TRIAL = ORIGIN + '/api/p/reports/trial_balance_sheet';
  var API_TRIAL_ELEMENT = ORIGIN + '/api/p/reports/trial_balance_sheet_element';
  var API_LEDGER = ORIGIN + '/api/p/reports/general_ledgers/show';
  var API_FISCAL_YEARS = ORIGIN + '/api/p/fiscal_years';
  var LEDGER_PAGE = ORIGIN + '/reports/general_ledgers/show';
  var MAX_LEDGER_PAGES = 40;
  var MAX_LINES_SHOWN = 200;
  var NO_PARTNER = '（取引先なし）';
  var NO_ITEM = '（品目なし）';
  var CARRY_OVER = '前期繰越';

  /*
   * 表示するのは「自動で経理」で消し込む科目だけ。営業債権・営業債務・借入金の3つ。
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
   * 開閉・押し出しの正本はこの state。DOMから読み取ると、freeeのSPAが本文を
   * 差し替えてドロワーごと消えた瞬間に「閉じている」と誤認するため。
   */
  var state = {
    period: null,        // { fiscalYearId, yearSeq, companyId, startDate, endDate, source }
    groups: [],          // [{ key, label, side, accounts: [{name, amount, side}] }]
    loading: false,
    open: false,
    pushed: true,        // 既定は押し出す
    showZero: false,
    ledgerCache: {},     // 科目名 → { partner: [...], item: [...], total, diff }
    searchMode: 'account', // 'account' = 科目名で一覧を絞り込み ／ 'partner' = 取引先名で全科目を横断検索
    partnerIndex: null,  // 横断検索用の取引先インデックス [{ account, tags }]（tags が null は取得失敗）
    partnerIndexError: 0 // インデックス作成時に取引先内訳を取得できなかった科目数
  };

  /* ===================== 小物 ===================== */

  function toNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    if (typeof v === 'string') {
      var n = Number(v.replace(/[,\s円]/g, ''));
      return isFinite(n) ? n : 0;
    }
    return 0;
  }

  function yen(n) {
    return (n < 0 ? '-' : '') + Math.abs(Math.round(n)).toLocaleString('ja-JP') + '円';
  }

  function today() {
    var d = new Date();
    var m = String(d.getMonth() + 1);
    var day = String(d.getDate());
    return d.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (day.length < 2 ? '0' + day : day);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function fetchJson(url) {
    return fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    }).then(function (res) {
      if (!res.ok) throw new Error('取得に失敗しました（HTTP ' + res.status + '）');
      return res.json();
    });
  }

  /* ===================== 会計年度・期間の解決 ===================== */

  function readStoredPeriod() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get('hkbs_period', function (data) {
          resolve((data && data.hkbs_period) || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /*
   * 期間の正本は /api/p/fiscal_years。
   * このAPIに company_id を渡さないと「いまログインしている事業所」の年度一覧が返るので、
   * この画面（自動で経理）と必ず同じ事業所の年度になる。
   *
   * 試算表APIも元帳APIも fiscal_year（＝会計年度のID。西暦ではない）が必須で、
   * 渡さないと 400「Fiscal yearを入力してください」で落ちる。年度IDは事業所ごとの
   * 採番なので、他所から持ち込まずここで取り直すのがいちばん安全。
   */
  function fetchFiscalYears() {
    return fetchJson(API_FISCAL_YEARS).then(function (data) {
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.fiscal_years)) return data.fiscal_years;
      return [];
    });
  }

  // fy_code が start の年度は開始残高だけの枠なので候補から外す
  function usableYears(list) {
    return list.filter(function (f) {
      return f && f.id && f.start_date && f.end_date && f.fy_code !== 'start';
    });
  }

  function pickFiscalYear(list, preferredId) {
    var years = usableYears(list);
    if (!years.length) return null;

    // 試算表で見ていた年度がこの事業所の一覧にあるときだけ採用する（事業所の取り違え防止）
    if (preferredId) {
      for (var i = 0; i < years.length; i++) {
        if (String(years[i].id) === String(preferredId)) return years[i];
      }
    }

    var t = today();
    for (var j = 0; j < years.length; j++) {
      if (years[j].start_date <= t && t <= years[j].end_date) return years[j];
    }
    for (var k = 0; k < years.length; k++) {
      if (years[k].status === 'current') return years[k];
    }
    return years.slice().sort(function (a, b) { return a.end_date < b.end_date ? 1 : -1; })[0];
  }

  function resolvePeriod() {
    return Promise.all([readStoredPeriod(), fetchFiscalYears()]).then(function (res) {
      var stored = res[0];
      var preferred = stored && stored.fiscalYear;
      var fy = pickFiscalYear(res[1], preferred);
      if (!fy) throw new Error('会計年度を取得できませんでした。freeeにログインし直してから「再取得」を押してね。');

      // 基準日は「試算表で見ていた日」→「今日」の順。年度の外には出さない
      var asOf = (stored && stored.endDate) || today();
      if (asOf < fy.start_date) asOf = fy.start_date;
      if (asOf > fy.end_date) asOf = fy.end_date;

      return {
        fiscalYearId: String(fy.id),
        yearSeq: fy.year_seq != null ? String(fy.year_seq) : '',
        companyId: fy.company_id != null ? String(fy.company_id) : '',
        startDate: fy.start_date, // 内訳を期首から積むので、期間の頭は必ず期首にする
        endDate: asOf,
        source: preferred && String(preferred) === String(fy.id) ? 'captured' : 'auto'
      };
    });
  }

  /* ===================== 試算表（BS残高） ===================== */

  /*
   * company_id は意図的に渡さない。
   * 渡さなければfreeeは「いまログインしている事業所」を返すので、
   * この画面（自動で経理）と必ず同じ事業所の数字になる。
   */
  function buildTrialUrl(period) {
    var u = new URL(API_TRIAL);
    var sp = u.searchParams;
    sp.set('report_type', 'bs');
    sp.set('category', 'default');
    sp.set('display', 'default');
    sp.set('compare_type', 'none');
    sp.set('term_type', 'monthly');
    sp.set('display_group_name', '1');
    sp.set('display_account_item', '1');
    sp.set('fiscal_year', period.fiscalYearId);
    sp.set('start_date', period.startDate);
    sp.set('end_date', period.endDate);
    ['adjustment', 'approval_flow_status', 'cost_allocations', 'partner_name', 'item_name', 'section_name', 'tag_name', 'base_amount'].forEach(function (k) {
      sp.set(k, '');
    });
    return u.toString();
  }

  function colAmount(line, periodName) {
    if (!line || !Array.isArray(line.columns)) return 0;
    for (var i = 0; i < line.columns.length; i++) {
      if (line.columns[i] && line.columns[i].period === periodName) return toNumber(line.columns[i].amount);
    }
    return 0;
  }

  function lineName(line) {
    return (line.account_item_name || line.title || line.name || '').trim();
  }

  function groupOf(name) {
    for (var i = 0; i < GROUPS.length; i++) {
      if (GROUPS[i].match.test(name)) return GROUPS[i];
    }
    return null;
  }

  // 資産は借方プラス、負債は貸方プラス。freeeが entry_side を返すのでそれを優先する
  function sideOf(line, group) {
    if (line && line.entry_side === 1) return 'liability';
    if (line && line.entry_side === -1) return 'asset';
    return group ? group.side : 'asset';
  }

  /*
   * 試算表のBSは3段構造になっている。
   *   account_group           … 決算書の表示科目（例「現金及び預金」）。グループ判定はここの名前で行う
   *   breakdown_account_item  … 実際の勘定科目（例「東邦銀行」）。元帳はこの名前で引ける
   *   breakdown               … 「取引先別」「品目別」などの見出し行。金額は空なので読み飛ばす
   * 子（勘定科目）がある表示科目は子を並べ、子がない表示科目は自分自身を1行として出す。
   */
  function extractGroups(reportLines) {
    var buckets = {};
    GROUPS.forEach(function (g) {
      buckets[g.key] = { key: g.key, label: g.label, side: g.side, accounts: [] };
    });

    var seen = {};
    var group = null;   // いま見ている表示科目が属するグループ
    var side = 'asset';
    var parent = null;  // 表示科目そのもの（子が1つも来なければこれを採用する）

    function push(name, amount) {
      if (!group || !name || seen[name]) return;
      seen[name] = true;
      buckets[group.key].accounts.push({ name: name, amount: amount, side: side });
    }

    function flushParent() {
      if (parent) push(parent.name, parent.amount);
      parent = null;
    }

    for (var i = 0; i < reportLines.length; i++) {
      var line = reportLines[i];
      if (!line) continue;
      var type = line.line_type;

      if (type === 'account_group') {
        flushParent();
        var gname = lineName(line);
        group = groupOf(gname);
        side = sideOf(line, group);
        if (group) parent = { name: gname, amount: colAmount(line, 'end_date') };
        continue;
      }

      if (type === 'breakdown_account_item' || type === 'account_item') {
        if (!group) continue;
        parent = null; // 子が来た時点で、表示科目そのものは出さない
        push(lineName(line), colAmount(line, 'end_date'));
        continue;
      }

      if (type === 'breakdown') continue; // 内訳の見出し行。金額を持たない

      // title / sub_total / aggregation はグループの切れ目
      flushParent();
      group = null;
    }
    flushParent();

    return GROUPS.map(function (g) {
      var b = buckets[g.key];
      b.accounts.sort(function (a, c) { return Math.abs(c.amount) - Math.abs(a.amount); });
      b.total = b.accounts.reduce(function (s, a) { return s + a.amount; }, 0);
      return b;
    });
  }

  function loadBalances() {
    state.loading = true;
    render();

    return resolvePeriod().then(function (period) {
      state.period = period;
      return fetchJson(buildTrialUrl(period));
    }).then(function (data) {
      // 試算表APIは report_lines をトップレベルに返す（data 配下ではない）
      var lines = (data && data.report_lines) || (data && data.data && data.data.report_lines) || [];
      state.groups = extractGroups(lines);
      state.ledgerCache = {};
      state.partnerIndex = null;
      state.partnerIndexError = 0;
      state.loading = false;
      render();
    }).catch(function (err) {
      state.loading = false;
      state.groups = [];
      state.partnerIndex = null;
      render(err && err.message ? err.message : '残高を取得できませんでした。');
    });
  }

  /* ===================== 元帳（取引先別・品目別の内訳） ===================== */

  function buildLedgerUrl(accountName, period, page, perPage) {
    var u = new URL(API_LEDGER);
    var sp = u.searchParams;
    sp.set('page', String(page));
    sp.set('per_page', String(perPage));
    sp.set('start_date', period.startDate);
    sp.set('end_date', period.endDate);
    // 元帳は fiscal_year_id が年度のID、fiscal_year が西暦（year_seq）と役割が違う
    sp.set('fiscal_year_id', period.fiscalYearId);
    if (period.yearSeq) sp.set('fiscal_year', period.yearSeq);
    sp.set('name', accountName);
    sp.set('from_report', 'true');
    sp.set('include_master_name_history', 'true');
    return u.toString();
  }

  /*
   * freeeの元帳「画面」のURL。APIと同じパスの /api/p 抜きで開ける。
   *
   * 画面側だけ fiscal_year の意味が違って、西暦ではなく年度IDを入れる
   * （freee自身が総勘定元帳一覧からそう組み立てている）。APIと逆なので注意。
   *
   * 絞り込みは partner_ids / item_ids。partner_name を渡しても黙って無視されて
   * 全件が出てしまうので、必ずIDで渡す。
   *
   * filter.date を渡すと期間をその1日に狭める。明細1行から飛ぶときに使う。
   */
  function buildLedgerPageUrl(accountName, period, filter) {
    var u = new URL(LEDGER_PAGE);
    var sp = u.searchParams;
    var day = filter && filter.date;
    sp.set('start_date', day || period.startDate);
    sp.set('end_date', day || period.endDate);
    sp.set('fiscal_year_id', period.fiscalYearId);
    sp.set('fiscal_year', period.fiscalYearId);
    sp.set('name', accountName);
    if (filter && filter.partnerId) sp.set('partner_ids', filter.partnerId);
    if (filter && filter.itemId) sp.set('item_ids', filter.itemId);
    return u.toString();
  }

  // 元帳APIも models をトップレベルに返すが、念のため data 配下も見る
  function ledgerBody(json) {
    if (json && Array.isArray(json.models)) return json;
    if (json && json.data && Array.isArray(json.data.models)) return json.data;
    return { models: [], total: 0 };
  }

  /*
   * total は繰越行を含まない件数で、実際に返ってくる明細の数とは一致しない。
   * total を停止条件にすると末尾を取りこぼすので、
   * 「返ってきた件数が per_page に満たなくなったら終わり」を主の条件にする。
   */
  function pageThrough(accountName, period, perPage, total, onProgress, seed, startPage) {
    var acc = seed ? seed.slice() : [];
    var page = startPage || 1;
    return (function loop() {
      return fetchJson(buildLedgerUrl(accountName, period, page, perPage)).then(function (json) {
        var rows = ledgerBody(json).models;
        acc = acc.concat(rows);
        if (onProgress) onProgress(acc.length, total);
        if (rows.length < perPage || page >= MAX_LEDGER_PAGES) return acc;
        page++;
        return loop();
      });
    })();
  }

  function fetchLedgerAll(accountName, period, onProgress) {
    return fetchJson(buildLedgerUrl(accountName, period, 1, 500)).then(function (json) {
      var first = ledgerBody(json);
      var models = first.models.slice();
      var total = toNumber(first.total);

      // per_page=500 が効かず100件しか返らない事業所があるので、その場合は100件で回し直す
      if (models.length <= 101 && total > models.length) {
        return pageThrough(accountName, period, 100, total, onProgress);
      }

      if (models.length < 500) return models; // 1ページで出し切っている
      return pageThrough(accountName, period, 500, total, onProgress, models, 2);
    });
  }

  function pickPartner(m) {
    var v = m.partner_name || m.corresponding_partner_name || '';
    v = String(v).trim();
    return v || NO_PARTNER;
  }

  function pickItem(m) {
    var v = m.item_name || m.corresponding_item_name || '';
    v = String(v).trim();
    return v || NO_ITEM;
  }

  /*
   * freeeの元帳を絞り込んで開けるのは「その科目の行が自分で持っているID」だけ。
   * pickPartner が相手行（corresponding_*）から名前を借りてきたケースは、
   * そのIDで絞ってもfreee側は0件になるので、IDなし扱いにして科目全体の元帳に落とす。
   */
  function ownPartnerId(m) {
    return m.partner_name && m.partner_id ? String(m.partner_id) : '';
  }

  function ownItemId(m) {
    return m.item_name && m.item_id ? String(m.item_id) : '';
  }

  // 元帳の行が自分で持っている取引先／品目のID。null も 0 も「未選択」（tag_id 0）に寄せる
  function lineTagId(m, axis) {
    var v = axis === 'partner' ? m.partner_id : m.item_id;
    return String(v || 0);
  }

  // 元帳の行はフィールドが70個以上あるので、表示に使うものだけ抜いて持つ
  function slimLine(m, delta) {
    return {
      date: String(m.txn_date || ''),
      corr: String(m.corresponding_account_name || '').trim(),
      desc: String(m.deal_line_description || m.wallet_txn_description || '').trim(),
      amount: delta,
      carry: m.is_carry_over === true
    };
  }

  function addTo(map, key, delta, line, ownId) {
    var b = map.get(key);
    if (!b) {
      b = { name: key, amount: 0, lines: [], ids: {}, idMisses: 0 };
      map.set(key, b);
    }
    b.amount += delta;
    b.lines.push(line);
    if (line.carry) return; // 繰越行はIDを持たないので、絞り込み可否の判定から外す
    if (ownId) b.ids[ownId] = true;
    else b.idMisses++;
  }

  function sortedRows(map) {
    var rows = [];
    map.forEach(function (b) {
      var ids = Object.keys(b.ids);
      // 全行が同じ自前IDのときだけ、freeeの元帳を絞り込んで開ける
      b.filterId = (ids.length === 1 && b.idMisses === 0) ? ids[0] : '';
      b.none = b.name === NO_PARTNER || b.name === NO_ITEM || b.name === CARRY_OVER;
      delete b.ids;
      delete b.idMisses;
      rows.push(b);
    });
    rows.sort(function (a, b) { return Math.abs(b.amount) - Math.abs(a.amount); });
    return rows;
  }

  /*
   * 【フォールバック専用】元帳だけで内訳を積む旧方式。
   * 試算表の内訳API（trial_balance_sheet_element）が落ちたときだけ使う。
   *
   * この方式は期首残高を取引先に配れない。元帳の繰越行は科目に1行あるだけで
   * 取引先を持たないため、「前期繰越」という1バケットにまとまってしまう。
   * 科目合計は合うが、取引先ごとの残高はfreeeの画面と一致しない。
   *
   * 繰越行は debit も credit も 0 で、balance に期首残高が入る。この balance は
   * 資産でも負債でも正の値（試算表の表示と同じ向き）なので sign を掛けずに足す。
   */
  function aggregateLedger(models, side) {
    var sign = side === 'liability' ? -1 : 1;
    var partner = new Map();
    var item = new Map();
    var total = 0;

    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      if (!m) continue;
      var carry = m.is_carry_over === true;
      var delta = carry
        ? toNumber(m.balance)
        : (toNumber(m.debit) - toNumber(m.credit)) * sign;
      if (!delta) continue;

      var line = slimLine(m, delta);
      addTo(partner, carry ? CARRY_OVER : pickPartner(m), delta, line, carry ? '' : ownPartnerId(m));
      addTo(item, carry ? CARRY_OVER : pickItem(m), delta, line, carry ? '' : ownItemId(m));
      total += delta;
    }

    return { partner: sortedRows(partner), item: sortedRows(item), total: total };
  }

  /* ===================== 取引先別・品目別の残高（試算表の内訳） ===================== */

  /*
   * 内訳の金額の正本は元帳ではなく、試算表の内訳API。
   *
   * 元帳を積み上げる方式だと期首残高が科目単位でしか取れない（繰越行が科目に1行
   * だけ入る形）ので、取引先に配れず「前期繰越」という架空の1行に溜まってしまう。
   * その結果、期首から残っている債権を今期に回収しただけの取引先が、内訳では
   * マイナス残高に見える（実残高は0）という状態になっていた。
   *
   * このAPIは freee の試算表画面が科目を「取引先別」に展開したときに叩くもので、
   * 取引先ごとに 期首・借方・貸方・期末 が返る。期首がすでに配分済みなので、
   * 内訳の金額は freee の画面と必ず一致する。
   *   display=partner … 取引先別（tag_id = 取引先ID）
   *   display=item    … 品目別（tag_id = 品目ID）
   *   tag_id = 0      … 取引先／品目が付いていない行（freeeの表示は「未選択」）
   */
  function buildElementUrl(accountName, period, display) {
    var u = new URL(API_TRIAL_ELEMENT);
    var sp = u.searchParams;
    sp.set('report_type', 'bs');
    sp.set('category', 'default');
    sp.set('display', display);
    sp.set('display_group_name', '0');
    sp.set('display_account_item', '0');
    sp.set('compare_type', 'none');
    sp.set('term_type', 'monthly');
    sp.set('fiscal_year', period.fiscalYearId);
    sp.set('start_date', period.startDate);
    sp.set('end_date', period.endDate);
    sp.set('name', accountName);
    // 構成比の分母。内訳の金額には効かないので0でよい
    sp.set('base_amount', '0');
    sp.set('pre_year_base_amount', '0');
    return u.toString();
  }

  function fetchTagBalances(accountName, period, display) {
    return fetchJson(buildElementUrl(accountName, period, display)).then(function (json) {
      var tags = (json && json.report_tags) || (json && json.data && json.data.report_tags) || [];
      return tags.map(function (t) {
        return {
          id: String(t.tag_id || 0),
          name: String(t.name || t.title || '').trim(),
          start: colAmount(t, 'start_date'),
          end: colAmount(t, 'end_date')
        };
      });
    });
  }

  /* ===================== 取引先の横断検索（インデックス） ===================== */

  /*
   * 「この取引先、どの科目にいくら残ってる？」を出すためのインデックス。
   * 表示中の全科目について取引先別の内訳（試算表API）だけを取る。元帳は取らないので
   * 1科目1リクエストで済み、科目一覧と同じ精度（試算表そのもの）の金額が並ぶ。
   * 明細は行を開いたときに既存の loadBreakdown で取る。
   */
  function runPooled(items, limit, worker) {
    return new Promise(function (resolve) {
      var next = 0;
      var active = 0;
      function pump() {
        if (next >= items.length && active === 0) return resolve();
        while (active < limit && next < items.length) {
          active++;
          worker(items[next++]).then(function () {
            active--;
            pump();
          });
        }
      }
      pump();
    });
  }

  function listAccounts() {
    var accounts = [];
    state.groups.forEach(function (g) {
      g.accounts.forEach(function (a) {
        accounts.push({ name: a.name, side: a.side || g.side, amount: a.amount, group: g.label });
      });
    });
    return accounts;
  }

  function ensurePartnerIndex(onProgress) {
    if (state.partnerIndex) return Promise.resolve(state.partnerIndex);
    if (!state.period || !state.groups.length) return Promise.reject(new Error('先に残高を取得してね。'));

    var accounts = listAccounts();
    var period = state.period;
    var index = [];
    var done = 0;
    var failed = 0;

    return runPooled(accounts, 4, function (acc) {
      return fetchTagBalances(acc.name, period, 'partner').then(function (tags) {
        index.push({ account: acc, tags: tags });
      }).catch(function () {
        // 取れなかった科目は結果から落ちる。件数を控えて画面に断り書きを出す（黙って欠かさない）
        failed++;
        index.push({ account: acc, tags: null });
      }).then(function () {
        done++;
        if (onProgress) onProgress(done, accounts.length);
      });
    }).then(function () {
      state.partnerIndex = index;
      state.partnerIndexError = failed;
      return index;
    });
  }

  /*
   * 取引先名の部分一致で「取引先 → 科目行」を組み立てる。
   * 内訳APIは残高も動きも無い取引先を返さないので、ヒットするのは実際に関係のある組み合わせだけ。
   */
  function partnerHits(needle) {
    var q = (needle || '').trim().toLowerCase();
    if (!q || !state.partnerIndex) return [];

    var map = new Map();
    state.partnerIndex.forEach(function (entry) {
      if (!entry.tags) return;
      entry.tags.forEach(function (t) {
        var name = t.name || NO_PARTNER;
        if (name.toLowerCase().indexOf(q) === -1) return;
        var hit = map.get(name);
        if (!hit) {
          hit = { name: name, rows: [], top: 0 };
          map.set(name, hit);
        }
        hit.rows.push({ account: entry.account, tagId: t.id, amount: t.end, start: t.start });
      });
    });

    var hits = [];
    map.forEach(function (h) {
      h.rows.sort(function (a, b) { return Math.abs(b.amount) - Math.abs(a.amount); });
      h.top = h.rows.reduce(function (m, r) { return Math.max(m, Math.abs(r.amount)); }, 0);
      hits.push(h);
    });
    hits.sort(function (a, b) { return b.top - a.top; });
    return hits;
  }

  /*
   * バケットの金額は試算表（tags）が正本。元帳の行は明細を見せるためだけに配る。
   *
   * 配る先は「その行が自分で持っているID」だけで決める。相手行（corresponding_*）から
   * 名前を借りる推測はしない。freee側の取引先別集計は自分の行のIDで束ねているので、
   * 借り物で束ねると金額も絞り込みリンクも画面とズレるため。
   *
   * 期首残高は対応する明細行が無いので、各バケットの先頭に「前期繰越」の合成行を1本置く。
   */
  function buildBuckets(tags, models, axis, side, noneLabel) {
    var sign = side === 'liability' ? -1 : 1;
    var map = new Map();

    tags.forEach(function (t) {
      map.set(t.id, {
        name: t.name || noneLabel,
        none: t.id === '0',
        amount: t.end,
        start: t.start,
        filterId: t.id === '0' ? '' : t.id,
        lines: []
      });
    });

    models.forEach(function (m) {
      if (!m) return;
      if (m.is_carry_over === true) return; // 繰越行の金額は tags の期首として配分済み
      var delta = (toNumber(m.debit) - toNumber(m.credit)) * sign;
      if (!delta) return;

      var id = lineTagId(m, axis);
      var b = map.get(id);
      if (!b) {
        // 試算表に無いIDは来ないはずだが、来たときに明細を落とさないための受け皿
        var own = String((axis === 'partner' ? m.partner_name : m.item_name) || '').trim();
        b = { name: own || noneLabel, none: id === '0', amount: 0, start: 0, filterId: id === '0' ? '' : id, lines: [], stray: true };
        map.set(id, b);
      }
      b.lines.push(slimLine(m, delta));
    });

    var rows = [];
    map.forEach(function (b) {
      if (b.stray) {
        b.amount = b.lines.reduce(function (s, ln) { return s + ln.amount; }, 0);
        delete b.stray;
      }
      if (b.start) {
        b.lines.unshift({ date: '', corr: '', desc: '', amount: b.start, carry: true });
      }
      rows.push(b);
    });

    // 残高の大きい順。残高0でも期中に動きがあった取引先は、その動きの大きい順に続ける
    rows.sort(function (a, b) {
      var d = Math.abs(b.amount) - Math.abs(a.amount);
      return d !== 0 ? d : Math.abs(b.start) - Math.abs(a.start);
    });
    return rows;
  }

  /*
   * 内訳（試算表API 2本）と明細（元帳）をまとめて取る。
   * 試算表API が落ちたときだけ、旧方式（元帳だけの積み上げ）に落として表示する。
   * その場合は前期繰越が配分されないので、画面に断り書きを出す（黙って違う数字を出さない）。
   */
  function loadBreakdown(accountName, side, expectedAmount, onProgress) {
    if (state.ledgerCache[accountName]) return Promise.resolve(state.ledgerCache[accountName]);

    var period = state.period;
    var soft = function () { return null; };

    return Promise.all([
      fetchTagBalances(accountName, period, 'partner').catch(soft),
      fetchTagBalances(accountName, period, 'item').catch(soft),
      fetchLedgerAll(accountName, period, onProgress)
    ]).then(function (res) {
      var partnerTags = res[0];
      var itemTags = res[1];
      var models = res[2];
      var degraded = !partnerTags || !itemTags;
      var legacy = degraded ? aggregateLedger(models, side) : null;

      var agg = {
        partner: partnerTags ? buildBuckets(partnerTags, models, 'partner', side, NO_PARTNER) : legacy.partner,
        item: itemTags ? buildBuckets(itemTags, models, 'item', side, NO_ITEM) : legacy.item,
        expected: expectedAmount,
        rowCount: models.length,
        degraded: degraded
      };
      state.ledgerCache[accountName] = agg;
      return agg;
    });
  }

  /* ===================== UI ===================== */

  var ui = {};

  function buildShell() {
    var root = el('div');
    root.id = ROOT_ID;

    var handle = el('button', 'hkbs-handle', 'BS残高');
    handle.type = 'button';
    handle.title = 'BS残高ドロワーを開く';
    handle.addEventListener('click', function () { setOpen(true); });

    var drawer = el('aside', 'hkbs-drawer');
    drawer.hidden = true;

    // --- ヘッダー ---
    var head = el('div', 'hkbs-head');
    var titleRow = el('div', 'hkbs-titlerow');
    titleRow.appendChild(el('h2', 'hkbs-title', 'BS残高'));

    var close = el('button', 'hkbs-close', '×');
    close.type = 'button';
    close.title = '閉じる';
    close.addEventListener('click', function () { setOpen(false); });
    titleRow.appendChild(close);
    head.appendChild(titleRow);

    var meta = el('p', 'hkbs-meta', '');
    head.appendChild(meta);

    // 1段目: 検索モードの切替（科目名で絞り込む／取引先名で全科目を横断検索）＋入力欄
    var tools = el('div', 'hkbs-tools');

    var modes = el('div', 'hkbs-modes');
    var modeBtns = {};
    [['account', '科目'], ['partner', '取引先']].forEach(function (pair) {
      var b = el('button', 'hkbs-mode', pair[1]);
      b.type = 'button';
      b.title = pair[0] === 'partner'
        ? '取引先名で全科目を横断して残高を探す'
        : '科目名でこの一覧を絞り込む';
      b.addEventListener('click', function () { setSearchMode(pair[0]); });
      modes.appendChild(b);
      modeBtns[pair[0]] = b;
    });
    tools.appendChild(modes);

    var search = el('input', 'hkbs-search');
    search.type = 'search';
    search.placeholder = '科目名で絞り込み';
    search.addEventListener('input', function () { onSearchInput(search.value); });
    tools.appendChild(search);

    head.appendChild(tools);

    // 2段目: 再取得・押し出す
    var tools2 = el('div', 'hkbs-tools');

    var reload = el('button', 'hkbs-btn', '再取得');
    reload.type = 'button';
    reload.addEventListener('click', function () { loadBalances(); });
    tools2.appendChild(reload);

    var pushBtn = el('button', 'hkbs-btn', '押し出す');
    pushBtn.type = 'button';
    pushBtn.title = 'freeeの本文を左に寄せてドロワーと重ならないようにする';
    pushBtn.addEventListener('click', function () { setPushed(!state.pushed); });
    tools2.appendChild(pushBtn);

    head.appendChild(tools2);
    drawer.appendChild(head);

    // --- 通知 ---
    var notice = el('p', 'hkbs-notice');
    notice.hidden = true;
    drawer.appendChild(notice);

    // --- 一覧 ---
    var body = el('div', 'hkbs-body');
    drawer.appendChild(body);

    // --- フッター ---
    var foot = el('div', 'hkbs-foot');
    drawer.appendChild(foot);

    root.appendChild(handle);
    root.appendChild(drawer);

    ui = {
      root: root, handle: handle, drawer: drawer, meta: meta,
      search: search, modeBtns: modeBtns, pushBtn: pushBtn,
      notice: notice, body: body, foot: foot
    };
    updateModeButtons();
    return root;
  }

  // state の開閉・押し出しを、いま生きているDOMに反映するだけの関数
  function applyChrome() {
    ui.drawer.hidden = !state.open;
    ui.handle.hidden = state.open;
    ui.pushBtn.setAttribute('aria-pressed', state.pushed ? 'true' : 'false');
    document.documentElement.classList.toggle('hkbs-pushed', state.open && state.pushed);
  }

  function setPushed(on) {
    state.pushed = !!on;
    applyChrome();
    try {
      chrome.storage.local.set({ hkbs_pushed: state.pushed });
    } catch (e) { /* 保存できなくても動作には影響しない */ }
  }

  /*
   * reload:true を渡すと、すでに残高を持っていても取り直す。
   * F5でのページ再読み込み時に使う（そのときは state も空なので実質どちらでも同じだが、
   * 「開いたら必ず最新」を明示しておく）。
   */
  function setOpen(open, options) {
    state.open = !!open;
    applyChrome();
    try {
      chrome.storage.local.set({ hkbs_open: state.open });
    } catch (e) { /* 同上 */ }
    if (!state.open || state.loading) return;
    if ((options && options.reload) || !state.groups.length) loadBalances();
  }

  /* ===================== 検索モード ===================== */

  function updateModeButtons() {
    Object.keys(ui.modeBtns).forEach(function (key) {
      ui.modeBtns[key].setAttribute('aria-pressed', state.searchMode === key ? 'true' : 'false');
    });
  }

  function setSearchMode(mode) {
    if (state.searchMode === mode) return;
    state.searchMode = mode;
    ui.search.value = '';
    ui.search.placeholder = mode === 'partner' ? '取引先名で検索（全科目）' : '科目名で絞り込み';
    updateModeButtons();
    if (mode === 'account') render();
    else enterPartnerMode();
    ui.search.focus();
  }

  function onSearchInput(value) {
    if (state.searchMode !== 'partner') {
      applyFilter(value);
      return;
    }
    if (!state.partnerIndex) return; // 集計中。終わったら描き直す
    renderPartnerResults(value);
  }

  /*
   * 取引先モードに入った時点で全科目の取引先内訳を1回だけ取る（元帳は取らない）。
   * 以降はキーを打つたびメモリ上で絞るので、入力に即応する。
   * 残高を取り直したらインデックスも捨てているので、ここを通ると自動で作り直しになる。
   */
  function enterPartnerMode() {
    ui.foot.textContent = '';
    ui.body.textContent = '';
    var status = el('p', 'hkbs-status', '取引先を集計中…');
    ui.body.appendChild(status);

    ensurePartnerIndex(function (done, total) {
      status.textContent = '取引先を集計中… ' + done + ' / ' + total + '科目';
    }).then(function () {
      if (state.searchMode !== 'partner') return;
      renderPartnerResults(ui.search.value);
    }).catch(function (err) {
      if (state.searchMode !== 'partner') return;
      ui.body.textContent = '';
      ui.body.appendChild(el('p', 'hkbs-status', (err && err.message) || '取引先を集計できませんでした。'));
    });
  }

  function findPartnerBucket(agg, tagId) {
    var rows = (agg && agg.partner) || [];
    for (var i = 0; i < rows.length; i++) {
      // 「未選択」バケットは filterId が空文字なので、tag_id の '0' に揃えて比べる
      if (String(rows[i].filterId || '0') === String(tagId || '0')) return rows[i];
    }
    return null;
  }

  function renderPartnerFoot() {
    ui.foot.textContent = '';
    var total = state.partnerIndex ? state.partnerIndex.length : 0;
    var text = '営業債権・営業債務・借入金の全' + total + '科目から検索';
    if (state.partnerIndexError) {
      text += '（うち' + state.partnerIndexError + '科目は内訳を取得できなかったので結果に入っていないよ）';
    }
    ui.foot.appendChild(el('span', null, text));
  }

  /*
   * 取引先モードの結果。取引先ごとに「どの科目にいくら残っているか」を並べ、
   * 行を開くと科目モードと同じ明細（元帳）をそのまま出す。
   */
  function renderPartnerResults(value) {
    ui.body.textContent = '';

    var needle = (value || '').trim();
    if (!needle) {
      ui.body.appendChild(el('p', 'hkbs-status', '取引先名を入れてね。全科目を横断して、その取引先の残高がある科目を出すよ。'));
      renderPartnerFoot();
      return;
    }

    var hits = partnerHits(needle);
    if (!hits.length) {
      ui.body.appendChild(el('p', 'hkbs-status', '「' + needle + '」に一致する取引先は、この期の残高・動きの中に見つからなかったよ。'));
      renderPartnerFoot();
      return;
    }

    hits.forEach(function (hit) {
      var section = el('section', 'hkbs-group');
      var head = el('div', 'hkbs-grouphead');
      head.appendChild(el('span', 'hkbs-groupname', hit.name));
      section.appendChild(head);

      var table = el('table', 'hkbs-bdtable hkbs-ptable');
      var tbody = document.createElement('tbody');

      hit.rows.forEach(function (r) {
        var tr = document.createElement('tr');
        tr.className = 'hkbs-bdrow';
        tr.tabIndex = 0;
        tr.setAttribute('role', 'button');
        tr.setAttribute('aria-expanded', 'false');

        var td1 = el('td');
        td1.appendChild(el('span', 'hkbs-bdcaret', '▸'));
        td1.appendChild(el('span', 'hkbs-bdname', r.account.name));
        td1.appendChild(el('span', 'hkbs-bdgroup', r.account.group));
        var td2 = el('td', Math.round(r.amount) === 0 ? 'hkbs-zero' : null, yen(r.amount));
        tr.appendChild(td1);
        tr.appendChild(td2);
        tbody.appendChild(tr);

        // 明細はクリックされるまで取らない（元帳の取得は科目単位で重いため）
        var detail = document.createElement('tr');
        detail.className = 'hkbs-lndetail';
        detail.hidden = true;
        var cell = el('td', 'hkbs-lncell');
        cell.colSpan = 2;
        detail.appendChild(cell);
        tbody.appendChild(detail);

        function toggle() {
          if (!detail.hidden) {
            detail.hidden = true;
            tr.setAttribute('aria-expanded', 'false');
            td1.querySelector('.hkbs-bdcaret').textContent = '▸';
            return;
          }
          detail.hidden = false;
          tr.setAttribute('aria-expanded', 'true');
          td1.querySelector('.hkbs-bdcaret').textContent = '▾';
          if (cell.childNodes.length) return;

          var status = el('p', 'hkbs-status', '元帳を取得中…');
          cell.appendChild(status);
          loadBreakdown(r.account.name, r.account.side, r.account.amount, function (loaded, total) {
            status.textContent = '元帳を取得中… ' + loaded + (total ? ' / ' + total : '') + '行';
          }).then(function (agg) {
            var bucket = findPartnerBucket(agg, r.tagId);
            cell.textContent = '';
            if (!bucket) {
              cell.appendChild(el('p', 'hkbs-status', 'この取引先の明細が見つからなかったよ。科目モードから開いてみてね。'));
              return;
            }
            renderLedgerLines(cell, bucket, r.account.name, 'partner');
          }).catch(function (err) {
            cell.textContent = '';
            cell.appendChild(el('p', 'hkbs-status', (err && err.message) || '元帳を取得できませんでした。'));
          });
        }

        tr.addEventListener('click', toggle);
        tr.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });
      });

      table.appendChild(tbody);
      section.appendChild(table);
      ui.body.appendChild(section);
    });

    renderPartnerFoot();
  }

  function applyFilter(q) {
    var needle = (q || '').trim();
    var groups = ui.body.querySelectorAll('.hkbs-group');
    for (var i = 0; i < groups.length; i++) {
      var rows = groups[i].querySelectorAll('.hkbs-row');
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
    ui.meta.textContent = p.endDate + ' 時点（' + p.startDate + ' からの期）';
  }

  function showNotice(text, warn) {
    if (!text) {
      ui.notice.hidden = true;
      ui.notice.textContent = '';
      return;
    }
    ui.notice.hidden = false;
    ui.notice.className = 'hkbs-notice' + (warn ? ' hkbs-warn' : '');
    ui.notice.textContent = text;
  }

  function shortDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? m[2] + '/' + m[3] : (s || '');
  }

  function ledgerLink(text, accountName, filter) {
    var a = el('a', 'hkbs-lnlink', text);
    a.href = buildLedgerPageUrl(accountName, state.period, filter);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  /*
   * 内訳の1行を開いたときに出す明細。元帳は内訳集計のときに全件取ってあるので、
   * ここで追加のAPIは叩かない（画面を行き来しないのがこの拡張の目的）。
   */
  function renderLedgerLines(container, bucket, accountName, axis) {
    container.textContent = '';

    var head = el('div', 'hkbs-lnhead');
    // 先頭の前期繰越は残高を見せるための合成行なので、件数には数えない
    var moves = bucket.lines.filter(function (ln) { return !ln.carry; }).length;
    head.appendChild(el('span', 'hkbs-lncount', moves + '件'));
    if (bucket.filterId) {
      var f = {};
      f[axis === 'partner' ? 'partnerId' : 'itemId'] = bucket.filterId;
      head.appendChild(ledgerLink('freeeの元帳（この' + (axis === 'partner' ? '取引先' : '品目') + 'で絞込）', accountName, f));
    } else {
      head.appendChild(ledgerLink('freeeの元帳（科目全体）', accountName, null));
    }
    container.appendChild(head);

    var list = el('div', 'hkbs-lnlist');
    bucket.lines.slice(0, MAX_LINES_SHOWN).forEach(function (ln) {
      var row = el('div', 'hkbs-lnrow');
      var top = el('div', 'hkbs-lntop');

      /*
       * 日付は「その日だけに絞った元帳」へのリンクにする。
       * freeeの伝票（取引の詳細）はモーダルで固有URLを持たないので、直リンクは作れない。
       * ただし日付＋取引先／品目まで絞れば開いた先はほぼその1行になるので、
       * 元帳の「詳細」ボタンを1回押せば伝票にたどり着く。
       */
      if (ln.carry) {
        top.appendChild(el('span', 'hkbs-lndate', CARRY_OVER));
      } else {
        var dayFilter = { date: ln.date };
        if (bucket.filterId) dayFilter[axis === 'partner' ? 'partnerId' : 'itemId'] = bucket.filterId;
        var dayLink = ledgerLink(shortDate(ln.date), accountName, dayFilter);
        dayLink.className = 'hkbs-lndate hkbs-lnlink';
        dayLink.title = ln.date + ' の元帳を開く（「詳細」で伝票が出る）';
        top.appendChild(dayLink);
      }

      var corr = el('span', 'hkbs-lncorr', ln.carry ? '' : (ln.corr || '—'));
      if (ln.corr) corr.title = ln.corr;
      top.appendChild(corr);
      top.appendChild(el('span', 'hkbs-lnamount', yen(ln.amount)));
      row.appendChild(top);
      if (ln.desc) {
        var desc = el('div', 'hkbs-lndesc', ln.desc);
        desc.title = ln.desc;
        row.appendChild(desc);
      }
      list.appendChild(row);
    });
    container.appendChild(list);

    if (bucket.lines.length > MAX_LINES_SHOWN) {
      container.appendChild(el('p', 'hkbs-status', '先頭' + MAX_LINES_SHOWN + '件を表示（全' + bucket.lines.length + '件）。残りはfreeeの元帳で見てね。'));
    }
  }

  function renderBreakdownTable(container, agg, axis, accountName) {
    container.textContent = '';

    var tabs = el('div', 'hkbs-tabs');
    [['partner', '取引先別'], ['item', '品目別']].forEach(function (pair) {
      var b = el('button', 'hkbs-tab', pair[1]);
      b.type = 'button';
      b.setAttribute('aria-selected', axis === pair[0] ? 'true' : 'false');
      b.addEventListener('click', function () { renderBreakdownTable(container, agg, pair[0], accountName); });
      tabs.appendChild(b);
    });
    tabs.appendChild(ledgerLink('元帳', accountName, null));
    container.appendChild(tabs);

    var rows = agg[axis] || [];
    var total = rows.reduce(function (sum, r) { return sum + r.amount; }, 0);
    var diff = toNumber(agg.expected) - total;

    if (!rows.length) {
      container.appendChild(el('p', 'hkbs-status', 'この期間に仕訳がありません。'));
      return;
    }

    var table = el('table', 'hkbs-bdtable');
    var tbody = document.createElement('tbody');
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.className = 'hkbs-bdrow';
      tr.tabIndex = 0;
      tr.setAttribute('role', 'button');
      tr.setAttribute('aria-expanded', 'false');

      var td1 = el('td');
      td1.appendChild(el('span', 'hkbs-bdcaret', '▸'));
      var nameSpan = el('span', 'hkbs-bdname', r.name);
      if (r.none) nameSpan.className += ' hkbs-bdnone';
      td1.appendChild(nameSpan);
      var td2 = el('td', null, yen(r.amount));
      tr.appendChild(td1);
      tr.appendChild(td2);
      tbody.appendChild(tr);

      // 明細はクリックされるまで描かない（内訳行が多い科目で重くならないように）
      var detail = document.createElement('tr');
      detail.className = 'hkbs-lndetail';
      detail.hidden = true;
      var cell = el('td', 'hkbs-lncell');
      cell.colSpan = 2;
      detail.appendChild(cell);
      tbody.appendChild(detail);

      function toggle() {
        if (detail.hidden) {
          if (!cell.childNodes.length) renderLedgerLines(cell, r, accountName, axis);
          detail.hidden = false;
          tr.setAttribute('aria-expanded', 'true');
          td1.querySelector('.hkbs-bdcaret').textContent = '▾';
        } else {
          detail.hidden = true;
          tr.setAttribute('aria-expanded', 'false');
          td1.querySelector('.hkbs-bdcaret').textContent = '▸';
        }
      }

      tr.addEventListener('click', toggle);
      tr.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });

    var trTotal = document.createElement('tr');
    trTotal.className = 'hkbs-bdtotal';
    trTotal.appendChild(el('td', null, '内訳合計'));
    trTotal.appendChild(el('td', null, yen(total)));
    tbody.appendChild(trTotal);

    table.appendChild(tbody);
    container.appendChild(table);

    /*
     * 内訳の金額は試算表の内訳APIそのものなので、通常この差額は0になる。
     * 0でないときは黙って隠さず出す（フォールバック中か、freee側の仕様変更）。
     */
    if (agg.degraded) {
      container.appendChild(el('p', 'hkbs-status', '試算表の内訳を取得できなかったので、元帳の積み上げで表示しているよ。前期繰越が取引先・品目に配分されていない点に注意してね。'));
    }
    if (Math.round(diff) !== 0) {
      container.appendChild(el('p', 'hkbs-status', '試算表残高との差額 ' + yen(diff) + '（元帳 ' + agg.rowCount + '行を集計）。期間の設定か元帳の取得件数を確認してね。'));
    }
  }

  function toggleBreakdown(row, panel, account, side) {
    if (!panel.hidden) {
      panel.hidden = true;
      row.querySelector('.hkbs-caret').textContent = '▸';
      return;
    }

    panel.hidden = false;
    row.querySelector('.hkbs-caret').textContent = '▾';

    panel.textContent = '';
    var status = el('p', 'hkbs-status', '元帳を取得中…');
    panel.appendChild(status);

    loadBreakdown(account.name, side, account.amount, function (loaded, total) {
      status.textContent = '元帳を取得中… ' + loaded + (total ? ' / ' + total : '') + '行';
    }).then(function (agg) {
      renderBreakdownTable(panel, agg, 'partner', account.name);
    }).catch(function (err) {
      panel.textContent = '';
      panel.appendChild(el('p', 'hkbs-status', (err && err.message) || '元帳を取得できませんでした。'));
    });
  }

  function renderGroups() {
    ui.body.textContent = '';
    var zeroCount = 0;

    state.groups.forEach(function (g) {
      if (!g.accounts.length) return;

      var section = el('section', 'hkbs-group');
      var head = el('div', 'hkbs-grouphead');
      head.appendChild(el('span', 'hkbs-groupname', g.label));
      head.appendChild(el('span', 'hkbs-groupsum', yen(g.total)));
      section.appendChild(head);

      g.accounts.forEach(function (account) {
        var isZero = Math.round(account.amount) === 0;
        if (isZero) zeroCount++;

        var row = el('button', 'hkbs-row');
        row.type = 'button';
        row.setAttribute('data-name', account.name);
        row.setAttribute('data-zero', isZero ? '1' : '0');
        row.appendChild(el('span', 'hkbs-caret', '▸'));
        row.appendChild(el('span', 'hkbs-name', account.name));
        var amount = el('span', 'hkbs-amount' + (isZero ? ' hkbs-zero' : ''), yen(account.amount));
        row.appendChild(amount);

        var panel = el('div', 'hkbs-breakdown');
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
    var toggle = el('button', 'hkbs-btn', state.showZero ? '残高0の科目を隠す' : '残高0の科目 ' + zeroCount + '件を表示');
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
      ui.body.appendChild(el('p', 'hkbs-status', '残高を取得中…'));
      return;
    }

    showNotice('');
    // 取引先モードのまま残高を取り直したときは、インデックスも作り直して結果を描く
    if (state.searchMode === 'partner') {
      enterPartnerMode();
      return;
    }
    renderGroups();
  }

  /* ===================== 入力中の科目に連動したハイライト ===================== */

  var lastHit = null;

  function highlightByText(text) {
    if (state.searchMode !== 'account') return; // 取引先モードでは科目行が並んでいない
    var needle = (text || '').trim();
    if (needle.length < 2) return;

    var rows = ui.body.querySelectorAll('.hkbs-row');
    var target = null;
    for (var i = 0; i < rows.length; i++) {
      var name = rows[i].getAttribute('data-name') || '';
      if (name === needle || name.indexOf(needle) === 0) { target = rows[i]; break; }
    }
    if (!target || target === lastHit) return;

    if (lastHit) lastHit.classList.remove('hkbs-hit');
    // 0円で隠れている行に当たったときは、その行だけ見えるようにする
    if (target.hidden) target.hidden = false;
    target.classList.add('hkbs-hit');
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
   * freeeのSPAに本文ごと消されたあとの建て直しでもここを通るので、
   * すでに取ってある残高は render() で新しいDOMに描き直す。
   * （ここを描き直さないと、建て直しのたびに中身が空のドロワーが残る）
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
      state.pushed = !(data && data.hkbs_pushed === false); // 既定は押し出す
      setOpen(!!(data && data.hkbs_open), { reload: true });
    };
    try {
      chrome.storage.local.get(['hkbs_open', 'hkbs_pushed'], apply);
    } catch (e) {
      apply(null);
    }
  }

  function boot() {
    mount();
    watchAccountInput(); // document に付ける監視なので、建て直しでは重複させない
    restore();

    // freeeはSPAなので、画面を差し替えられてドロワーごと消えたら建て直す
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
