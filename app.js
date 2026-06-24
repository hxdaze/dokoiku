"use strict";
// app.js — 静的SPA(どこいくZUMBA)。data/*.json を読み込み、query.js で集計し描画。

const $ = (s) => document.querySelector(s);
const STATE_KEY = "dokoiku_zumba_state_v1";
const THEME_KEY = "dokojim_theme";
const THEME_CYCLE = ["light", "dark", "pop"];

const state = {
  view: "day", region: "", prefecture: "", gym: "", day: "", category: "",
  store_id: "", instructor: "", instructor_id: "", iq: "", favview: "list", q: "", limit: "200",
};

// ジャンル(カテゴリー)アイコン。カテゴリー名(英語)→絵文字。
const CATEGORY_ICON = {
  "ZUMBA": "💃", "RITMOS": "💃", "BAILA": "💃", "SALSATION": "💃", "LATIN": "💃",
  "HULA": "🌺", "BELLY DANCE": "🪭", "HIP HOP": "🧢", "STREET DANCE": "🕺",
  "BALLET": "🩰", "JAZZ DANCE": "🎶", "STEP": "👟", "BOXING": "🥊",
  "MARTIAL ARTS": "🥋", "KUNG FU": "🐉",
  "PILATES": "🤸‍♀️", "HOT YOGA": "♨️", "YOGA": "🧘", "AERIAL YOGA": "🪂",
  "YOGA & PILATES": "🧘",
  "AQUA": "🌊", "SWIMMING": "🏊", "CYCLING": "🚴",
  "RUNNING": "🏃", "STRENGTH & CORE": "💪", "FAT BURN": "🔥",
  "STRETCH & RELAX": "🌿", "WELLNESS": "🍀", "KIDS": "🧒", "AEROBICS": "🤸",
  "OTHER": "✨",
};
function catIcon(cat) { return CATEGORY_ICON[cat] || "✨"; }

// レッスン行の先生名をイントラ検索へのリンクにする(instructor_id があれば)。
function instructorCell(r) {
  const name = r && r.instructor ? r.instructor : "";
  if (name && r.instructor_id && INSTRUCTOR_BY_ID.has(r.instructor_id)) {
    return `<a href="#" class="ins-link" data-iid="${escapeAttr(r.instructor_id)}" `
      + `title="${escapeAttr(name)}の出講先を見る">${escapeHtml(name)}</a>`;
  }
  return escapeHtml(name);
}

// 指定イントラのイントラ検索(個別ページ)へ遷移する。
function gotoInstructor(iid) {
  if (!INSTRUCTOR_BY_ID.has(iid)) return;
  state.view = "search";
  state.instructor_id = iid;
  setActiveTab("search");
  saveState();
  update();
}

// ---- テーマ(配色) ----
function applyTheme(name) {
  if (!THEME_CYCLE.includes(name)) name = "light";
  document.documentElement.setAttribute("data-theme", name);
  try { localStorage.setItem(THEME_KEY, name); } catch (_e) {}
  const meta = document.querySelector('meta[name="theme-color"]');
  const accent = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent").trim();
  if (meta && accent) meta.setAttribute("content", accent);
}
function initTheme() {
  let saved = "light";
  try { saved = localStorage.getItem(THEME_KEY) || "light"; } catch (_e) {}
  applyTheme(saved);
}
function cycleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(cur) + 1) % THEME_CYCLE.length];
  applyTheme(next);
}

// ---- URLパラメータ(共有・SEO用ディープリンク) ----
// ?region= / ?pref= / ?gym= / ?cat= / ?day= / ?q= / ?view= を解釈・反映する。
function readUrlParams() {
  const p = new URLSearchParams(location.search);
  const map = { region: "region", pref: "prefecture", gym: "gym",
    cat: "category", day: "day", q: "q", view: "view" };
  for (const [k, sk] of Object.entries(map)) {
    const v = p.get(k);
    if (v != null && v !== "") state[sk] = v;
  }
}
function syncUrl() {
  const p = new URLSearchParams();
  if (state.region) p.set("region", state.region);
  if (state.prefecture) p.set("pref", state.prefecture);
  if (state.gym) p.set("gym", state.gym);
  if (state.category) p.set("cat", state.category);
  if (state.day) p.set("day", state.day);
  if (state.q) p.set("q", state.q);
  if (state.view && state.view !== "day") p.set("view", state.view);
  const qs = p.toString();
  const url = location.pathname + (qs ? "?" + qs : "");
  try { history.replaceState(null, "", url); } catch (_e) {}
}

let META = null;
let LESSONS = [];      // 現在ロード済みの全レッスン(都道府県パートの連結)
let STORES = [];
let DAIKO = [];
let STORE_URL = new Map();   // gym_id|store_id -> url
let STORE_INFO = new Map();  // gym_id|store_id -> {lat,lon,phone,phone_fmt,address}
let GYM_LABEL = new Map();
let INSTRUCTORS = [];                  // イントラDB(サマリ配列)
const INSTRUCTOR_BY_ID = new Map();    // id -> サマリ
let lastData = null;
const sortState = { col: null, dir: "asc" };

// ---- お気に入り(localStorage・サーバ不要) ----
const FAV_KEY = "gymfav_v1";
let FAV = new Map();                   // favKey -> レッスンobj(表示に必要な項目)
const LESSON_BY_FK = new Map();        // 描画中レッスンの favKey -> obj(トグル時の参照用)

