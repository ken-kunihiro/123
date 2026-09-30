/*
 * MF帳簿点検ハイライト — 判定ルール
 *
 * DOMに触らない純粋ロジックだけを置く。画面の読み取りと描画は content.js の担当。
 * 観点を足すときは CODES / LABELS にコードを1行足して、対応する check 関数を書く。
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ 観点 */

  var CODES = {
    NEG: 'neg',            // マイナス金額
    SUBITEM: 'subitem',    // 補助科目の未選択（営業債権・債務）
    EXCISE: 'excise',      // 消費税区分の疑い
    THRESHOLD: 'threshold',// 消耗品費・修繕費の高額
    TB_NEG: 'tbneg',       // 試算表の残高が逆向き
    TREND: 'trend',        // トレンド崩れ
    FIXED: 'fixed'         // 固定費のブレ
  };

  var LABELS = {
    neg: 'マイナス金額',
    subitem: '補助科目の未選択',
    excise: '消費税区分',
    threshold: '消耗品費・修繕費',
    tbneg: '残高が逆向き',
    trend: 'トレンド崩れ',
    fixed: '固定費のブレ'
  };

  /* -------------------------------------------------------------- 科目リスト */

  /*
   * 事務所の運用: MFでは取引先マスタを使わず、補助科目に取引先名を入れる。
   * そのため取引先欄の空欄は指摘せず、営業債権・債務の補助科目なしだけを見る。
   * （借入金の金融機関別など、補助科目を分けたい科目が他にもあればここに足す）
   */
  var SUBITEM_REQUIRED = [
    '売掛金', '売上債権', '受取手形', '電子記録債権', '未収入金', '未収金',
    '買掛金', '支払手形', '電子記録債務', '未払金',
    '前受金', '前渡金', '前払金'
  ];

  // 課税仕入であるはずの科目。対象外・非課税・未設定なら指摘する
  var EXPECT_TAXABLE_HIGH = [
    '会議費', '消耗品費', '事務用品費', '修繕費', '広告宣伝費',
    '荷造運賃', '荷造発送費', '車両費', '新聞図書費', '図書費'
  ];
  // 同じく課税寄りだが、対象外・非課税が正しいこともある科目（弱めに出す）
  var EXPECT_TAXABLE_MID = [
    '旅費交通費', '交際費', '接待交際費', '支払手数料', '外注費', '業務委託費',
    '地代家賃', '賃借料', 'リース料', '研修費', '採用教育費', '販売促進費', '雑費'
  ];

  // 不課税・非課税であるはずの科目。課税になっていたら指摘する
  var EXPECT_NON_TAXABLE = [
    '給料手当', '給与手当', '役員報酬', '賞与', '雑給', '専従者給与',
    '法定福利費', '租税公課', '減価償却費', '支払利息', '保険料',
    '寄付金', '寄附金', '現金過不足', '貸倒損失', '退職金', '退職給付費用'
  ];

  // 軽減8%がありうる科目（ここ以外で8%を見たら旧税率か誤用を疑う）
  var REDUCED_OK = ['会議費', '交際費', '接待交際費', '福利厚生費', '消耗品費', '新聞図書費', '雑費', '仕入高', '売上高'];

  // 通信費は海外SaaSの対象外計上が正しいことが多いので、税区分チェックの対象にしない
  var EXCISE_SKIP = ['通信費', '支払報酬', '支払報酬料', '諸会費', '福利厚生費'];

  // 毎月ほぼ同額であるべき科目（ブレの許容 5%）
  var FIXED_STRICT = ['役員報酬', '地代家賃', '賃借料', 'リース料', '保険料', '減価償却費'];
  // 定額寄りだが季節変動がある科目（ブレの許容 25%）
  var FIXED_LOOSE = ['通信費', '水道光熱費', '諸会費', '法定福利費', '給料手当', '給与手当'];

  function hit(list, name) {
    if (!name) return false;
    for (var i = 0; i < list.length; i++) {
      if (name.indexOf(list[i]) >= 0) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------ 税区分の分類 */

  /**
   * MFの税区分表示（「課対仕入 10%」「対象外」「非課税売上」など）をざっくり分類する。
   * 表記ゆれに強くするため、細かい区分名ではなくキーワードで判定する。
   */
  function classifyExcise(text) {
    var t = String(text || '').replace(/\s+/g, '');
    if (!t) return 'none';
    if (/対象外|不課税/.test(t)) return 'out';
    if (/非課/.test(t)) return 'exempt';   // 「非課税」「非課売上」「非課仕入」
    if (/免税|輸出/.test(t)) return 'zero';
    if (/課/.test(t)) return 'taxable';
    return 'other';
  }

  function exciseRate(text) {
    var m = String(text || '').match(/(\d+(?:\.\d+)?)\s*%/);
    return m ? parseFloat(m[1]) : null;
  }

  function isReduced(text) {
    return /軽減/.test(String(text || '')) || exciseRate(text) === 8;
  }

  /* -------------------------------------------------------- 元帳の明細行判定 */

  /**
   * 元帳の1行を点検する。
   * row = { account, subItem, excise, remark, debit, credit, isCarryOver }
   * 返り値は指摘の配列 [{ code, level, target, text }]
   *   target … content.js 側でどのセルを塗るかの目印（'debit'|'credit'|'subItem'|'excise'）
   */
  function checkLedgerRow(row) {
    var out = [];
    if (!row || row.isCarryOver) return out;

    var account = row.account || '';
    var debit = row.debit || 0;
    var credit = row.credit || 0;

    // 1. マイナス金額
    if (debit < 0) {
      out.push({ code: CODES.NEG, level: 'high', target: 'debit', text: '借方がマイナス計上。逆仕訳（貸方計上）にすべき取引でないか確認' });
    }
    if (credit < 0) {
      out.push({ code: CODES.NEG, level: 'high', target: 'credit', text: '貸方がマイナス計上。逆仕訳（借方計上）にすべき取引でないか確認' });
    }

    // 2. 補助科目の未選択（営業債権・債務のみ。取引先欄は運用上使わないので見ない）
    if (hit(SUBITEM_REQUIRED, account) && !row.subItem) {
      out.push({ code: CODES.SUBITEM, level: 'mid', target: 'subItem', text: '補助科目が未選択。営業債権・債務は取引先名の補助科目を入れて残高の内訳を追えるようにする' });
    }

    // 3. 消費税区分の疑い
    if (account && !hit(EXCISE_SKIP, account)) {
      var kind = classifyExcise(row.excise);
      var isExpense = hit(EXPECT_TAXABLE_HIGH, account) || hit(EXPECT_TAXABLE_MID, account);

      if (isExpense && (kind === 'out' || kind === 'exempt' || kind === 'none')) {
        var strong = hit(EXPECT_TAXABLE_HIGH, account);
        out.push({
          code: CODES.EXCISE,
          level: strong ? 'high' : 'mid',
          target: 'excise',
          text: '課税仕入であるはずの科目に「' + (row.excise || '未設定') + '」。国外取引・非課税取引でなければ課税仕入に直す'
        });
      }
      if (hit(EXPECT_NON_TAXABLE, account) && kind === 'taxable') {
        out.push({
          code: CODES.EXCISE,
          level: 'high',
          target: 'excise',
          text: '不課税・非課税であるはずの科目に「' + row.excise + '」。課税仕入になっていないか確認'
        });
      }
      if (isReduced(row.excise) && !hit(REDUCED_OK, account)) {
        out.push({
          code: CODES.EXCISE,
          level: 'mid',
          target: 'excise',
          text: '軽減8%（または旧税率8%）。飲食料品・定期購読新聞に当たらない支出でないか確認'
        });
      }
    }

    // 4. 消耗品費・修繕費の高額
    var th = checkThreshold(account, Math.abs(debit));
    if (th) out.push({ code: CODES.THRESHOLD, level: th.level, target: 'debit', text: th.text });

    return out;
  }

  function checkThreshold(account, amount) {
    if (!account || !amount) return null;
    if (/消耗品費|事務用品費/.test(account)) {
      if (amount >= 300000) return { level: 'high', text: '30万円以上。少額減価償却資産の特例（30万円未満）の範囲外。固定資産計上の要否を確認' };
      if (amount >= 200000) return { level: 'high', text: '20万円以上。一括償却資産（20万円未満）の範囲外。少額減価償却資産の特例の適用可否を確認' };
      if (amount >= 100000) return { level: 'mid', text: '10万円以上。少額減価償却資産の特例（青色・30万円未満）の適用対象かを確認' };
    }
    if (/修繕費/.test(account)) {
      if (amount >= 600000) return { level: 'high', text: '60万円以上。資本的支出との区分（形式基準60万円）を確認' };
      if (amount >= 200000) return { level: 'mid', text: '20万円以上。資本的支出との区分を確認' };
    }
    return null;
  }

  /* ------------------------------------------------------------ 試算表の判定 */

  /**
   * 試算表の科目行を点検する。MFの試算表は資産も負債も正の値で出るので、
   * 期末残高がマイナス＝残高が逆向きとみなせる。
   */
  function checkTrialRow(rowData) {
    var out = [];
    if (!rowData || !rowData.name) return out;
    if (rowData.balance < 0) {
      out.push({
        code: CODES.TB_NEG,
        level: 'high',
        target: 'balance',
        text: '期末残高が貸借の逆向き。計上もれ・二重計上・科目違いがないか元帳で確認'
      });
    }
    return out;
  }

  /* ------------------------------------------------------------ 推移表の判定 */

  function median(values) {
    var a = values.slice().sort(function (x, y) { return x - y; });
    if (!a.length) return 0;
    var mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  /**
   * 推移表の1科目（月次12列など）を点検する。
   * values は月ごとの発生額（PL）または残高（BS）。BSはトレンド判定の対象にしない。
   * 返り値 [{ code, level, index, text }] の index は月の列番号。
   */
  function checkTrendRow(name, values, opts) {
    var out = [];
    if (!name || !values || values.length < 3) return out;
    if (opts && opts.isBalanceSheet) return out;

    var nonZero = values.filter(function (v) { return v !== 0; });
    if (nonZero.length < 3) return out;      // スポット計上の科目は対象外

    var med = median(nonZero.map(Math.abs));
    if (med <= 0) return out;

    var strict = hit(FIXED_STRICT, name);
    var loose = hit(FIXED_LOOSE, name);
    var tolerance = strict ? 0.05 : (loose ? 0.25 : null);

    values.forEach(function (v, i) {
      var abs = Math.abs(v);

      // 固定費のブレ
      if (tolerance !== null) {
        if (v === 0) {
          if (med >= 30000) {
            out.push({ code: CODES.FIXED, level: 'high', index: i, text: '毎月ほぼ定額の科目なのにこの月だけ計上なし。計上もれの疑い（他の月の中央値 ' + Math.round(med).toLocaleString() + ' 円）' });
          }
          return;
        }
        var gap = Math.abs(abs - med);
        if (gap / med > tolerance && gap >= 10000) {
          out.push({
            code: CODES.FIXED,
            level: strict ? 'high' : 'mid',
            index: i,
            text: '固定費のブレ。中央値 ' + Math.round(med).toLocaleString() + ' 円に対して ' + Math.round(abs).toLocaleString() + ' 円'
          });
          return;
        }
      }

      // トレンド崩れ（全科目共通）
      if (abs > med * 3 && (abs - med) >= 100000) {
        out.push({ code: CODES.TREND, level: 'mid', index: i, text: '他の月の3倍超。中央値 ' + Math.round(med).toLocaleString() + ' 円に対して ' + Math.round(abs).toLocaleString() + ' 円' });
      } else if (abs > 0 && abs * 3 < med && (med - abs) >= 100000) {
        out.push({ code: CODES.TREND, level: 'mid', index: i, text: '他の月の1/3未満。中央値 ' + Math.round(med).toLocaleString() + ' 円に対して ' + Math.round(abs).toLocaleString() + ' 円' });
      }
    });

    return out;
  }

  window.MFCK_RULES = {
    CODES: CODES,
    LABELS: LABELS,
    classifyExcise: classifyExcise,
    exciseRate: exciseRate,
    checkLedgerRow: checkLedgerRow,
    checkTrialRow: checkTrialRow,
    checkTrendRow: checkTrendRow,
    checkThreshold: checkThreshold,
    median: median
  };
})();
