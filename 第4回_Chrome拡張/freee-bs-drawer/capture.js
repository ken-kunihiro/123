/*
 * freee BSサイドドロワー - 期間パラメータのキャプチャ
 *
 * 試算表ページが自分で叩く /api/p/reports/trial_balance_sheet のURLを
 * PerformanceObserver（＋既存エントリの走査）で観測し、
 * 会計年度ID・期間だけを chrome.storage.local に控える。
 * fiscal_year パラメータの中身は西暦ではなく「会計年度のID」で、事業所ごとの採番。
 *
 * ここでやるのは「けんとさんが試算表画面で見ている期間」を覚えることだけ。
 * リクエストには一切手を加えないし、外部へは何も送らない。
 * 「自動で経理」側のドロワーは、この期間を使ってBS残高を取りにいく。
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'hkbs_period';
  var TARGET = '/api/p/reports/trial_balance_sheet';

  function paramOf(url, key) {
    try {
      return new URL(url, location.origin).searchParams.get(key) || '';
    } catch (e) {
      return '';
    }
  }

  // 同じ内容を何度も書き込まないよう、直近に保存した中身を覚えておく
  var lastSaved = '';

  function save(url) {
    var startDate = paramOf(url, 'start_date');
    var endDate = paramOf(url, 'end_date');
    if (!startDate || !endDate) return;

    var record = {
      companyId: paramOf(url, 'company_id'),
      startDate: startDate,
      endDate: endDate,
      fiscalYear: paramOf(url, 'fiscal_year'),
      sourceUrl: url,
      savedAt: new Date().toISOString()
    };

    var fingerprint = [record.companyId, record.startDate, record.endDate, record.fiscalYear].join('|');
    if (fingerprint === lastSaved) return;
    lastSaved = fingerprint;

    try {
      chrome.storage.local.set({ hkbs_period: record });
    } catch (e) {
      // 拡張のコンテキストが切れている（更新直後など）ときは黙って諦める
    }
  }

  function scanExisting() {
    var entries;
    try {
      entries = performance.getEntriesByType('resource') || [];
    } catch (e) {
      return;
    }
    // 新しいものを優先したいので後ろから見る
    for (var i = entries.length - 1; i >= 0; i--) {
      var name = entries[i] && entries[i].name;
      if (typeof name === 'string' && name.indexOf(TARGET) !== -1) {
        save(name);
        return;
      }
    }
  }

  function observe() {
    if (typeof PerformanceObserver !== 'function') return;
    try {
      var po = new PerformanceObserver(function (list) {
        var items = list.getEntries();
        for (var i = 0; i < items.length; i++) {
          var name = items[i] && items[i].name;
          if (typeof name === 'string' && name.indexOf(TARGET) !== -1) save(name);
        }
      });
      po.observe({ type: 'resource', buffered: true });
    } catch (e) {
      // resource type を監視できない環境では既存エントリの走査だけで済ませる
    }
  }

  scanExisting();
  observe();

  // 画面を開いた直後はまだAPIが飛んでいないことがあるので、数回だけ見に行く
  var retries = 0;
  var timer = setInterval(function () {
    retries++;
    scanExisting();
    if (retries >= 10) clearInterval(timer);
  }, 1000);
})();