function loadFav() {
  try {
    const arr = JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
    FAV = new Map(arr.map((o) => [favKey(o), o]));
  } catch (_e) { FAV = new Map(); }
}
function saveFav() {
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...FAV.values()])); } catch (_e) {}
}
function favKey(r) {
  return [r.gym_id, r.store_id, r.day, r.start, r.end, r.class_name, r.studio || ""].join("|");
}
function isFav(r) { return FAV.has(favKey(r)); }
function favObj(r) {
  // 一覧/カレンダー表示に必要な項目だけ保存(遅延ロード不要にする)。
  return {
    gym_id: r.gym_id, gym: r.gym || r.gym_label, store_id: r.store_id, store: r.store,
    region: r.region, prefecture: r.prefecture, day: r.day, start: r.start, end: r.end,
    class_name: r.class_name, category: r.category, instructor: r.instructor,
    instructor_id: r.instructor_id, studio: r.studio, url: r.url,
    reservation_required: r.reservation_required, genre: r.genre, note: r.note,
  };
}
function toggleFav(fk) {
  if (FAV.has(fk)) { FAV.delete(fk); }
  else {
    const o = LESSON_BY_FK.get(fk) || null;
    if (o) FAV.set(fk, favObj(o));
  }
  saveFav();
}
function favStar(r) {
  const fk = favKey(r);
  const on = FAV.has(fk);
  return `<button class="favbtn${on ? " on" : ""}" data-fk="${escapeAttr(fk)}" ` +
    `title="${on ? "お気に入り解除" : "お気に入りに追加"}" aria-pressed="${on}">` +
    `${on ? "★" : "☆"}</button>`;
}

// --- 都道府県別 遅延ロード管理 ---
const LESSON_PARTS = new Map();      // 都道府県名 -> レッスン配列
const LOADED = new Set();            // ロード済み都道府県名
let PREF_INDEX = [];                 // [{name, slug, region, count}]
const PREF_BY_NAME = new Map();      // 都道府県名 -> {slug,...}
const PREFS_BY_REGION = new Map();   // 地域 -> [都道府県名]
const GYM_PREFS = new Map();         // gym_id -> Set(都道府県名)
let ALL_LOADED = false;              // 「全国読み込み」実行済みか

// ---- 永続化 ----
function saveState() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (_e) {}
  syncUrl();
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
    for (const k of Object.keys(state)) if (typeof s[k] === "string") state[k] = s[k];
  } catch (_e) {}
  // エリアと都道府県は排他。旧バージョンで両方保存された状態は都道府県を優先。
  if (state.region && state.prefecture) state.region = "";
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

