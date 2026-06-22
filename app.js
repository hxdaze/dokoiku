"use strict";
// app.js — 静的SPA(どこいくZUMBA)。data/*.json を読み込み、query.js で集計し描画。

const $ = (s) => document.querySelector(s);
const STATE_KEY = "dokoiku_zumba_state_v1";

const state = {
  view: "day", region: "", prefecture: "", gym: "", day: "", category: "",
  store_id: "", instructor: "", q: "", limit: "200",
};

let META = null;
let LESSONS = [];      // 現在ロード済みの全レッスン(都道府県パートの連結)
let STORES = [];
let DAIKO = [];
let STORE_URL = new Map();   // gym_id|store_id -> url
let GYM_LABEL = new Map();
let lastData = null;
const sortState = { col: null, dir: "asc" };

// --- 都道府県別 遅延ロード管理 ---
const LESSON_PARTS = new Map();      // 都道府県名 -> レッスン配列
const LOADED = new Set();            // ロード済み都道府県名
let PREF_INDEX = [];                 // [{name, slug, region, count}]
const PREF_BY_NAME = new Map();      // 都道府県名 -> {slug,...}
const PREFS_BY_REGION = new Map();   // 地域 -> [都道府県名]
let ALL_LOADED = false;              // 「全国読み込み」実行済みか

