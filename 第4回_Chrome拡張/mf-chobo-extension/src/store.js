/*
 * MF帳簿点検ハイライト — メモの保存層
 *
 * chrome.storage.local に事業所（cti）ごとの塊で持つ。
 *   キー   : 'mfck:<cti>'
 *   中身   : { "<page>|<account>|<ref>|<code>": { memo: "...", at: "2026-09-08T..." } }
 * 指摘そのものは毎回その場で計算するので保存しない。保存するのは「確認済み」の印だけ。
 */
(function () {
  'use strict';

  var PREFIX = 'mfck:';
  var cache = {};       // cti -> オブジェクト（読み込み済みのメモ一式）
  var loaded = {};      // cti -> true

  function storageKey(cti) {
    return PREFIX + (cti || 'unknown');
  }

  /** 指摘1件を一意に指すキー。ref は元帳=取引No、試算表=科目名、推移表=科目名@月 */
  function makeKey(page, account, ref, code) {
    return [page, account || '', ref || '', code].join('|');
  }

  function load(cti, force) {
    return new Promise(function (resolve) {
      var key = storageKey(cti);
      if (loaded[cti] && !force) { resolve(cache[cti]); return; }
      chrome.storage.local.get(key, function (data) {
        cache[cti] = (data && data[key]) || {};
        loaded[cti] = true;
        resolve(cache[cti]);
      });
    });
  }

  function save(cti) {
    return new Promise(function (resolve) {
      var obj = {};
      obj[storageKey(cti)] = cache[cti] || {};
      chrome.storage.local.set(obj, function () { resolve(); });
    });
  }

  function get(cti, key) {
    var box = cache[cti];
    return box ? box[key] : null;
  }

  /** 確認済みにする（メモは任意） */
  function mark(cti, key, memo) {
    if (!cache[cti]) cache[cti] = {};
    cache[cti][key] = { memo: String(memo || ''), at: new Date().toISOString() };
    return save(cti);
  }

  /** 確認済みを取り消してハイライトを戻す */
  function unmark(cti, key) {
    if (cache[cti]) delete cache[cti][key];
    return save(cti);
  }

  function all(cti) {
    return cache[cti] || {};
  }

  function clear(cti) {
    cache[cti] = {};
    return save(cti);
  }

  window.MFCK_STORE = {
    makeKey: makeKey,
    load: load,
    get: get,
    mark: mark,
    unmark: unmark,
    all: all,
    clear: clear
  };
})();