// ---- パス解決(GitHub Pagesサブディレクトリ / iOS WebClip対策) ----
// ホーム画面追加起動時は location がずれることがあるため、<base> または
// window.SITE_BASE で必ず正しいパスから data/*.json を fetch する。
function siteBase() {
  if (typeof window.SITE_BASE === "string" && window.SITE_BASE) {
    const b = window.SITE_BASE;
    return b.endsWith("/") ? b : b + "/";
  }
  const base = document.querySelector("base[href]");
  if (base) {
    const b = base.getAttribute("href") || "/";
    return b.endsWith("/") ? b : b + "/";
  }
  const p = location.pathname || "/";
  if (p.endsWith("/")) return p;
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i + 1) : "/";
}
function absUrl(path) {
  const rel = String(path || "").replace(/^\.\//, "");
  const b = siteBase();
  if (rel.startsWith("/")) return rel;
  return b + rel;
}

// ---- データ読み込み ----
// キャッシュ回避: ビルド版(window.BUILD_VERSION)をクエリに付与。
function withVer(url) {
  const v = (typeof window !== "undefined" && window.BUILD_VERSION) || "";
  const u = absUrl(url);
  return v ? `${u}?v=${encodeURIComponent(v)}` : u;
}

// 初期ロードは meta/stores/daiko のみ(軽量)。レッスン本体は都道府県単位で
// スコープ選択時に遅延ロードする(一括DLによるモバイルのメモリ枯渇を回避)。
async function loadData() {
  const [meta, stores, daiko, instructors] = await Promise.all([
    fetch(withVer("data/meta.json")).then((r) => {
      if (!r.ok) throw new Error(`meta.json HTTP ${r.status}`);
      return r.json();
    }),
    fetch(withVer("data/stores.json")).then((r) => {
      if (!r.ok) throw new Error(`stores.json HTTP ${r.status}`);
      return r.json();
    }),
    fetch(withVer("data/daiko.json")).then((r) => r.ok ? r.json() : []).catch(() => []),
    fetch(withVer("data/instructors.json")).then((r) => r.ok ? r.json() : { instructors: [] }).catch(() => ({ instructors: [] })),
  ]);
  META = meta;
  STORES = stores;
  DAIKO = daiko;
  INSTRUCTORS = (instructors && instructors.instructors) || [];
  for (const ins of INSTRUCTORS) INSTRUCTOR_BY_ID.set(ins.id, ins);
  loadFav();
  GQ.setOrders(meta);
  for (const g of meta.gyms) GYM_LABEL.set(g.id, g.label);
  for (const s of stores) {
    const key = s.gym_id + "|" + s.store_id;
    STORE_URL.set(key, s.url);
    STORE_INFO.set(key, {
      lat: s.lat, lon: s.lon, phone: s.phone, phone_fmt: s.phone_fmt,
      address: s.address, reservation_url: s.reservation_url || null,
    });
    if (s.gym_id && s.prefecture) {
      if (!GYM_PREFS.has(s.gym_id)) GYM_PREFS.set(s.gym_id, new Set());
      GYM_PREFS.get(s.gym_id).add(s.prefecture);
    }
  }

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
    const key = o.gym_id + "|" + o.store_id;
    o.url = STORE_URL.get(key) || null;
    const info = STORE_INFO.get(key);
    if (info) {
      o.lat = info.lat; o.lon = info.lon;
      o.phone = info.phone; o.phone_fmt = info.phone_fmt;
      o.address = o.address || info.address;
      o.reservation_url = info.reservation_url || null;
    }
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
function gymIdsFromQuery(q) {
  const n = (q || "").normalize("NFKC").toUpperCase();
  if (!n) return [];
  const out = [];
  for (const [id, label] of GYM_LABEL.entries()) {
    const nl = (label || "").normalize("NFKC").toUpperCase();
    if (nl.includes(n) || n.includes(nl)) out.push(id);
  }
  return out;
}

function prefsForGyms(gymIds) {
  const prefs = new Set();
  for (const gid of gymIds) {
    const ps = GYM_PREFS.get(gid);
    if (ps) ps.forEach((p) => prefs.add(p));
  }
  return prefs.size ? [...prefs] : null;
}

function scopePrefs() {
  if (state.prefecture) return [state.prefecture];
  if (state.region) return (PREFS_BY_REGION.get(state.region) || []).slice();
  if (state.gym) {
    const prefs = prefsForGyms([state.gym]);
    if (prefs) return prefs;
  }
  if (state.store_id) {
    const s = STORES.find((x) => String(x.store_id) === String(state.store_id));
    if (s && s.prefecture) return [s.prefecture];
  }
  // フリーワードがジム名に一致する場合(例:「イオンスポーツ」)も該当都道府県をロード。
  if (state.q && !state.gym) {
    const gids = gymIdsFromQuery(state.q);
    if (gids.length === 1) {
      const prefs = prefsForGyms(gids);
      if (prefs) return prefs;
    }
  }
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
  setOptions($("#f-category"), META.categories,
    { label: (c) => `${catIcon(c)} ${c}` });
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
  setOptions($("#f-store"), list, {
    value: (s) => s.store_id,
    label: (s) => GQ.storeLabel({
      store: s.store,
      gym: state.gym ? "" : (GYM_LABEL.get(s.gym_id) || ""),
    }),
  });
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
  // 地図ビューは集中レイアウト(説明文・敬意バナー・不要フィルタを隠す)。
  document.body.classList.toggle("view-map", v === "map");
  // ビュー切替時は先頭へスクロールしてヘッダー/操作部を見せる。
  try { window.scrollTo({ top: 0, behavior: "auto" }); } catch (_e) { window.scrollTo(0, 0); }
}

function viewLabel(v) {
  return { day: "曜日別", timeband: "時間帯別", store: "店舗別", category: "カテゴリー別",
    instructor: "先生別", search: "イントラ検索", fav: "お気に入り", hashigo: "はしご",
    gym: "ジム別", substitution: "代行情報", map: "近くで探す" }[v] || v;
}

function currentLimit() {
  const n = parseInt(state.limit, 10);
  return (!Number.isFinite(n) || n <= 0) ? Infinity : n;
}

// スコープ未選択時の案内(全国読み込みボタン付き)。
function renderChooseScope() {
  $("#summary").innerHTML = "";
  $("#main").innerHTML =
    '<div class="empty">エリア・都道府県・ジムのいずれかを選択してください。' +
    '<br>ジム名だけ選んでも表示できます（例: イオンスポーツクラブ）。' +
    '<div style="margin-top:14px;"><button class="btn" id="loadAllBtn">全国をまとめて読み込む</button></div></div>';
  const b = document.getElementById("loadAllBtn");
  if (b) b.addEventListener("click", loadAll);
}

// ---- イントラ検索ビュー(名寄せ済みイントラDBを検索→出講先を表示) ----
function renderInstructorView() {
  if (state.instructor_id && INSTRUCTOR_BY_ID.has(state.instructor_id)) {
    return renderInstructorDetail(INSTRUCTOR_BY_ID.get(state.instructor_id));
  }
  return renderInstructorList();
}

function renderInstructorList() {
  const q = (state.iq || "").normalize("NFKC").toLowerCase().replace(/[\s　]/g, "");
  let list = [];
  if (q) {
    list = INSTRUCTORS.filter((s) => {
      const hay = (s.name + " " + (s.aliases || []).join(" "))
        .normalize("NFKC").toLowerCase().replace(/[\s　]/g, "");
      return hay.includes(q);
    });
  }
  $("#summary").innerHTML =
    `<span>登録イントラ <b>${INSTRUCTORS.length.toLocaleString()}</b> 名(名寄せ済)</span>` +
    (q ? `<span>該当 <b>${list.length.toLocaleString()}</b> 名</span>` : "") +
    `<span class="muted">ビュー: イントラ検索</span>`;
  const box = `<div class="ins-search">` +
    `<input id="insQ" type="search" autocomplete="off" enterkeyhint="search" ` +
    `placeholder="イントラ名で検索（例: 高嶋 / さとう / Natsumi）" value="${escapeAttr(state.iq || "")}">` +
    `<button class="btn" id="insGo">🔎 検索</button></div>`;
  if (!q) {
    $("#main").innerHTML = box +
      '<div class="empty">イントラ名を入力して検索してください。<br>表記ゆれ・店舗をまたいだ同一人物は名寄せ済みです。</div>';
  } else if (!list.length) {
    $("#main").innerHTML = box + '<div class="empty">該当するイントラが見つかりません。</div>';
  } else {
    const cards = list.slice(0, 300).map((s) => {
      const genres = (s.genres || []).slice(0, 5).join(" / ");
      const prefs = (s.prefs || []).slice(0, 4).join("・") + ((s.prefs || []).length > 4 ? " 他" : "");
      const alias = s.aliases && s.aliases.length
        ? `<span class="ins-alias"> (${escapeHtml(s.aliases.slice(0, 3).join(", "))})</span>` : "";
      return `<button class="ins-card" data-id="${escapeAttr(s.id)}">
        <div class="ins-name">${escapeHtml(s.name)}${alias}</div>
        <div class="ins-meta">${s.gym_count}ジム ｜ ${s.lesson_count}レッスン ｜ ${escapeHtml(prefs)}</div>
        <div class="ins-genres">${escapeHtml(genres)}</div></button>`;
    }).join("");
    $("#main").innerHTML = box + `<div class="ins-list">${cards}</div>` +
      (list.length > 300 ? `<div class="muted" style="padding:8px">上位300名を表示（${list.length}名中）。さらに絞り込んでください。</div>` : "");
    $("#main").querySelectorAll(".ins-card").forEach((b) => b.addEventListener("click", () => {
      state.instructor_id = b.dataset.id; saveState(); renderInstructorView();
    }));
  }
  // 検索はリアルタイムではなく、Enter または検索ボタンで実行する。
  // (日本語入力の変換確定Enterでは実行しない: isComposing をガード)
  const inp = document.getElementById("insQ");
  const runSearch = () => {
    if (!inp) return;
    const v = inp.value.trim();
    if (v === (state.iq || "")) return;  // 変化なしなら再描画しない
    state.iq = v; saveState(); renderInstructorList();
  };
  if (inp) {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); runSearch(); }
    });
    inp.focus();
    const val = inp.value; inp.value = ""; inp.value = val;  // カーソルを末尾へ
  }
  const go = document.getElementById("insGo");
  if (go) go.addEventListener("click", runSearch);
}