// ---- 永続化 ----
function saveState() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (_e) {}
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
    for (const k of Object.keys(state)) if (typeof s[k] === "string") state[k] = s[k];
  } catch (_e) {}
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function escapeAttr(s) {
  return String(s ?? "").replace(/["&<>]/g, (c) => ({ '"': "&quot;", "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function setOptions(sel, items, { value = (x) => x, label = (x) => x, head = '<option value="">すべて</option>' } = {}) {
  const cur = sel.value;
  sel.innerHTML = head + items.map((it) => `<option value="${escapeAttr(value(it))}">${escapeHtml(label(it))}</option>`).join("");
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

// ---- データ読み込み ----
// キャッシュ回避: ビルド版(window.BUILD_VERSION)をクエリに付与。
function withVer(url) {
  const v = (typeof window !== "undefined" && window.BUILD_VERSION) || "";
  return v ? `${url}?v=${encodeURIComponent(v)}` : url;
}

// 初期ロードは meta/stores/daiko のみ(軽量)。レッスン本体は都道府県単位で
// スコープ選択時に遅延ロードする(一括DLによるモバイルのメモリ枯渇を回避)。
async function loadData() {
  const [meta, stores, daiko] = await Promise.all([
    fetch(withVer("data/meta.json")).then((r) => r.json()),
    fetch(withVer("data/stores.json")).then((r) => r.json()),
    fetch(withVer("data/daiko.json")).then((r) => r.json()).catch(() => []),
  ]);
  META = meta;
  STORES = stores;
  DAIKO = daiko;
  GQ.setOrders(meta);
  for (const g of meta.gyms) GYM_LABEL.set(g.id, g.label);
  for (const s of stores) STORE_URL.set(s.gym_id + "|" + s.store_id, s.url);

  PREF_INDEX = meta.pref_index || [];
  for (const p of PREF_INDEX) {
    PREF_BY_NAME.set(p.name, p);
    if (!PREFS_BY_REGION.has(p.region)) PREFS_BY_REGION.set(p.region, []);
    PREFS_BY_REGION.get(p.region).push(p.name);
  }
}

// 列配列ドキュメント(都道府県パート)をオブジェクト配列へ復元し、ジム名/URLを付与。
function lessonsFromDoc(doc) {
  const cols = doc.columns;
  return doc.rows.map((row) => {
    const o = {};
    cols.forEach((c, i) => { o[c] = row[i]; });
    o.reservation_required = !!o.reservation_required;
    o.gym_label = GYM_LABEL.get(o.gym_id) || o.gym_id;
    o.gym = o.gym_label;
    o.url = STORE_URL.get(o.gym_id + "|" + o.store_id) || null;
    return o;
  });
}

// 指定の都道府県群のレッスンをロード(未ロード分のみfetch)。
async function ensurePrefs(names) {
  const todo = names.filter((n) => !LOADED.has(n));
  await Promise.all(todo.map(async (name) => {
    const info = PREF_BY_NAME.get(name);
    if (!info) { LOADED.add(name); return; }
    try {
      const doc = await fetch(withVer(`data/lessons/${info.slug}.json`)).then((r) => r.json());
      LESSON_PARTS.set(name, lessonsFromDoc(doc));
    } catch (_e) {
      LESSON_PARTS.set(name, []);
    }
    LOADED.add(name);
  }));
}

// 現在の選択から、ロードが必要な都道府県の一覧を返す。未選択なら null。
function scopePrefs() {
  if (state.prefecture) return [state.prefecture];
  if (state.region) return (PREFS_BY_REGION.get(state.region) || []).slice();
  if (ALL_LOADED) return PREF_INDEX.map((p) => p.name);
  return null;
}

// ロード済みパートを連結して LESSONS を再構築。
function rebuildLessons() {
  LESSONS = [];
  for (const name of LOADED) {
    const part = LESSON_PARTS.get(name);
    if (part && part.length) LESSONS = LESSONS.concat(part);
  }
}

// 全国(全都道府県)を読み込む(明示操作・PC向け)。
async function loadAll() {
  $("#main").innerHTML = '<div class="loading">全国のデータを読み込み中…（少し時間がかかります）</div>';
  await ensurePrefs(PREF_INDEX.map((p) => p.name));
  ALL_LOADED = true;
  rebuildLessons();
  refreshStoreOptions();
  refreshInstructorOptions();
  refreshViewRender();
}

function fillControls() {
  $("#metaSub").textContent =
    `${META.gyms.length}ジム ｜ レッスン ${META.lesson_count.toLocaleString()}件・店舗 ${META.store_count}件 ｜ ${META.generated_at?.slice(0, 16).replace("T", " ") || ""}`;
  setOptions($("#f-region"), META.regions);
  setOptions($("#f-prefecture"), META.prefectures || []);
  setOptions($("#f-gym"), META.gyms, { value: (g) => g.id, label: (g) => `${g.label} (${g.count.toLocaleString()})` });
  setOptions($("#f-day"), META.days);
  setOptions($("#f-category"), META.categories);
  refreshStoreOptions();
  refreshInstructorOptions();
  // 復元
  const set = (sel, v) => { const el = $(sel); if (el && [...el.options].some((o) => o.value === v)) el.value = v; };
  set("#f-region", state.region); set("#f-prefecture", state.prefecture);
  set("#f-gym", state.gym); set("#f-day", state.day);
  set("#f-category", state.category); set("#f-store", state.store_id);
  set("#f-instructor", state.instructor); set("#f-limit", state.limit);
  $("#f-q").value = state.q || "";
  setActiveTab(state.view);
}

function refreshStoreOptions() {
  let list = STORES;
  if (state.region) list = list.filter((s) => s.region === state.region);
  if (state.prefecture) list = list.filter((s) => s.prefecture === state.prefecture);
  if (state.gym) list = list.filter((s) => s.gym_id === state.gym);
  list = list.slice().sort((a, b) => (a.store || "").localeCompare(b.store || "", "ja"));
  setOptions($("#f-store"), list, { value: (s) => s.store_id, label: (s) => s.store });
}

function refreshInstructorOptions() {
  const list = GQ.listInstructors(LESSONS, params());
  setOptions($("#f-instructor"), list, { value: (i) => i.name, label: (i) => `${i.name} (${i.count})` });
}

function params() {
  return {
    region: state.region, prefecture: state.prefecture, gym: state.gym,
    day: state.day, category: state.category,
    store_id: state.store_id, instructor: state.instructor, q: state.q,
  };
}

// ---- 描画 ----
function setActiveTab(v) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
}

function viewLabel(v) {
  return { day: "曜日別", timeband: "時間帯別", store: "店舗別", category: "カテゴリー別",
    instructor: "先生別", hashigo: "はしご", gym: "ジム別", substitution: "代行情報" }[v] || v;
}

function currentLimit() {
  const n = parseInt(state.limit, 10);
  return (!Number.isFinite(n) || n <= 0) ? Infinity : n;
}

// スコープ未選択時の案内(全国読み込みボタン付き)。
function renderChooseScope() {
  $("#summary").innerHTML = "";
  $("#main").innerHTML =
    '<div class="empty">エリアまたは都道府県を選択してください。' +
    '<br>地域を絞ることで素早く表示できます（モバイル推奨）。' +
    '<div style="margin-top:14px;"><button class="btn" id="loadAllBtn">全国をまとめて読み込む</button></div></div>';
  const b = document.getElementById("loadAllBtn");
  if (b) b.addEventListener("click", loadAll);
}

// 選択スコープのデータを確保してから、店舗/先生の選択肢と一覧を更新する。
async function update() {
  saveState();
  if (state.view === "substitution") { renderSubstitution(); return; }
  const prefs = scopePrefs();
  if (!prefs) { refreshStoreOptions(); renderChooseScope(); return; }
  if (prefs.some((n) => !LOADED.has(n))) {
    $("#main").innerHTML = '<div class="loading">読み込み中…</div>';
  }
  await ensurePrefs(prefs);
  rebuildLessons();
  refreshStoreOptions();
  refreshInstructorOptions();
  refreshViewRender();
}

// LESSONS から現在ビューを構築して描画(ロード済み前提)。
function refreshViewRender() {
  if (state.view === "substitution") { renderSubstitution(); return; }
  const data = GQ.buildView(LESSONS, state.view, params());
  lastData = data;
  sortState.col = null;
  renderSummary(data);
  renderGroups(data);
}

function renderSummary(data) {
  $("#summary").innerHTML =
    `<span>該当レッスン <b>${data.total.toLocaleString()}</b> 件</span>` +
    `<span>グループ <b>${data.group_count}</b></span>` +
    `<span class="muted">ビュー: ${viewLabel(state.view)}</span>`;
}

function storeLink(r) {
  const store = (r.store || "").trim();
  if (!store) return "";
  const link = r.url
    ? `<a href="${escapeAttr(r.url)}" target="_blank" rel="noopener" class="store-link">${escapeHtml(store)}</a>`
    : escapeHtml(store);
  // ジム名を店舗名の前にチップで明示(店舗名にジム名が含まれる場合は省略)。
  const gym = (r.gym || "").trim();
  return (gym && !store.includes(gym))
    ? `<span class="chip-gym">${escapeHtml(gym)}</span>${link}`
    : link;
}

function noteText(r) {
  let n = r.note;
  if (Array.isArray(n)) n = n.join(" ");
  n = (n == null ? "" : String(n)).trim();
  if (["null", "none", "-"].includes(n.toLowerCase())) n = "";
  if (r.reservation_required) n = (n + " 要予約").trim();
  return n;
}

function lessonRow(r, opts) {
  const tags = [];
  if (r.genre === "有料") tags.push('<span class="tag-pay">有料</span>');
  if (r.reservation_required) tags.push('<span class="tag-res">要予約</span>');
  const studio = r.studio ? ` <span class="chip-studio">${escapeHtml(r.studio)}</span>` : "";
  const cells = [];
  if (opts.showDay) cells.push(`<td class="day">${escapeHtml(r.day || "")}</td>`);
  cells.push(`<td class="time">${escapeHtml(GQ.fmtTime(r))}</td>`);
  cells.push(`<td class="dur muted">${escapeHtml(GQ.fmtDuration(r))}</td>`);
  if (opts.showStore) cells.push(`<td>${storeLink(r)}<div class="muted">${escapeHtml(r.region || "")}</div></td>`);
  cells.push(`<td class="cls">${escapeHtml(r.class_name || "")} ${tags.join(" ")}${studio}</td>`);
  if (opts.showCategory) cells.push(`<td><span class="cat">${escapeHtml(r.category || "")}</span></td>`);
  cells.push(`<td>${escapeHtml(r.instructor || "")}</td>`);
  cells.push(`<td class="muted">${escapeHtml(noteText(r))}</td>`);
  return `<tr>${cells.join("")}</tr>`;
}

function tableCols(opts) {
  const cols = [];
  if (opts.showDay) cols.push(["day", "曜日"]);
  cols.push(["time", "時間"]);
  cols.push(["duration", "所要"]);
  if (opts.showStore) cols.push(["store", "店舗"]);
  cols.push(["class_name", "クラス"]);
  if (opts.showCategory) cols.push(["category", "カテゴリー"]);
  cols.push(["instructor", "先生"]);
  cols.push(["note", "備考"]);
  return cols;
}

function tableHeader(opts) {
  return "<tr>" + tableCols(opts).map(([k, label]) => {
    const mark = sortState.col === k ? `<span class="sort-mark">${sortState.dir === "asc" ? "▲" : "▼"}</span>` : "";
    return `<th class="sortable" data-col="${k}">${label}${mark}</th>`;
  }).join("") + "</tr>";
}

function sortRows(rows) {
  if (!sortState.col) return rows;
  const c = sortState.col, mul = sortState.dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    if (c === "time") return (GQ.startMin(a.start) - GQ.startMin(b.start)) * mul;
    if (c === "duration") return ((GQ.durationMin(a) ?? 1e9) - (GQ.durationMin(b) ?? 1e9)) * mul;
    if (c === "day") return (GQ.dayKey(a.day) - GQ.dayKey(b.day)) * mul;
    return String(a[c] || "").localeCompare(String(b[c] || ""), "ja") * mul;
  });
}

