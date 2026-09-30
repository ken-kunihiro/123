// MF会計「連携サービスから入力」科目ボタンパネル＋「これ、何費？」検索
// 対応ページ: /transaction_journals（通帳・カード他）, /journalable_dists（ビジネスカテゴリ）,
//             /voucher_journals（AI-OCRから入力＝クラウドBoxの証憑からの仕訳候補）
//
// 使い方:
//   1. 明細行の勘定科目ボタンをクリック（ドロップダウンが開く）
//   2. パネルの科目ボタンをクリック → その科目を選択して確定
//   ドロップダウンが閉じてしまっていても、直前にクリックした勘定科目ボタンを
//   覚えているので、自動で開き直してから選択する。
//
// 実装メモ:
// - MFの勘定科目はコンボボックスでなくReact製ドロップダウン。
//   ボタンclick → body直下のポータルに [class*="dropDownListItems"] が出現し、
//   その子要素（.isSelectable）をclickすると選択・確定される（実機検証済み）。
// - パネルのボタンはmousedownでpreventDefault+stopPropagationし、
//   ページの選択テキスト解除とドロップダウンの外側クリック閉じを極力防ぐ。
//   それでも閉じた場合は lastAccountBtn から開き直すフォールバックが働く。
// - 科目リスト・パネル位置・折りたたみ状態は chrome.storage.local に保存。
//   popup.html から科目リストを編集でき、保存すると即時反映される。