async function renderInstructorDetail(ins) {
  const prefs = (ins.prefs && ins.prefs.length) ? ins.prefs : PREF_INDEX.map((p) => p.name);
  $("#main").innerHTML = '<div class="loading">読み込み中…</div>';
  await ensurePrefs(prefs);
  rebuildLessons();
  const rows = LESSONS.filter((r) => r.instructor_id === ins.id);
  rows.sort((a, b) =>
    (a.gym || "").localeCompare(b.gym || "", "ja") ||
    (a.store || "").localeCompare(b.store || "", "ja") ||
    GQ.WEEK.indexOf(a.day) - GQ.WEEK.indexOf(b.day) ||
    (a.start || "").localeCompare(b.start || ""));
  $("#summary").innerHTML =
    `<span><b>${escapeHtml(ins.name)}</b></span>` +
    `<span>出講 <b>${rows.length}</b> レッスン</span>` +
    `<span class="muted">${ins.gym_count}ジム / ${(ins.prefs || []).length}都道府県</span>`;
  const alias = ins.aliases && ins.aliases.length
    ? `<span class="muted"> 別表記: ${escapeHtml(ins.aliases.join(", "))}</span>` : "";
  const head = `<div class="ins-search"><button class="btn" id="insBack">← イントラ検索へ戻る</button>` +
    `<b style="margin-left:10px">${escapeHtml(ins.name)}</b>${alias}</div>`;
  // クラス検索と同じ行(☆お気に入り・店舗/先生リンク・Gカレ登録)で表示する。
  const opts = { showDay: true, showStore: true, showCategory: true };
  $("#main").innerHTML = head + (rows.length
    ? `<table class="grid"><thead>${tableHeader(opts)}</thead><tbody>`
      + rows.map((r) => lessonRow(r, opts)).join("") + "</tbody></table>"
    : '<div class="empty">レッスンが見つかりませんでした。</div>');
  const bk = document.getElementById("insBack");
  if (bk) bk.addEventListener("click", () => { state.instructor_id = ""; saveState(); renderInstructorView(); });
}

// ---- お気に入りビュー(一覧／週間カレンダー。端末内localStorage) ----
function renderFavView() {
  const favs = [...FAV.values()];
  favs.forEach((r) => LESSON_BY_FK.set(favKey(r), r));
  const mode = state.favview === "cal" ? "cal" : "list";
  $("#summary").innerHTML =
    `<span>お気に入り <b>${favs.length}</b> 件</span>` +
    `<span class="muted">端末内に保存(ログイン不要)</span>`;
  const head = `<div class="ins-search fav-head">` +
    `<div class="fav-modes">` +
    `<button class="btn fav-mode${mode === "list" ? " active" : ""}" data-fmode="list">📋 一覧</button>` +
    `<button class="btn fav-mode${mode === "cal" ? " active" : ""}" data-fmode="cal">📅 週カレンダー</button>` +
    `</div>` +
    (favs.length ? `<button class="btn" id="favClear">全て解除</button>` : "") +
    `</div>`;
  let body;
  if (!favs.length) {
    body = '<div class="empty">お気に入りはまだありません。<br>' +
      '各レッスンの ☆ を押すと、ここに保存されます（この端末内に保存・ログイン不要）。</div>';
  } else if (mode === "cal") {
    body = favCalendarHtml(favs);
  } else {
    body = favListHtml(favs);
  }
  $("#main").innerHTML = head + body;
  $("#main").querySelectorAll(".fav-mode").forEach((b) =>
    b.addEventListener("click", () => { state.favview = b.dataset.fmode; saveState(); renderFavView(); }));
  const clr = document.getElementById("favClear");
  if (clr) clr.addEventListener("click", () => {
    if (confirm("お気に入りを全て解除しますか？")) { FAV.clear(); saveFav(); renderFavView(); }
  });
}

function favListHtml(favs) {
  const opts = { showDay: true, showStore: true, showCategory: true };
  const rows = favs.slice().sort((a, b) =>
    GQ.dayKey(a.day) - GQ.dayKey(b.day) || GQ.startMin(a.start) - GQ.startMin(b.start));
  return `<table class="grid"><thead>${tableHeader(opts)}</thead><tbody>` +
    rows.map((r) => lessonRow(r, opts)).join("") + "</tbody></table>";
}