const opts_for = (v) => ({
  showDay: !(v === "day" || v === "hashigo"),
  showStore: v !== "store",
  showCategory: v !== "category",
});

function renderGroups(data) {
  if (!data.groups.length) { $("#main").innerHTML = '<div class="empty">該当するレッスンがありません。フィルタを調整してください。</div>'; return; }
  const opts = opts_for(state.view);
  const limit = currentLimit();
  let budget = limit, shown = 0;
  const out = [];
  for (const g of data.groups) {
    if (budget <= 0) break;
    const sorted = sortRows(g.rows);
    const vis = Number.isFinite(budget) ? sorted.slice(0, budget) : sorted;
    budget -= vis.length; shown += vis.length;
    const rows = vis.map((r) => lessonRow(r, opts)).join("");
    const cnt = vis.length < g.rows.length
      ? `<span class="cnt">（表示 ${vis.length} / ${g.count.toLocaleString()}件）</span>`
      : `<span class="cnt">${g.count.toLocaleString()}件</span>`;
    out.push(`<section class="group"><h2>${escapeHtml(g.key)} ${cnt}</h2><table><thead>${tableHeader(opts)}</thead><tbody>${rows}</tbody></table></section>`);
  }
  let html = out.join("");
  if (shown < data.total) {
    html += `<div class="truncate-warn">⚠ 該当 ${data.total.toLocaleString()}件中 ${shown.toLocaleString()}件のみ表示。表示件数を増やすか「制限なし」を選ぶか、フィルタで絞り込んでください。</div>`;
  }
  $("#main").innerHTML = html;
}