(() => {
  'use strict';

  const PANEL_ID = 'mfkb-panel';
  const NANPI_URL = 'https://nanpi.pages.dev/';

  // デフォルト科目（この事業所のMF標準科目名で存在確認済みのもの）
  const DEFAULT_KAMOKU = [
    '会議費',
    '接待交際費',
    '旅費交通費',
    '通信費',
    '備品・消耗品費',
    '支払手数料',
    '広告宣伝費',
    '新聞図書費',
    '諸会費',
    '支払報酬',
  ];

  const storage = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
    ? chrome.storage.local
    : {
        // テスト注入用フォールバック（拡張外で動かすときだけ使われる）
        get: (keys, cb) => {
          const out = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            try { const v = localStorage.getItem('mfkb_' + k); if (v !== null) out[k] = JSON.parse(v); } catch (e) {}
          }
          cb(out);
        },
        set: (obj) => {
          for (const [k, v] of Object.entries(obj)) {
            try { localStorage.setItem('mfkb_' + k, JSON.stringify(v)); } catch (e) {}
          }
        },
      };

  // localStorageミラー（拡張の入れ直し等でchrome.storageが消えても設定を復元するための二重保存。
  // MFページのオリジンに保存されるので、拡張を入れ直してもリストが残る）
  const MIRROR_KEY = 'mfkbMirror';
  function mirrorRead() {
    try { return JSON.parse(localStorage.getItem(MIRROR_KEY)) || {}; } catch (e) { return {}; }
  }
  function mirrorWrite(obj) {
    try { localStorage.setItem(MIRROR_KEY, JSON.stringify(Object.assign(mirrorRead(), obj))); } catch (e) {}
  }
  function saveSettings(obj) {
    storage.set(obj);
    mirrorWrite(obj);
  }

  let kamokuList = DEFAULT_KAMOKU.slice();
  let panelPos = null; // {left, top}
  let collapsed = false;
  let lastAccountBtn = null; // 最後にクリックされた勘定科目（or 補助科目）ボタン
  let lastRow = null; // 最後に操作した明細行（なんぴ検索の候補抽出用）

  const yieldTask = () =>
    new Promise((r) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => r();
      ch.port2.postMessage(0);
    });

  async function waitFor(fn, timeoutMs) {
    const t0 = performance.now();
    let v = fn();
    while (!v && performance.now() - t0 < timeoutMs) {
      await yieldTask();
      v = fn();
    }
    return v;
  }

  // 開いている科目ドロップダウン（body直下ポータル）
  const openList = () => document.querySelector('[class*="dropDownListItems"]');

  // ---- 行・ボタンの追跡（capture段階で記録） ----
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!(e.target instanceof Element)) return;
      if (e.target.closest('#' + PANEL_ID)) return;
      const accBtn = e.target.closest(
        'td[class*="colLedgerAccount"] button, td[class*="itemAndSubItem"] button,' +
        // AI-OCRから入力（/voucher_journals）の詳細パネル。
        // 借方/貸方それぞれ[科目・補助・取引先・税区分・インボイス]が同じクラスのボタンで並ぶ。
        // どれを押しても記録し、科目以外を開いていた場合は候補なしのtoastで止まる。
        ' button[class*="selectedChoiceLabel"]'
      );
      if (accBtn) {
        lastAccountBtn = accBtn;
        lastRow = accBtn.closest('tr');
        return;
      }
      const tr = e.target.closest('table tbody tr');
      if (tr) lastRow = tr;
    },
    true
  );

  // 長めの待ちはビジーループにせず間隔をあけて見にいく（リロード直後の復帰待ち用）
  async function waitSlow(fn, timeoutMs, intervalMs) {
    const t0 = performance.now();
    let v = fn();
    while (!v && performance.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, intervalMs || 150));
      v = fn();
    }
    return v;
  }

  // ---- 科目選択 ----
  // silent: 自動選択（リロード後の復帰処理）から呼ぶとき。失敗のtoastは呼び元がまとめて出す
  async function applyKamoku(name, uiBtn, silent) {
    let list = openList();
    if (!list && lastAccountBtn && lastAccountBtn.isConnected) {
      lastAccountBtn.click();
      list = await waitFor(openList, 2500);
    }
    if (!list) {
      if (!silent) toast('先に明細行の勘定科目ボタンをクリックしてね');
      return false;
    }
    const items = [...list.children].filter((el) => /isSelectable/.test(el.className));
    const item =
      items.find((el) => el.textContent.trim() === name) ||
      items.find((el) => el.textContent.trim().startsWith(name));
    if (!item) {
      if (!silent) toast('候補が見つからないよ（科目名を確認してね）');
      return false;
    }
    item.click();
    if (uiBtn) flash(uiBtn);
    return true;
  }

  // ---- 補助科目・取引先のワンクリック追加（/voucher_journals 向け） ----
  //
  // MFはマスター（勘定科目・補助科目・取引先）をページ読み込み時の
  // GET /api/v1/journals/configurations で一括配信し、ドロップダウンはそのクライアント
  // キャッシュだけを見ている。ドロップダウンを開いてもAPIを叩かず、詳細パネルを開き直しても
  // 再fetchしないため、「リロードなしで新しい補助科目を出す」ことはMF側の実装上できない。
  // そこで作成→リロード→詳細パネル復帰→自動選択までを拡張が肩代わりして、
  // 「マスター画面へ移動→新規作成→戻って再読み込み」の往復をボタン1回に畳む。
  // 仕訳候補自体はサーバー側のデータなので、リロードしても手を入れていない限り元に戻る。

  let cfgCache = null;

  function ctiQuery() {
    const cti = new URLSearchParams(location.search).get('cti');
    return cti ? '?cti=' + encodeURIComponent(cti) : '';
  }

  async function getConfig(force) {
    if (cfgCache && !force) return cfgCache;
    const res = await fetch('/api/v1/journals/configurations' + ctiQuery(), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error('configurations ' + res.status);
    cfgCache = await res.json();
    return cfgCache;
  }

  const allItems = (cfg) => (cfg.itemGroups || []).flatMap((g) => g.items || []);

  // 詳細パネルの科目系ボタン。借方・貸方それぞれ
  // [0]勘定科目 [1]補助科目 [2]取引先 [3]税区分 [4]インボイス の5個1組で並ぶ。
  const detailButtons = () => [...document.querySelectorAll('button[class*="selectedChoiceLabel"]')];
  const OFFSET = { sub: 1, partner: 2 };
  const groupBtn = (g, offset) => detailButtons()[g * 5 + offset] || null;

  // 「いま何の勘定科目を触っているか」を、最後にクリックしたボタンから逆算する。
  // 組の先頭（勘定科目ボタン）と、押したボタン自身の両方をマスターと突き合わせ、
  // 実在する科目名に一致したものだけを採用する（税区分などを掴んでいたら null）。
  // 戻り値は { item, group }。group は詳細パネルの何組目か（借方=0/貸方=1…、不明なら -1）。
  async function currentItem() {
    const cfg = await getConfig();
    const items = allItems(cfg);
    const cands = [];
    const btns = detailButtons();
    const idx = btns.indexOf(lastAccountBtn);
    const group = idx >= 0 ? Math.floor(idx / 5) : -1;
    if (group >= 0) cands.push(btns[group * 5]);
    if (lastAccountBtn && lastAccountBtn.isConnected) cands.push(lastAccountBtn);
    if (lastRow && lastRow.isConnected) {
      cands.push(lastRow.querySelector('td[class*="colLedgerAccount"] button'));
    }
    for (const b of cands) {
      if (!b) continue;
      const hit = items.find((i) => i.label === b.textContent.trim());
      if (hit) return { item: hit, group };
    }
    return null;
  }

  const csrfToken = () => {
    const m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.content : '';
  };

  async function postForm(path, params) {
    const body = new URLSearchParams();
    body.set('authenticity_token', csrfToken());
    for (const [k, v] of Object.entries(params)) body.set(k, v);
    return fetch(path + ctiQuery(), {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'text/javascript, application/javascript, text/html, */*',
      },
      body: body.toString(),
    });
  }

  // MFはPOSTの成否をレスポンス本文（JS片やHTML）でしか返さないので、
  // マスターを取り直して実在を確かめる方式で成否を判定する。
  async function existsAfterPost(check) {
    const cfg = await getConfig(true);
    return check(cfg);
  }

  // 作成できたら、どのボタンに何を入れ直すかを控えてリロードする。
  // リロード後はURLのuuidで同じ明細の詳細パネルが復帰するので、そこで自動選択する。
  function reloadWithPending(p) {
    p.ts = Date.now();
    // saveSettingsはlocalStorageミラーにも同期で書くので、リロード前でも確実に残る
    saveSettings({ mfkbPending: p });
    location.reload();
  }

  async function createSubItem() {
    let cur;
    try {
      cur = await currentItem();
    } catch (e) {
      toast('マスターを取得できなかったよ');
      return;
    }
    if (!cur) {
      toast('先に勘定科目ボタンをクリックしてね');
      return;
    }
    const item = cur.item;
    const name = (prompt('「' + item.label + '」に追加する補助科目名') || '').trim();
    if (!name) return;
    if ((item.subItems || []).some((s) => s.label === name)) {
      toast('その補助科目はもうあるよ');
      return;
    }
    if (!confirm('「' + item.label + ' / ' + name + '」を作成して画面を読み込み直すよ。\n入力中に手で直した内容は失われるけど、続ける？')) return;

    const cfg = await getConfig();
    // 補助科目の税区分は親科目と同じにする。「不明」で作ると、その補助科目を選んだ瞬間に
    // 仕訳側の税区分まで「不明」に書き換わってしまう（2026-09-01 実測。
    // 既存の補助科目はいずれも親科目と同じ税区分で作られている）。
    const ex = (cfg.excises || []).find((e) => e.id === item.defaultExciseId);
    if (!ex) {
      toast('「' + item.label + '」の税区分が取れなかったよ');
      return;
    }
    try {
      await postForm('/sub_items', {
        'sub_item[item_id]': String(item.plainId),
        'sub_item[name]': name,
        'sub_item[excise_id]': String(ex.plainId),
        'sub_item[code]': '',
      });
    } catch (e) {
      toast('作成に失敗したよ（通信エラー）');
      return;
    }
    const ok = await existsAfterPost((c) =>
      (allItems(c).find((i) => i.plainId === item.plainId)?.subItems || []).some((s) => s.label === name)
    );
    if (!ok) {
      toast('作成できなかったよ。勘定科目マスターを確認してね');
      return;
    }
    reloadWithPending({ kind: 'sub', name, itemLabel: item.label, group: cur.group });
  }

  async function createTradePartner() {
    let cur;
    try {
      cur = await currentItem();
    } catch (e) {
      toast('マスターを取得できなかったよ');
      return;
    }
    if (!cur) {
      toast('先に勘定科目ボタンをクリックしてね');
      return;
    }
    const item = cur.item;
    const cfg = await getConfig();
    const name = (prompt('追加する取引先名') || '').trim();
    if (!name) return;
    if ((cfg.tradePartners || []).some((t) => t.label === name)) {
      toast('その取引先はもうあるよ');
      return;
    }
    // 登録番号なしで作るとMF側で「2023-10-01以降は非適格」扱いになり、
    // その取引先を選んだ仕訳の控除計算に効いてしまうので、ここで入れられるようにする。
    const inv = (prompt('「' + name + '」のインボイス登録番号（T+13桁）\n登録がなければ空のままOK') || '')
      .trim()
      .toUpperCase()
      .replace(/[\s-]/g, '');
    if (inv && !/^T\d{13}$/.test(inv)) {
      toast('登録番号はT＋13桁で入れてね');
      return;
    }
    if (
      !confirm(
        '取引先「' + name + '」' + (inv ? '（' + inv + '）' : '（インボイス登録番号なし＝非適格扱い）') +
          'を作成して画面を読み込み直すよ。\n入力中に手で直した内容は失われるけど、続ける？'
      )
    )
      return;

    const K = 'trade_partner_form[trade_partner]';
    try {
      await postForm('/trade_partners', {
        [K + '[name]']: name,
        [K + '[name_for_search]']: name,
        [K + '[invoice_registration_number]']: inv,
        [K + '[corporate_number]']: '',
        [K + '[is_active]']: '1',
      });
    } catch (e) {
      toast('作成に失敗したよ（通信エラー）');
      return;
    }
    const ok = await existsAfterPost((c) => (c.tradePartners || []).some((t) => t.label === name));
    if (!ok) {
      toast('作成できなかったよ。取引先マスターを確認してね');
      return;
    }
    reloadWithPending({ kind: 'partner', name, itemLabel: item.label, group: cur.group });
  }

  // 指定した組のボタンを開いて name を選び、ラベルに反映されるまで待つ
  async function pickInGroup(g, offset, name) {
    // 直前のドロップダウンが残っていると別の欄のリストを掴んでしまうので閉じるのを待つ
    await waitSlow(() => (openList() ? null : true), 2000, 80);
    const btn = groupBtn(g, offset);
    if (!btn) return false;
    lastAccountBtn = btn;
    if (!(await applyKamoku(name, null, true))) return false;
    const ok = await waitSlow(() => {
      const b = groupBtn(g, offset);
      if (!b) return null;
      const t = b.textContent.trim();
      return t === name || t.startsWith(name) ? true : null;
    }, 3000, 80);
    return !!ok;
  }

  // リロード後: 控えた組の勘定科目を選び直してから、作った補助科目／取引先を選ぶ。
  // リロードで仕訳候補はサーバー側の値に戻るため、科目もこちらで入れ直さないと
  // 「科目＋補助科目」がそろわない（2026-09-01 けんとさん指示）。
  async function applyPending(p) {
    const label = p.kind === 'sub' ? '補助科目' : '取引先';
    const giveUp = (what) => toast('「' + p.name + '」を作ったよ（' + what + 'は手で選んでね）');
    const has = typeof p.group === 'number' && p.group >= 0;

    // 詳細パネルの復帰待ち。リロード直後はボタンだけ先に並んでラベルが後から入るので、
    // 「控えた勘定科目のラベルが出そろう」ことを合図にする（サーバー側の値が戻ってくる）。
    // 0を偽値にしないため、組番号は +1 して返す。
    let g = await waitSlow(() => {
      const b = detailButtons();
      if (b.length < 5) return null;
      const at = (i) => (b[i] ? b[i].textContent.trim() : '');
      if (has && b.length > p.group * 5 + 4 && at(p.group * 5) === p.itemLabel) return p.group + 1;
      for (let i = 0; i < b.length; i += 5) if (at(i) === p.itemLabel) return i / 5 + 1;
      return null;
    }, 20000, 200);

    if (g) {
      g -= 1; // 科目はリロードで戻っている。触らずに②へ
    } else {
      // 科目が戻ってこなかった（手で変えた科目だった等）。控えた組に自分で入れ直す
      const b = detailButtons();
      if (!has || b.length <= p.group * 5 + 4) return giveUp(label);
      g = p.group;
      if (!(await pickInGroup(g, 0, p.itemLabel))) return giveUp('勘定科目と' + label);
    }

    // ② 補助科目／取引先。初期化直後は取りこぼすことがあるので一度だけやり直す
    let ok = await pickInGroup(g, OFFSET[p.kind], p.name);
    if (!ok) {
      await new Promise((r) => setTimeout(r, 800));
      ok = await pickInGroup(g, OFFSET[p.kind], p.name);
    }
    if (!ok) return giveUp(label);
    toast('「' + p.itemLabel + ' / ' + p.name + '」を選んだよ');
  }

  // ---- なんぴ検索 ----

  // 半角カナ→全角カナ（濁点・半濁点の合成込み）
  const KANA_MAP = {
    'ｶﾞ':'ガ','ｷﾞ':'ギ','ｸﾞ':'グ','ｹﾞ':'ゲ','ｺﾞ':'ゴ','ｻﾞ':'ザ','ｼﾞ':'ジ','ｽﾞ':'ズ','ｾﾞ':'ゼ','ｿﾞ':'ゾ',
    'ﾀﾞ':'ダ','ﾁﾞ':'ヂ','ﾂﾞ':'ヅ','ﾃﾞ':'デ','ﾄﾞ':'ド','ﾊﾞ':'バ','ﾋﾞ':'ビ','ﾌﾞ':'ブ','ﾍﾞ':'ベ','ﾎﾞ':'ボ',
    'ﾊﾟ':'パ','ﾋﾟ':'ピ','ﾌﾟ':'プ','ﾍﾟ':'ペ','ﾎﾟ':'ポ','ｳﾞ':'ヴ',
    'ｱ':'ア','ｲ':'イ','ｳ':'ウ','ｴ':'エ','ｵ':'オ','ｶ':'カ','ｷ':'キ','ｸ':'ク','ｹ':'ケ','ｺ':'コ',
    'ｻ':'サ','ｼ':'シ','ｽ':'ス','ｾ':'セ','ｿ':'ソ','ﾀ':'タ','ﾁ':'チ','ﾂ':'ツ','ﾃ':'テ','ﾄ':'ト',
    'ﾅ':'ナ','ﾆ':'ニ','ﾇ':'ヌ','ﾈ':'ネ','ﾉ':'ノ','ﾊ':'ハ','ﾋ':'ヒ','ﾌ':'フ','ﾍ':'ヘ','ﾎ':'ホ',
    'ﾏ':'マ','ﾐ':'ミ','ﾑ':'ム','ﾒ':'メ','ﾓ':'モ','ﾔ':'ヤ','ﾕ':'ユ','ﾖ':'ヨ',
    'ﾗ':'ラ','ﾘ':'リ','ﾙ':'ル','ﾚ':'レ','ﾛ':'ロ','ﾜ':'ワ','ｦ':'ヲ','ﾝ':'ン',
    'ｧ':'ァ','ｨ':'ィ','ｩ':'ゥ','ｪ':'ェ','ｫ':'ォ','ｬ':'ャ','ｭ':'ュ','ｮ':'ョ','ｯ':'ッ',
    'ｰ':'ー','｡':'。','､':'、','･':'・','｢':'「','｣':'」',
  };
  function toZenkakuKana(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const two = s.slice(i, i + 2);
      if (KANA_MAP[two]) { out += KANA_MAP[two]; i++; continue; }
      out += KANA_MAP[s[i]] || s[i];
    }
    return out;
  }

  // 摘要のテキストを取る。
  // 連携サービスから入力: 行内の colRemarkArea textarea。
  // AI-OCRから入力の詳細パネル: colRemarkArea が無く、パネル内に摘要textareaが並ぶだけなので、
  //   最後に触った科目ボタンから祖先を上へ辿り、値の入ったtextareaを最初に見つけた時点で採用する。
  function remarkText() {
    if (lastRow && lastRow.isConnected) {
      const ta = lastRow.querySelector('td[class*="colRemarkArea"] textarea');
      if (ta && ta.value) return ta.value;
    }
    let scope = lastAccountBtn && lastAccountBtn.isConnected ? lastAccountBtn.parentElement : null;
    while (scope && scope !== document.body) {
      const ta = [...scope.querySelectorAll('textarea')].find((t) => t.value && t.value.trim());
      if (ta) return ta.value;
      scope = scope.parentElement;
    }
    return '';
  }

  // 摘要から検索語の候補を抽出（例:「ﾄﾘﾀｹｿｳﾎﾝﾃﾝ/NFC（TORITAKE SOHONTEN）」→「トリタケソウホンテン」）
  function nanpiCandidate() {
    let t = remarkText();
    if (!t) return '';
    // 全角英数・記号→半角
    t = t.replace(/[Ａ-Ｚａ-ｚ０-９．＊／]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0)
    );
    // 半角カナ→全角カナ
    t = toZenkakuKana(t);
    // カタカナ直後のハイフン類は長音（銀行データは「ﾃﾞﾆ-ｽﾞ」のようにASCIIハイフンで来る）
    t = t.replace(/([ァ-ヶー])[-−―‐]/g, '$1ー');
    // カッコ書き・スラッシュ以降を落とし、振込マーカーを除去
    t = t.split('（')[0].split('(')[0].split('/')[0];
    t = t.replace(/^(都度振込|振込入金|振込)[＊*\s]*/, '');
    return t.trim().slice(0, 30);
  }

  // 検索語の優先順: ページ上の選択テキスト → 最後に触った行の摘要 → 手入力ダイアログ
  // 小窓はウィンドウ名 "nanpi" を使い回すので、連続で調べても増えない
  function openNanpi() {
    let q = (window.getSelection() + '').trim();
    if (!q) q = nanpiCandidate();
    if (!q) q = prompt('何費か調べたい語（サービス名・店名など）') || '';
    q = q.trim();
    if (!q) return;
    window.open(
      NANPI_URL + '?q=' + encodeURIComponent(q.slice(0, 30)),
      'nanpi',
      'width=520,height=760'
    );
  }

  // ---- UI ----

  let toastTimer = null;
  function toast(msg) {
    const panel = document.getElementById(PANEL_ID);
    let el = document.getElementById(PANEL_ID + '-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = PANEL_ID + '-toast';
      el.style.cssText =
        'position:absolute;left:0;right:0;bottom:100%;margin-bottom:6px;background:#333;color:#fff;' +
        'padding:6px 10px;border-radius:6px;font-size:12px;line-height:1.4;text-align:center;';
      if (panel) panel.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = 'none'; }, 2500);
  }

  function flash(btn) {
    const orig = btn.style.background;
    const origColor = btn.style.color;
    btn.style.background = '#22a559';
    btn.style.color = '#fff';
    setTimeout(() => {
      btn.style.background = orig;
      btn.style.color = origColor;
    }, 500);
  }

  function clampIntoViewport(panel) {
    const r = panel.getBoundingClientRect();
    let left = r.left, top = r.top, moved = false;
    if (left + r.width > innerWidth) { left = innerWidth - r.width - 8; moved = true; }
    if (top + r.height > innerHeight) { top = innerHeight - r.height - 8; moved = true; }
    if (left < 0) { left = 8; moved = true; }
    if (top < 0) { top = 8; moved = true; }
    if (moved) {
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
  }

  function buildButtons(body) {
    body.textContent = '';
    for (const name of kamokuList) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = name;
      b.style.cssText =
        'padding:5px 10px;border:1px solid #2c67c8;border-radius:4px;background:#fff;color:#2c67c8;' +
        'cursor:pointer;font-size:12px;font-weight:bold;white-space:nowrap;';
      b.addEventListener('mousedown', (e) => {
        // ドロップダウンの外側クリック閉じ・選択テキスト解除を防ぐ
        e.preventDefault();
        e.stopPropagation();
      });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        applyKamoku(name, b);
      });
      body.appendChild(b);
    }
  }

  function injectPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText =
      'position:fixed;right:20px;bottom:80px;z-index:2147483000;background:#fff;border:1px solid #bbb;' +
      'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);font-family:sans-serif;width:230px;' +
      'user-select:none;';

    // ヘッダー（ドラッグ・🔍・折りたたみ）
    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:6px 8px;background:#2c67c8;color:#fff;' +
      'border-radius:7px 7px 0 0;cursor:move;font-size:12px;font-weight:bold;';
    const title = document.createElement('span');
    title.textContent = '科目ボタン';
    title.style.cssText = 'flex:1;';

    const nanpiBtn = document.createElement('button');
    nanpiBtn.type = 'button';
    nanpiBtn.textContent = '🔍';
    nanpiBtn.title = '「これ、何費？」で検索（選択テキスト→摘要の順で候補）';
    nanpiBtn.style.cssText =
      'border:none;background:rgba(255,255,255,.2);color:#fff;border-radius:4px;cursor:pointer;' +
      'padding:2px 7px;font-size:13px;';
    nanpiBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    nanpiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openNanpi();
    });

    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.style.cssText = nanpiBtn.style.cssText;
    collapseBtn.addEventListener('mousedown', (e) => e.stopPropagation());

    header.append(title, nanpiBtn, collapseBtn);

    // ボタン領域
    const body = document.createElement('div');
    body.id = PANEL_ID + '-body';
    body.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:8px;';
    buildButtons(body);

    // マスター追加行（補助科目・取引先をその場で作る）
    const master = document.createElement('div');
    master.style.cssText =
      'display:flex;gap:6px;padding:0 8px 8px;border-top:1px solid #eee;margin-top:2px;padding-top:8px;';
    for (const [text, title, fn] of [
      ['＋補助科目', '選択中の勘定科目に補助科目を追加して選択する（画面を読み込み直すよ）', createSubItem],
      ['＋取引先', '取引先を追加して選択する（画面を読み込み直すよ）', createTradePartner],
    ]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.title = title;
      b.style.cssText =
        'flex:1;padding:5px 6px;border:1px solid #999;border-radius:4px;background:#fafafa;color:#333;' +
        'cursor:pointer;font-size:12px;white-space:nowrap;';
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      master.appendChild(b);
    }

    const applyCollapsed = () => {
      body.style.display = collapsed ? 'none' : 'flex';
      master.style.display = collapsed ? 'none' : 'flex';
      collapseBtn.textContent = collapsed ? '＋' : '−';
      collapseBtn.title = collapsed ? '展開' : '折りたたみ';
    };
    applyCollapsed();
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      collapsed = !collapsed;
      applyCollapsed();
      saveSettings({ mfkbCollapsed: collapsed });
    });

    panel.append(header, body, master);
    document.documentElement.appendChild(panel);

    // 保存位置の復元
    if (panelPos && typeof panelPos.left === 'number') {
      panel.style.left = panelPos.left + 'px';
      panel.style.top = panelPos.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
    clampIntoViewport(panel);

    // ヘッダードラッグで移動、離したら位置を保存
    let drag = null;
    header.addEventListener('mousedown', (e) => {
      if (e.target !== header && e.target !== title) return;
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      panel.style.left = e.clientX - drag.dx + 'px';
      panel.style.top = e.clientY - drag.dy + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (!drag) return;
      drag = null;
      clampIntoViewport(panel);
      const r = panel.getBoundingClientRect();
      panelPos = { left: r.left, top: r.top };
      saveSettings({ mfkbPos: panelPos });
    });
    window.addEventListener('resize', () => clampIntoViewport(panel));
  }

  // ---- 起動 ----
  // chrome.storageを正、localStorageミラーを副として読む。
  // chrome.storage側が空（拡張入れ直し直後など）ならミラーから復元して書き戻す。
  storage.get(['mfkbKamoku', 'mfkbPos', 'mfkbCollapsed', 'mfkbPending'], (data) => {
    const mirror = mirrorRead();
    let restored = false;
    if (Array.isArray(data.mfkbKamoku) && data.mfkbKamoku.length) {
      kamokuList = data.mfkbKamoku;
    } else if (Array.isArray(mirror.mfkbKamoku) && mirror.mfkbKamoku.length) {
      kamokuList = mirror.mfkbKamoku;
      restored = true;
    }
    panelPos = data.mfkbPos || mirror.mfkbPos || null;
    collapsed = data.mfkbCollapsed !== undefined ? !!data.mfkbCollapsed : !!mirror.mfkbCollapsed;
    if (restored) storage.set({ mfkbKamoku: kamokuList });
    // popupでの保存はMFタブが開いていないとミラーに届かない。起動のたびに正→副へ揃えておく
    else mirrorWrite({ mfkbKamoku: kamokuList });
    // 設定を読む前にパネルが作られていたら（下のMutationObserverが先に走った場合）捨てて作り直す。
    // 残したままだとデフォルトの科目リスト・既定位置のまま固定されてしまう（2026-09-01 けんとさん報告）
    const stale = document.getElementById(PANEL_ID);
    if (stale) stale.remove();
    injectPanel();

    // マスター追加によるリロード直後なら、作った補助科目／取引先を選び直す。
    // 控えは必ず消してから走らせる（失敗しても次のリロードで蒸し返さないため）。
    const pending = mirrorRead().mfkbPending || data.mfkbPending;
    if (pending && pending.name && Date.now() - (pending.ts || 0) < 120000) {
      saveSettings({ mfkbPending: null });
      applyPending(pending).catch(() => toast('「' + pending.name + '」を作ったよ（選択は手でお願い）'));
    } else if (pending) {
      saveSettings({ mfkbPending: null });
    }

    // Reactの再レンダリングでパネルが消えたら差し直す。
    // 設定の読み込みが終わってから見張り始める（先に走らせるとデフォルトのままのパネルを作ってしまう）。
    // ここで例外を出すと起動処理ごと落ちるので包む
    try {
      new MutationObserver(() => {
        if (!document.getElementById(PANEL_ID)) injectPanel();
      }).observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  });

  // popupで科目リストが保存されたら即反映
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.mfkbKamoku) return;
      const v = changes.mfkbKamoku.newValue;
      if (Array.isArray(v) && v.length) {
        kamokuList = v;
        mirrorWrite({ mfkbKamoku: v }); // popupからの保存もミラーに反映
        const body = document.getElementById(PANEL_ID + '-body');
        if (body) buildButtons(body);
      }
    });
  }

})();