function favCalendarHtml(favs) {
  const days = GQ.WEEK;
  const byDay = {};
  days.forEach((d) => { byDay[d] = []; });
  favs.forEach((r) => { (byDay[r.day] || (byDay[r.day] = [])).push(r); });
  const cols = days.map((d) => {
    const items = (byDay[d] || []).sort((a, b) => GQ.startMin(a.start) - GQ.startMin(b.start));
    const evs = items.map((r) => `<div class="fav-ev">` +
      `<button class="favbtn on fav-ev-x" data-fk="${escapeAttr(favKey(r))}" title="お気に入り解除">★</button>` +
      `<div class="fav-ev-t">${escapeHtml((r.start || "") + "〜" + (r.end || ""))}</div>` +
      `<div class="fav-ev-c">${catIcon(r.category)} ${escapeHtml(r.class_name || "")}</div>` +
      `<div class="fav-ev-s muted">${escapeHtml(r.gym || "")} ${escapeHtml(r.store || "")}` +
      `${r.studio ? " / " + escapeHtml(r.studio) : ""}</div>` +
      `${r.instructor ? `<div class="fav-ev-i muted">${instructorCell(r)}</div>` : ""}</div>`).join("")
      || '<div class="fav-empty muted">—</div>';
    return `<div class="fav-col"><div class="fav-col-h">${d}</div>${evs}</div>`;
  }).join("");
  return `<div class="fav-cal">${cols}</div>`;
}

// 選択スコープのデータを確保してから、店舗/先生の選択肢と一覧を更新する。
async function update() {
  saveState();
  if (state.view === "substitution") { renderSubstitution(); return; }
  if (state.view === "map") { renderMap(); return; }
  if (state.view === "search") { await renderInstructorView(); return; }
  if (state.view === "fav") { renderFavView(); return; }
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
  if (state.view === "map") { renderMap(); return; }
  if (state.view === "search") { renderInstructorView(); return; }
  if (state.view === "fav") { renderFavView(); return; }
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

// 地図(Googleマップ)へのリンクURL。座標があれば座標、無ければ住所で検索。
function mapsUrl(r) {
  if (typeof r.lat === "number" && typeof r.lon === "number") {
    return `https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lon}`;
  }
  if (r.address) {
    return "https://www.google.com/maps/search/?api=1&query="
      + encodeURIComponent(r.address);
  }
  return null;
}

// 店舗名の後ろに付く 地図/電話/HP のアイコンリンク。
function storeIcons(r) {
  const out = [];
  const mu = mapsUrl(r);
  if (mu) {
    out.push(`<a class="store-ico map-ico" href="${escapeAttr(mu)}" target="_blank" `
      + `rel="noopener" title="地図で見る（Googleマップ）" aria-label="地図で見る">📍</a>`);
  }
  if (r.phone) {
    out.push(`<a class="store-ico tel-ico" href="tel:${escapeAttr(r.phone)}" `
      + `title="電話する ${escapeAttr(r.phone_fmt || r.phone)}" aria-label="電話する">📞</a>`);
  }
  if (r.url) {
    out.push(`<a class="store-ico web-ico" href="${escapeAttr(r.url)}" target="_blank" `
      + `rel="noopener" title="公式サイト" aria-label="公式サイト">🌐</a>`);
  }
  if (r.reservation_url) {
    out.push(`<a class="store-ico reserve-ico" href="${escapeAttr(r.reservation_url)}" target="_blank" `
      + `rel="noopener" title="予約サイト" aria-label="予約サイト">🎫</a>`);
  }
  return out.length ? ` <span class="store-icos">${out.join("")}</span>` : "";
}

function storeLink(r) {
  const store = (r.store || "").trim();
  if (!store) return "";
  const label = GQ.storeLabel(r);
  const text = r.url
    ? `<a href="${escapeAttr(r.url)}" target="_blank" rel="noopener" class="store-link">${escapeHtml(label)}</a>`
    : escapeHtml(label);
  return text + storeIcons(r);
}

function storeGroupHead(r) {
  const label = GQ.storeLabel(r);
  const inner = r.url
    ? `<a class="store-link store-head-link" href="${escapeAttr(r.url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`
    : escapeHtml(label);
  return inner + storeIcons(r);
}

function noteText(r) {
  let n = r.note;
  if (Array.isArray(n)) n = n.join(" ");
  n = (n == null ? "" : String(n)).trim();
  if (["null", "none", "-"].includes(n.toLowerCase())) n = "";
  if (r.reservation_required) n = (n + " 要予約").trim();
  return n;
}

// ---- Googleカレンダー登録リンク ----
// 週間レッスン(曜日+時刻)を、直近の該当曜日を初回とする毎週繰り返し予定として
// Googleカレンダーに登録するための TEMPLATE URL を生成する。
const _BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];   // GQ.WEEK と同順
function _hm(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(s || "");
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
}
function _pad2(n) { return String(n).padStart(2, "0"); }
function _fmtDT(d, h, mi) {
  return `${d.getFullYear()}${_pad2(d.getMonth() + 1)}${_pad2(d.getDate())}T${_pad2(h)}${_pad2(mi)}00`;
}
function gcalUrl(r) {
  const dayIdx = GQ.WEEK.indexOf(r.day);
  const sh = _hm(r.start);
  if (dayIdx < 0 || !sh) return "";
  // 終了時刻: 無ければ開始+60分。
  let eh = _hm(r.end);
  let endTotal = eh ? eh[0] * 60 + eh[1] : (sh[0] * 60 + sh[1] + 60);
  const endH = Math.floor(endTotal / 60) % 24, endM = endTotal % 60;
  // 直近の該当曜日(JS: 0=日..6=土 / 当アプリ: 0=月..6=日)。
  const jsTarget = (dayIdx + 1) % 7;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((jsTarget - d.getDay() + 7) % 7));
  const dates = `${_fmtDT(d, sh[0], sh[1])}/${_fmtDT(d, endH, endM)}`;
  const title = [r.class_name, r.studio].filter(Boolean).join(" / ") || "レッスン";
  const detail = [
    r.store ? `店舗: ${storeLabel(r)}` : "",
    r.instructor ? `先生: ${r.instructor}` : "",
    r.studio ? `スタジオ: ${r.studio}` : "",
    noteText(r) ? `備考: ${noteText(r)}` : "",
    r.url ? `公式: ${r.url}` : "",
    "※スケジュールは変更される場合があります。最新は公式をご確認ください。",
  ].filter(Boolean).join("\n");
  const params = new URLSearchParams({
    action: "TEMPLATE", text: title, dates,
    details: detail, location: r.store || "", ctz: "Asia/Tokyo",
    recur: `RRULE:FREQ=WEEKLY;BYDAY=${_BYDAY[dayIdx]}`,
  });
  return "https://calendar.google.com/calendar/render?" + params.toString();
}
function gcalIcon(r) {
  const u = gcalUrl(r);
  if (!u) return "";
  return `<a class="gcal-ico" href="${escapeAttr(u)}" target="_blank" rel="noopener" `
    + `title="Googleカレンダーに毎週の予定として登録" aria-label="Googleカレンダーに登録">📅</a>`;
}