function renderSubstitution() {
  let rows = DAIKO.slice();
  if (state.region) rows = rows.filter((s) => s.region === state.region);
  if (state.prefecture) rows = rows.filter((s) => s.prefecture === state.prefecture);
  if (state.gym) rows = rows.filter((s) => s.gym_id === state.gym);
  if (state.q) {
    const q = state.q.normalize("NFKC").toUpperCase();
    rows = rows.filter((s) => (s.store || "").normalize("NFKC").toUpperCase().includes(q));
  }
  $("#summary").innerHTML = `<span>代行情報 <b>${rows.length.toLocaleString()}</b> 店舗</span><span class="muted">ビュー: 代行情報</span>`;
  if (!rows.length) { $("#main").innerHTML = '<div class="empty">該当する代行情報リンクがありません。</div>'; return; }
  const byRegion = new Map();
  for (const s of rows) { if (!byRegion.has(s.region)) byRegion.set(s.region, []); byRegion.get(s.region).push(s); }
  const order = META.regions;
  const keys = [...byRegion.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  $("#main").innerHTML =
    '<div class="note">各店舗の代行・休講・変更のお知らせページへのリンクです。</div>' +
    keys.map((k) => {
      const items = byRegion.get(k).sort((a, b) => (a.gym || "").localeCompare(b.gym || "", "ja"))
        .map((s) => `<tr><td>${escapeHtml(s.store || "")}</td><td class="muted">${escapeHtml(s.gym || "")}</td><td><a href="${escapeAttr(s.url)}" target="_blank" rel="noopener">代行情報ページ ↗</a></td></tr>`).join("");
      return `<section class="group"><h2>${escapeHtml(k)} <span class="cnt">${byRegion.get(k).length}店舗</span></h2><table><thead><tr><th>店舗</th><th>ジム</th><th>代行情報</th></tr></thead><tbody>${items}</tbody></table></section>`;
    }).join("");
}

// ---- イベント ----
function bind() {
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    state.view = t.dataset.view; setActiveTab(state.view); update();
  }));
  $("#f-region").addEventListener("change", (e) => {
    state.region = e.target.value;
    // エリアと都道府県は排他: エリア選択時は都道府県を「すべて」に戻す。
    if (state.region) { state.prefecture = ""; $("#f-prefecture").value = ""; }
    update();
  });
  $("#f-prefecture").addEventListener("change", (e) => {
    state.prefecture = e.target.value;
    // 都道府県選択時はエリアを「すべて」に戻す。
    if (state.prefecture) { state.region = ""; $("#f-region").value = ""; }
    update();
  });
  $("#f-gym").addEventListener("change", (e) => { state.gym = e.target.value; saveState(); refreshStoreOptions(); refreshInstructorOptions(); refreshViewRender(); });
  $("#f-day").addEventListener("change", (e) => { state.day = e.target.value; saveState(); refreshInstructorOptions(); refreshViewRender(); });
  $("#f-category").addEventListener("change", (e) => { state.category = e.target.value; saveState(); refreshInstructorOptions(); refreshViewRender(); });
  $("#f-store").addEventListener("change", (e) => { state.store_id = e.target.value; saveState(); refreshInstructorOptions(); refreshViewRender(); });
  $("#f-instructor").addEventListener("change", (e) => { state.instructor = e.target.value; saveState(); refreshViewRender(); });
  $("#f-limit").addEventListener("change", (e) => { state.limit = e.target.value; saveState(); if (lastData && state.view !== "substitution") renderGroups(lastData); });
  let t = null;
  $("#f-q").addEventListener("input", (e) => { state.q = e.target.value.trim(); clearTimeout(t); t = setTimeout(() => { saveState(); refreshInstructorOptions(); refreshViewRender(); }, 250); });
  $("#resetBtn").addEventListener("click", () => {
    // 地理スコープ(エリア/都道府県)は維持し、副次フィルタのみクリアする。
    Object.assign(state, { gym: "", day: "", category: "", store_id: "", instructor: "", q: "" });
    $("#f-gym").value = ""; $("#f-day").value = ""; $("#f-category").value = "";
    $("#f-store").value = ""; $("#f-q").value = "";
    refreshStoreOptions(); refreshInstructorOptions(); refreshViewRender();
  });
  $("#main").addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (th && lastData && state.view !== "substitution") {
      const c = th.dataset.col;
      if (sortState.col === c) sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      else { sortState.col = c; sortState.dir = "asc"; }
      renderGroups(lastData);
    }
  });
}

async function main() {
  loadState();
  try {
    await loadData();
  } catch (e) {
    $("#main").innerHTML = `<div class="empty">データの読み込みに失敗しました（${escapeHtml(e.message)}）。<br>data/ 配下のJSONをローカルサーバ経由で配信してください。</div>`;
    return;
  }
  // 初回(スコープ未保存)は東京都を既定にして、空表示や全件ロードを避ける。
  if (!state.prefecture && !state.region) {
    state.prefecture = PREF_BY_NAME.has("東京都")
      ? "東京都" : ((PREF_INDEX[0] && PREF_INDEX[0].name) || "");
  }
  fillControls();
  bind();
  await update();
}

main();
