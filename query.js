"use strict";
// query.js — lib/gyminfo_viewer/query.py のフィルタ/グルーピングを
// クライアント側へ移植(静的SPA用)。DB(JSON)をメモリ上で集計する。

const WEEK = ["月", "火", "水", "木", "金", "土", "日"];

// meta.regions の並びをソートキーに使う(地域順)。
let REGION_ORDER = [];
let CATEGORY_ORDER = [];
// カテゴリー -> 関連キーワード(normalize済み)。表記揺れ吸収に使う。
let CATEGORY_KEYWORDS = {};

function setOrders(meta) {
  REGION_ORDER = meta.regions || [];
  CATEGORY_ORDER = meta.categories || [];
  CATEGORY_KEYWORDS = meta.category_keywords || {};
}

function dayKey(d) {
  const i = WEEK.indexOf(d);
  return i < 0 ? WEEK.length : i;
}
function startMin(s) {
  if (!s) return 24 * 60 + 1;
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 24 * 60 + 1;
}
function regionKey(r) {
  const i = REGION_ORDER.indexOf(r);
  return i < 0 ? REGION_ORDER.length : i;
}
function norm(s) {
  return (s || "").normalize("NFKC").toUpperCase();
}
function fmtTime(r) {
  const pad = (x) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(x || "");
    return m ? `${String(parseInt(m[1], 10)).padStart(2, "0")}:${m[2]}` : (x || "");
  };
  const st = pad(r.start), en = pad(r.end);
  if (st && en) return `${st}~${en}`;
  return st || "";
}
// 所要時間(分)。start/end が揃わない場合は null。日跨ぎは無視。
function durationMin(r) {
  const a = startMin(r.start), b = startMin(r.end);
  if (a > 24 * 60 || b > 24 * 60) return null;
  const d = b - a;
  return d > 0 ? d : null;
}
function fmtDuration(r) {
  const d = durationMin(r);
  return d == null ? "" : `${d}分`;
}

// カテゴリー一致判定: 割当カテゴリーが一致するか、または表記揺れ吸収のため
// クラス名に当該カテゴリーの関連キーワードが部分一致すればヒットとする。
// 例) 「AEROBICS」選択で「ダンスエアロ45」(エアロ含む)もヒット。
function matchCategory(r, cat) {
  if (r.category === cat) return true;
  const kws = CATEGORY_KEYWORDS[cat];
  if (!kws || !kws.length) return false;
  const hay = norm(r.class_name);
  if (!hay) return false;
  return kws.some((k) => hay.includes(k));
}

// ---- フィルタ ----
function filterLessons(lessons, p) {
  const q = norm(p.q);
  return lessons.filter((r) => {
    if (p.region && r.region !== p.region) return false;
    if (p.prefecture && r.prefecture !== p.prefecture) return false;
    if (p.gym && r.gym_id !== p.gym) return false;
    if (p.day && r.day !== p.day) return false;
    if (p.category && !matchCategory(r, p.category)) return false;
    if (p.store_id && String(r.store_id) !== String(p.store_id)) return false;
    if (p.instructor && (r.instructor || "") !== p.instructor) return false;
    if (q) {
      const hay = norm([
        r.class_name, r.instructor, r.store, r.gym, r.gym_label, r.gym_id,
        r.note, r.studio,
      ].join(""));
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ---- 並び順 ----
function sortDefault(rows) {
  return rows.slice().sort((a, b) =>
    (dayKey(a.day) - dayKey(b.day)) ||
    (startMin(a.start) - startMin(b.start)) ||
    (regionKey(a.region) - regionKey(b.region)) ||
    (a.store || "").localeCompare(b.store || "", "ja"));
}
function sortByTime(rows) {
  return rows.slice().sort((a, b) =>
    (startMin(a.start) - startMin(b.start)) ||
    (dayKey(a.day) - dayKey(b.day)) ||
    (a.store || "").localeCompare(b.store || "", "ja"));
}

// ---- グルーピング ----
function group(rows, keyfn, order, sortfn) {
  const buckets = new Map();
  for (const r of rows) {
    const k = keyfn(r) || "(なし)";
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const keys = [...buckets.keys()].sort((a, b) => {
    const ia = order ? order.indexOf(a) : -1;
    const ib = order ? order.indexOf(b) : -1;
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b, "ja");
  });
  return keys.map((k) => ({
    key: k, count: buckets.get(k).length, rows: (sortfn || sortDefault)(buckets.get(k)),
  }));
}

function storeLabel(r) {
  // 店舗名にジム名が含まれなければ「店舗名（ジム名）」で併記
  const store = (r.store || "").trim() || "(店舗不明)";
  const gym = (r.gym || "").trim();
  return (gym && !store.includes(gym)) ? `${store}（${gym}）` : store;
}

function timeband(r) {
  const m = startMin(r.start);
  if (m >= 24 * 60) return "時刻不明";
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, "0")}:00〜${String(h).padStart(2, "0")}:59`;
}

// ---- ビュー構築 ----
function buildView(lessons, view, params) {
  const rows = filterLessons(lessons, params);
  let groups;
  switch (view) {
    case "day": groups = group(rows, (r) => r.day, WEEK); break;
    case "timeband":
      groups = group(rows, timeband, null, sortByTime);
      groups.sort((a, b) => a.key.localeCompare(b.key));
      break;
    case "store": groups = group(rows, (r) => storeLabel(r)); break;
    case "category": groups = group(rows, (r) => r.category, CATEGORY_ORDER); break;
    case "instructor": groups = group(rows, (r) => r.instructor); break;
    case "hashigo": groups = group(rows, (r) => r.day, WEEK, sortByTime); break;
    case "gym": groups = group(rows, (r) => r.gym_label || r.gym_id, null, sortDefault); break;
    default: groups = group(rows, (r) => r.day, WEEK);
  }
  return { view, total: rows.length, group_count: groups.length, groups };
}

function listInstructors(lessons, params) {
  const rows = filterLessons(lessons, { ...params, instructor: "" });
  const counts = new Map();
  for (const r of rows) {
    const n = r.instructor;
    if (!n) continue;
    // 数字のみ等のパースミスは先生一覧から除外(データ側でも除去済み)。
    if (/^[\d\.]+$/.test(n) || (/^[A-Za-z0-9]+$/.test(n) && !/[\u3040-\u30ff\u4e00-\u9fff]/.test(n))) continue;
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"))
    .map(([name, count]) => ({ name, count }));
}

const GQ_API = { WEEK, setOrders, filterLessons, buildView, listInstructors,
  fmtTime, durationMin, fmtDuration, startMin, dayKey, storeLabel };
if (typeof window !== "undefined") window.GQ = GQ_API;
if (typeof module !== "undefined" && module.exports) module.exports = GQ_API;