function gcalCell(r) {
  const u = gcalUrl(r);
  if (!u) return "";
  return `<a class="gcal-link" href="${escapeAttr(u)}" target="_blank" rel="noopener" `
    + `title="Googleカレンダーに毎週の予定として登録">📅</a>`;
}

function lessonRow(r, opts) {
  const tags = [];
  if (r.genre === "有料") tags.push('<span class="tag-pay">有料</span>');
  if (r.reservation_required) tags.push('<span class="tag-res">要予約</span>');
  const studio = r.studio ? ` <span class="chip-studio">${escapeHtml(r.studio)}</span>` : "";
  LESSON_BY_FK.set(favKey(r), r);
  const cells = [];
  cells.push(`<td class="fav">${favStar(r)}</td>`);
  if (opts.showDay) cells.push(`<td class="day">${escapeHtml(r.day || "")}</td>`);
  cells.push(`<td class="time">${gcalIcon(r)}${escapeHtml(GQ.fmtTime(r))}</td>`);
  cells.push(`<td class="dur muted">${escapeHtml(GQ.fmtDuration(r))}</td>`);
  if (opts.showStore) cells.push(`<td>${storeLink(r)}<div class="muted">${escapeHtml(r.region || "")}</div></td>`);
  cells.push(`<td class="cls">${escapeHtml(r.class_name || "")} ${tags.join(" ")}${studio}</td>`);
  if (opts.showCategory) cells.push(`<td><span class="cat"><span class="cat-ico">${catIcon(r.category)}</span>${escapeHtml(r.category || "")}</span></td>`);
  cells.push(`<td class="instructor">${instructorCell(r)}</td>`);
  cells.push(`<td class="muted">${escapeHtml(noteText(r))}</td>`);
  cells.push(`<td class="gcal">${gcalCell(r)}</td>`);
  return `<tr>${cells.join("")}</tr>`;
}

function tableCols(opts) {
  const cols = [];
  cols.push(["fav", "★"]);
  if (opts.showDay) cols.push(["day", "曜日"]);
  cols.push(["time", "時間"]);
  cols.push(["duration", "所要"]);
  if (opts.showStore) cols.push(["store", "店舗"]);
  cols.push(["class_name", "クラス"]);
  if (opts.showCategory) cols.push(["category", "カテゴリー"]);
  cols.push(["instructor", "先生"]);
  cols.push(["note", "備考"]);
  cols.push(["gcal", "登録"]);
  return cols;
}

function tableHeader(opts) {
  return "<tr>" + tableCols(opts).map(([k, label]) => {
    // 「登録」(Googleカレンダー)・「★」(お気に入り)列はソート対象外。
    if (k === "gcal" || k === "fav") return `<th class="nosort ${k}-col">${label}</th>`;
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
    const gicon = state.view === "category"
      ? `<span class="cat-ico">${catIcon(g.key)}</span> ` : "";
    // 店舗別表示では見出し(店舗名)をHPリンク化し、地図/電話/HPアイコンを付与。
    const headTitle = (state.view === "store" && g.rows.length)
      ? storeGroupHead(g.rows[0]) : `${escapeHtml(g.key)}`;
    const headIcons = "";
    out.push(`<section class="group"><h2>${gicon}${headTitle}${headIcons} ${cnt}</h2><table><thead>${tableHeader(opts)}</thead><tbody>${rows}</tbody></table></section>`);
  }
  let html = out.join("");
  if (shown < data.total) {
    html += `<div class="truncate-warn">⚠ 該当 ${data.total.toLocaleString()}件中 ${shown.toLocaleString()}件のみ表示。表示件数を増やすか「制限なし」を選ぶか、フィルタで絞り込んでください。</div>`;
  }
  $("#main").innerHTML = html;
}

// ==== 地図(近くで探す) ====
let _leafletPromise = null;
let MAP = null;            // 現在のLeafletマップ
let MAP_USER = null;       // 現在地マーカー/円のレイヤ群

function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (_leafletPromise) return _leafletPromise;
  _leafletPromise = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    s.crossOrigin = "";
    s.onload = () => res();
    s.onerror = () => rej(new Error("地図ライブラリの読み込みに失敗しました"));
    document.head.appendChild(s);
  });
  return _leafletPromise;
}

// 現在のスコープ(エリア/都道府県/ジム)に合致し、座標を持つ店舗。
function storesForMap() {
  let list = STORES.filter((s) => typeof s.lat === "number" && typeof s.lon === "number");
  if (state.region) list = list.filter((s) => s.region === state.region);
  if (state.prefecture) list = list.filter((s) => s.prefecture === state.prefecture);
  if (state.gym) list = list.filter((s) => s.gym_id === state.gym);
  return list;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// マーカーのポップアップから「この店舗のレッスンを見る」操作。
function gotoStore(s) {
  state.view = "store";
  state.region = "";
  state.prefecture = s.prefecture || "";
  state.gym = s.gym_id || "";
  state.store_id = String(s.store_id || "");
  setActiveTab("store");
  const set = (sel, v) => { const el = $(sel); if (el) el.value = v; };
  set("#f-region", ""); set("#f-prefecture", state.prefecture);
  set("#f-gym", state.gym);
  refreshStoreOptions(); set("#f-store", state.store_id);
  update();
}

async function renderMap() {
  const list = storesForMap();
  $("#summary").innerHTML =
    `<span>地図上の店舗 <b>${list.length.toLocaleString()}</b> 件</span>` +
    `<span class="muted">ビュー: 近くで探す</span>`;
  $("#main").innerHTML =
    '<div id="mapView">' +
    '<div class="map-toolbar">' +
    '  <button class="btn locate" id="locateBtn">📍 現在地から探す</button>' +
    '  <label>半径 <select id="mapRadius">' +
    '    <option value="0">指定なし</option>' +
    '    <option value="1">1km</option><option value="2">2km</option>' +
    '    <option value="3">3km</option><option value="5" selected>5km</option>' +
    '    <option value="10">10km</option><option value="20">20km</option>' +
    '  </select></label>' +
    '  <span class="map-hint" id="mapStatus"></span>' +
    '</div>' +
    '<div id="mapCanvas"></div>' +
    '<div class="map-hint">ピンをタップすると店舗の時間割へ移動できます。エリア・都道府県・ジムの絞り込みは上のフィルタと連動します。</div>' +
    '</div>';

  if (!list.length) {
    $("#mapStatus").textContent = "この条件では位置情報付きの店舗がありません。フィルタを広げてください。";
    return;
  }

  try {
    await loadLeaflet();
  } catch (e) {
    $("#mapCanvas").innerHTML =
      `<div class="empty">地図を表示できませんでした（${escapeHtml(e.message)}）。オフライン環境では地図機能は利用できません。</div>`;
    return;
  }

  try { if (MAP) { MAP.remove(); } } catch (_e) {}
  MAP = null; MAP_USER = null;
  MAP = L.map("mapCanvas", { scrollWheelZoom: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(MAP);

  const markers = [];
  for (const s of list) {
    const m = L.marker([s.lat, s.lon]);
    const gymLabel = GYM_LABEL.get(s.gym_id) || s.gym || "";
    const popLabel = GQ.storeLabel({ store: s.store, gym: gymLabel });
    m._store = s;
    const addr = s.address
      ? `<div class="map-pop-addr">${escapeHtml(s.address)}</div>` : "";
    const tel = s.phone
      ? `<div class="map-pop-tel">☎ <a href="tel:${escapeAttr(s.phone)}">${escapeHtml(s.phone_fmt || s.phone)}</a></div>` : "";
    const web = s.url
      ? `<div class="map-pop-web"><a href="${escapeAttr(s.url)}" target="_blank" rel="noopener">🌐 公式サイト</a></div>` : "";
    const reserve = s.reservation_url
      ? `<div class="map-pop-reserve"><a href="${escapeAttr(s.reservation_url)}" target="_blank" rel="noopener">🎫 予約サイト</a></div>` : "";
    const hours = s.hours
      ? `<div class="map-pop-info">🕐 ${escapeHtml(s.hours)}</div>` : "";
    const closed = s.closed
      ? `<div class="map-pop-info">休 ${escapeHtml(s.closed)}</div>` : "";
    m.bindPopup(
      `<div class="map-pop-name">${escapeHtml(popLabel)}</div>` +
      addr + web + reserve + tel + hours + closed +
      `<button class="map-pop-btn" type="button">この店舗のレッスンを見る ↗</button>`);
    m.addTo(MAP);
    markers.push(m);
  }
  const group = L.featureGroup(markers);
  MAP.fitBounds(group.getBounds().pad(0.15));

  MAP.on("popupopen", (e) => {
    const node = e.popup._contentNode;
    const btn = node && node.querySelector(".map-pop-btn");
    const s = e.popup._source && e.popup._source._store;
    if (btn && s) btn.onclick = () => gotoStore(s);
  });

  // 現在地から半径内へ絞り込む。
  const locate = () => {
    if (!navigator.geolocation) { $("#mapStatus").textContent = "この端末では現在地を取得できません。"; return; }
    $("#mapStatus").textContent = "現在地を取得中…";
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      const radius = parseFloat($("#mapRadius").value) || 0;
      if (MAP_USER) { MAP_USER.forEach((l) => MAP.removeLayer(l)); }
      MAP_USER = [];
      const here = L.circleMarker([lat, lon], {
        radius: 8, color: "#2563eb", fillColor: "#3b82f6", fillOpacity: 0.9,
      }).addTo(MAP).bindPopup("現在地");
      MAP_USER.push(here);
      // 距離計算＆半径フィルタ
      let near = markers.map((m) => ({
        m, km: haversineKm(lat, lon, m._store.lat, m._store.lon),
      })).sort((a, b) => a.km - b.km);
      if (radius > 0) {
        near.forEach(({ m, km }) => {
          if (km <= radius) m.addTo(MAP); else MAP.removeLayer(m);
        });
        const circle = L.circle([lat, lon], {
          radius: radius * 1000, color: "#2563eb", weight: 1, fillOpacity: 0.05,
        }).addTo(MAP);
        MAP_USER.push(circle);
        const inside = near.filter((x) => x.km <= radius);
        if (inside.length) {
          MAP.fitBounds(L.featureGroup(inside.map((x) => x.m).concat([here]))
            .getBounds().pad(0.2));
          $("#mapStatus").textContent =
            `半径${radius}km内に ${inside.length} 店舗（最寄り ${inside[0].km.toFixed(1)}km）`;
        } else {
          MAP.setView([lat, lon], 12);
          $("#mapStatus").textContent =
            `半径${radius}km内に店舗なし。最寄りは ${near[0].km.toFixed(1)}km。`;
        }
      } else {
        markers.forEach((m) => m.addTo(MAP));
        MAP.setView([lat, lon], 12);
        $("#mapStatus").textContent =
          near.length ? `最寄り店舗は ${near[0].km.toFixed(1)}km` : "";
      }
    }, () => {
      $("#mapStatus").textContent = "現在地を取得できませんでした（位置情報の許可をご確認ください）。";
    }, { enableHighAccuracy: true, timeout: 10000 });
  };
  $("#locateBtn").addEventListener("click", locate);
  $("#mapRadius").addEventListener("change", () => {
    if (MAP_USER && MAP_USER.length) locate();
  });
  setTimeout(() => MAP && MAP.invalidateSize(), 100);
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
  const tt = $("#themeToggle");
  if (tt) tt.addEventListener("click", cycleTheme);
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    state.view = t.dataset.view;
    // イントラ検索タブはまず検索リストから(前回の個別表示状態をクリア)。
    if (state.view === "search") state.instructor_id = "";
    setActiveTab(state.view); update();
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
  // ジム/店舗/フリーワードは選択でスコープ(必要な都道府県)が変わるため、
  // update() で対象データをロードしてから描画する(未ロード県の0件表示バグ対策)。
  $("#f-gym").addEventListener("change", (e) => { state.gym = e.target.value; refreshStoreOptions(); refreshInstructorOptions(); update(); });
  $("#f-day").addEventListener("change", (e) => { state.day = e.target.value; saveState(); refreshInstructorOptions(); refreshViewRender(); });
  $("#f-category").addEventListener("change", (e) => { state.category = e.target.value; saveState(); refreshInstructorOptions(); refreshViewRender(); });
  $("#f-store").addEventListener("change", (e) => { state.store_id = e.target.value; refreshInstructorOptions(); update(); });
  $("#f-instructor").addEventListener("change", (e) => { state.instructor = e.target.value; saveState(); refreshViewRender(); });
  $("#f-limit").addEventListener("change", (e) => { state.limit = e.target.value; saveState(); if (lastData && state.view !== "substitution") renderGroups(lastData); });
  let t = null;
  $("#f-q").addEventListener("input", (e) => { state.q = e.target.value.trim(); clearTimeout(t); t = setTimeout(() => { refreshInstructorOptions(); update(); }, 250); });
  $("#resetBtn").addEventListener("click", () => {
    // 地理スコープ(エリア/都道府県)は維持し、副次フィルタのみクリアする。
    Object.assign(state, { gym: "", day: "", category: "", store_id: "", instructor: "", q: "" });
    $("#f-gym").value = ""; $("#f-day").value = ""; $("#f-category").value = "";
    $("#f-store").value = ""; $("#f-q").value = "";
    refreshStoreOptions(); refreshInstructorOptions(); refreshViewRender();
  });
  $("#main").addEventListener("click", (e) => {
    // お気に入り(★)トグル
    const fb = e.target.closest(".favbtn");
    if (fb) {
      e.preventDefault();
      toggleFav(fb.dataset.fk);
      if (state.view === "fav") { renderFavView(); }
      else {
        const on = FAV.has(fb.dataset.fk);
        fb.classList.toggle("on", on);
        fb.textContent = on ? "★" : "☆";
        fb.setAttribute("aria-pressed", String(on));
        fb.title = on ? "お気に入り解除" : "お気に入りに追加";
      }
      return;
    }
    // 先生名リンク → イントラ検索の個別ページへ
    const link = e.target.closest("a.ins-link");
    if (link) {
      e.preventDefault();
      gotoInstructor(link.dataset.iid);
      return;
    }
    const th = e.target.closest("th.sortable");
    if (th && lastData && !["substitution", "fav", "search", "map"].includes(state.view)) {
      const c = th.dataset.col;
      if (sortState.col === c) sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      else { sortState.col = c; sortState.dir = "asc"; }
      renderGroups(lastData);
    }
  });
}

async function main() {
  initTheme();
  loadState();
  readUrlParams();   // URLのディープリンクは保存状態より優先
  // エリアと都道府県は排他(両方指定なら都道府県を優先)。
  if (state.region && state.prefecture) state.region = "";
  try {
    await loadData();
  } catch (e) {
    const msg = escapeHtml(e && e.message ? e.message : String(e));
    $("#main").innerHTML =
      `<div class="empty">データの読み込みに失敗しました（${msg}）。<br>`
      + `Safariで開き直すか、ホーム画面のアイコンを削除して再追加してください。</div>`;
    return;
  }
  // 初回(スコープ未保存)は東京都を既定にして、空表示や全件ロードを避ける。
  if (!state.prefecture && !state.region) {
    state.prefecture = PREF_BY_NAME.has("東京都")
      ? "東京都" : ((PREF_INDEX[0] && PREF_INDEX[0].name) || "");
  }
  try {
    fillControls();
    bind();
    await update();
  } catch (e) {
    const msg = escapeHtml(e && e.message ? e.message : String(e));
    $("#main").innerHTML =
      `<div class="empty">表示中にエラーが発生しました（${msg}）。<br>`
      + `ページを再読み込みしてください。</div>`;
  }
}

window.addEventListener("error", (ev) => {
  const m = $("#main");
  if (m && m.querySelector(".loading")) {
    m.innerHTML = `<div class="empty">問題が発生しました（${escapeHtml(ev.message || "不明")}）。<br>`
      + `Safariで直接開くか、ホーム画面アイコンを削除して再追加してください。</div>`;
  }
});
window.addEventListener("unhandledrejection", (ev) => {
  const m = $("#main");
  if (m && (m.querySelector(".loading") || !META)) {
    const msg = escapeHtml((ev.reason && ev.reason.message) || String(ev.reason || "不明"));
    m.innerHTML = `<div class="empty">読み込みに失敗しました（${msg}）。<br>`
      + `通信環境を確認のうえ、再読み込みしてください。</div>`;
  }
});

main();
