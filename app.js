"use strict";

/* ---------- settings ---------- */
const CLIENT_ID = "889111204943-edo28tmkq0e2224mg86prldvujm907cd.apps.googleusercontent.com";
const APP_ID = "889111204943";            // google cloud project number
const PICKER_API_KEY = "AIzaSyAr6V2F-jV4Fj1sAuJVDYcEZEPGMSFhKUU";                // google cloud > credentials > api key (restricted to the picker api)
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets/";
const FILE_KEY = "ca-finance-file";
const VIEW_KEY = "ca-finance-view";
const SKIP_TABS = ["dashboard"];          // the sheet's own dashboard tab; this app's dashboard replaces it
const HIDE_TABS = ["tasks"];             // loaded for needs attention, not shown as a tab
const FEE_CATS = ["payment fees", "transfer fees", "bank fees"];
const WRONG_ACCOUNT = ["director's loan", "business costs paid personally"];
const SYMBOL = { GBP: "£", EUR: "€", USD: "$" };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TEST = window.__TEST_BOOK__ || null;

const auth = { token: null, expires: 0, client: null };
let book = null;       // { id, title, tabs: [{ name, sheetId, display, raw, fmt }] }
let view = "dashboard";
let data = null;       // parsed model used by the dashboard
const dash = { scope: null, cur: "USD", fy: null, q: 0, month: null, stream: null, cat: null, acct: null, allTasks: false };
const SCOPES = [["all", "everything"], ["companies", "both companies"], ["ie ltd", "irish company"], ["uk ltd", "uk company"], ["personal", "personal"]];
const FX_FALLBACK = { GBPEUR: 1.17, USDEUR: 0.92, EURGBP: 0.855, USDGBP: 0.78 };
const TX_CLEAR = { text: "", entity: "", entities: null, category: "", account: "", group: "", only: null, from: "", to: "" };
const txFilter = Object.assign({}, TX_CLEAR);

/* ---------- google sign-in ---------- */
function loadScript(src) {
  return new Promise((ok, fail) => {
    if (document.querySelector('script[src="' + src + '"]')) return ok();
    const s = document.createElement("script");
    s.src = src; s.async = true; s.onload = ok; s.onerror = () => fail(new Error("couldn't load google"));
    document.head.append(s);
  });
}
function signedIn() { return !!auth.token && Date.now() < auth.expires; }
function gateError(msg) { const g = $("#gateError"); g.hidden = !msg; g.textContent = msg || ""; }

function requestToken(then) {
  if (!(window.google && google.accounts && google.accounts.oauth2)) return gateError("google is still loading. try again in a second.");
  if (!auth.client) auth.client = google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPE, callback: () => {} });
  auth.client.callback = r => {
    if (r.error) return gateError("sign-in didn't finish. try again.");
    auth.token = r.access_token;
    auth.expires = Date.now() + (Number(r.expires_in) - 60) * 1000;
    then();
  };
  auth.client.error_callback = () => gateError("the sign-in window closed before it finished.");
  auth.client.requestAccessToken({ prompt: lastFile() ? "" : "consent" });
}
function lastFile() { try { return JSON.parse(localStorage.getItem(FILE_KEY)); } catch { return null; } }
function setLastFile(f) { try { f ? localStorage.setItem(FILE_KEY, JSON.stringify(f)) : localStorage.removeItem(FILE_KEY); } catch {} }

async function openPicker() {
  try {
    await loadScript("https://apis.google.com/js/api.js");
    await new Promise(ok => gapi.load("picker", ok));
  } catch { return gateError("the google file picker couldn't load."); }
  const docs = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS).setMode(google.picker.DocsViewMode.LIST);
  new google.picker.PickerBuilder()
    .addView(docs)
    .setOAuthToken(auth.token)
    .setDeveloperKey(PICKER_API_KEY)
    .setAppId(APP_ID)
    .setCallback(d => {
      if (d.action !== google.picker.Action.PICKED) return;
      const f = d.docs[0];
      setLastFile({ id: f.id, name: f.name });
      loadBook(f.id);
    })
    .build().setVisible(true);
}

async function api(url, opts = {}) {
  if (!signedIn()) throw Object.assign(new Error("signed out"), { expired: true });
  const res = await fetch(url, Object.assign({}, opts, {
    headers: Object.assign({ Authorization: "Bearer " + auth.token, "Content-Type": "application/json" }, opts.headers || {})
  }));
  if (res.status === 401) { auth.token = null; throw Object.assign(new Error("signed out"), { expired: true }); }
  if (res.status === 403 || res.status === 404) throw new Error("this file isn't available. open it again with open file.");
  if (!res.ok) throw new Error("google sheets didn't respond (" + res.status + "). try again.");
  return res.json();
}
const quote = name => "'" + String(name).replace(/'/g, "''") + "'";
function colLetter(i) { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

/* ---------- load the sheet ---------- */
async function loadBook(id) {
  status("loading");
  try {
    const meta = await api(SHEETS + id + "?fields=properties.title,sheets.properties(sheetId,title,index,gridProperties)");
    const tabs = meta.sheets.map(s => s.properties).filter(p => !SKIP_TABS.includes(p.title.toLowerCase()));
    const ranges = tabs.map(t => "ranges=" + encodeURIComponent(quote(t.title))).join("&");
    const [disp, raw] = await Promise.all([
      api(SHEETS + id + "/values:batchGet?" + ranges + "&valueRenderOption=FORMATTED_VALUE"),
      api(SHEETS + id + "/values:batchGet?" + ranges + "&valueRenderOption=FORMULA")
    ]);
    const small = tabs.filter(t => t.gridProperties.rowCount <= 1500);
    const fmtRes = small.length ? await api(SHEETS + id + "?" + small.map(t => "ranges=" + encodeURIComponent(quote(t.title))).join("&")
      + "&fields=" + encodeURIComponent("sheets(properties.title,data.rowData.values(effectiveFormat(textFormat(bold,italic,strikethrough),backgroundColor,borders.bottom.style)))")) : { sheets: [] };
    const fmtByTitle = {};
    (fmtRes.sheets || []).forEach(s => { fmtByTitle[s.properties.title] = readFormats(s); });
    book = {
      id, title: meta.properties.title,
      tabs: tabs.map((t, i) => ({ name: t.title, sheetId: t.sheetId, display: disp.valueRanges[i].values || [], raw: raw.valueRanges[i].values || [], fmt: fmtByTitle[t.title] || [] }))
    };
    setLastFile({ id, name: book.title });
    start();
    status("");
  } catch (e) {
    if (e.expired) return showGate();
    status(""); showGate(); gateError(e.message);
  }
}
function readFormats(sheet) {
  const rows = (sheet.data && sheet.data[0] && sheet.data[0].rowData) || [];
  return rows.map(r => (r.values || []).map(v => {
    const f = v.effectiveFormat || {}; const t = f.textFormat || {}; const bg = f.backgroundColor || {};
    const yellow = bg.red > 0.9 && bg.green > 0.9 && (bg.blue || 0) < 0.3;
    return { b: !!t.bold, i: !!t.italic, s: !!t.strikethrough, y: yellow, line: !!(f.borders && f.borders.bottom && f.borders.bottom.style) };
  }));
}
async function refreshTab(tab, rowFrom, rowTo) {
  if (TEST) return;
  const range = quote(tab.name) + (rowFrom != null ? "!" + (rowFrom + 1) + ":" + (rowTo + 1) : "");
  const [d, r] = await Promise.all([
    api(SHEETS + book.id + "/values/" + encodeURIComponent(range) + "?valueRenderOption=FORMATTED_VALUE"),
    api(SHEETS + book.id + "/values/" + encodeURIComponent(range) + "?valueRenderOption=FORMULA")
  ]);
  if (rowFrom == null) { tab.display = d.values || []; tab.raw = r.values || []; return; }
  for (let k = 0; k <= rowTo - rowFrom; k++) {
    tab.display[rowFrom + k] = (d.values || [])[k] || [];
    tab.raw[rowFrom + k] = (r.values || [])[k] || [];
  }
}
async function writeCell(tab, row, col, value) {
  setCell(tab, row, col, value);
  if (TEST) { setCell(tab, row, col, value, true); return; }
  status("saving");
  try {
    const range = quote(tab.name) + "!" + colLetter(col) + (row + 1);
    await api(SHEETS + book.id + "/values/" + encodeURIComponent(range) + "?valueInputOption=USER_ENTERED", {
      method: "PUT", body: JSON.stringify({ range, majorDimension: "ROWS", values: [[value]] })
    });
    if (tab.name.toLowerCase() === "transactions") await refreshTab(tab, row, row); else await refreshTab(tab);
    status("saved");
  } catch (e) { status(e.expired ? "signed out. sign in again to save." : e.message); }
}
async function setStrike(tab, row, col, on) {
  ((tab.fmt[row] = tab.fmt[row] || [])[col] = Object.assign({}, (tab.fmt[row] || [])[col] || {}, { s: on }));
  if (TEST) return;
  status("saving");
  try {
    await api(SHEETS + book.id + ":batchUpdate", { method: "POST", body: JSON.stringify({ requests: [{ repeatCell: {
      range: { sheetId: tab.sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: col, endColumnIndex: col + 1 },
      cell: { userEnteredFormat: { textFormat: { strikethrough: on } } }, fields: "userEnteredFormat.textFormat.strikethrough" } }] }) });
    status("saved");
  } catch (e) { status(e.expired ? "signed out. sign in again to save." : e.message); }
}
function setCell(tab, row, col, value, asDisplay) {
  for (const key of asDisplay ? ["display", "raw"] : ["raw"]) {
    const g = tab[key]; while (g.length <= row) g.push([]);
    const r = g[row]; while (r.length <= col) r.push("");
    r[col] = value;
  }
}
let statusTimer = null;
function status(t) {
  const s = $("#status"); s.textContent = t || "";
  clearTimeout(statusTimer);
  if (t === "saved") statusTimer = setTimeout(() => (s.textContent = ""), 2000);
}

/* ---------- model ---------- */
const num = v => typeof v === "number" ? v : (parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, "")) || 0);
const lc = v => String(v == null ? "" : v).trim().toLowerCase();
function tabByName(n) { return book.tabs.find(t => t.name.toLowerCase() === n); }
function findRow(rows, words, from = 0) {
  for (let i = from; i < rows.length; i++) { const r = (rows[i] || []).map(lc); if (words.every(w => r.includes(w))) return i; }
  return -1;
}
function block(rows, words) {
  const h = findRow(rows, words); if (h < 0) return [];
  const idx = words.map(w => rows[h].map(lc).indexOf(w));
  const out = [];
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i] || []; if (!lc(r[idx[0]])) break;
    out.push(idx.map(j => r[j]));
  }
  return out;
}
function buildModel() {
  const tx = tabByName("transactions"); const fc = tabByName("forecast");
  const fcRows = fc ? fc.display : [];
  const catGroup = {};
  block(fcRows, ["category", "group"]).forEach(([c, g]) => (catGroup[lc(c)] = lc(g)));
  const ent = {
    "ie ltd": { ye: 12, sym: "€", vat: "", rate: 0.125 },
    "uk ltd": { ye: 7, sym: "£", vat: "", rate: null },
    "personal": { ye: 12, sym: "€", vat: "", rate: 0 }
  };
  block(fcRows, ["entity", "currency", "corporation tax", "vat", "year end"]).forEach(([e, cur, rate, vat, ye]) => {
    const k = lc(e); ent[k] = ent[k] || { ye: 12, sym: "", rate: 0 };
    ent[k].sym = SYMBOL[String(cur).toUpperCase()] || ent[k].sym;
    const m = MONTHS.indexOf(lc(ye).split(" ").pop()); if (m >= 0) ent[k].ye = m + 1;
    ent[k].vat = lc(vat);
    if (/^[\d.]+%$/.test(String(rate).trim())) ent[k].rate = parseFloat(rate) / 100;
  });
  const rows = [];
  let cols = null, head = -1;
  if (tx) {
    head = findRow(tx.display, ["date", "account", "category"]);
    if (head >= 0) {
      const h = tx.display[head].map(lc);
      cols = {}; ["date", "account", "entity", "merchant", "reference", "amount", "currency", "reporting amount", "category", "group", "stream", "receipt"].forEach(k => (cols[k] = h.indexOf(k)));
      for (let i = head + 1; i < tx.display.length; i++) {
        const r = tx.display[i] || []; const date = String(r[cols.date] || "");
        if (!/^\d{4}-\d{2}-\d{2}/.test(date)) continue;
        const category = lc(r[cols.category]);
        rows.push({
          i, date: date.slice(0, 10), account: lc(r[cols.account]), entity: lc(r[cols.entity]), merchant: lc(r[cols.merchant]),
          amount: num(r[cols.amount]), cur: String(r[cols.currency] || "").toUpperCase(), rep: num(r[cols["reporting amount"]]),
          category, group: lc(r[cols.group]) || catGroup[category] || "", stream: lc(r[cols.stream]), receipt: lc(r[cols.receipt])
        });
      }
    }
  }
  const fx = {};
  block(fcRows, ["month", "rate"]).forEach(([k, v]) => { const n = num(v); if (n) fx[String(k).trim()] = n; });
  rows.forEach(r => (r.repCur = r.entity === "uk ltd" ? "GBP" : "EUR"));
  const tasks = tabByName("tasks"); const filings = tabByName("filings");
  data = { rows, cols, head, catGroup, cats: Object.keys(catGroup), ent, tasks, filings, fx, fxCache: {} };
  applyCurrency();
}

/* ---------- currency ----------
   income and costs use the rate for the month they happened in.
   balances (cash, loans) use the rate at the date they're shown for. */
function rate(month, from, to) {
  if (from === to) return 1;
  const key = month + from + to; if (data.fxCache[key]) return data.fxCache[key];
  let r = null, m = new Date(month + "-01T00:00:00");
  for (let k = 0; k < 36 && r == null; k++, m = addMonths(m, -1)) {
    const mm = iso(m).slice(0, 7);
    if (data.fx[mm + from + to]) r = data.fx[mm + from + to];
    else if (data.fx[mm + to + from]) r = 1 / data.fx[mm + to + from];
    else if (from !== "EUR" && to !== "EUR" && (data.fx[mm + from + "EUR"] || data.fx[mm + "EUR" + from]) && (data.fx[mm + "EUR" + to] || data.fx[mm + to + "EUR"])) r = rate(mm, from, "EUR") * rate(mm, "EUR", to);
  }
  if (r == null) r = FX_FALLBACK[from + to] || (FX_FALLBACK[to + from] ? 1 / FX_FALLBACK[to + from] : (FX_FALLBACK[from + "EUR"] || 1) / (FX_FALLBACK[to + "EUR"] || 1));
  return (data.fxCache[key] = r);
}
function applyCurrency() { data.rows.forEach(r => (r.v = r.rep * rate(r.date.slice(0, 7), r.repCur, dash.cur))); }
// a balance on a date, from each row's own currency, at that date's rate
function balance(to, fn, ents = scopeEntities()) {
  const byCur = {};
  data.rows.forEach(r => { if (ents.includes(r.entity) && r.date <= to && (!fn || fn(r))) byCur[r.cur] = (byCur[r.cur] || 0) + r.amount; });
  const now = iso(new Date()); const m = (to > now ? now : to).slice(0, 7);
  return Object.entries(byCur).reduce((a, [c, v]) => a + v * rate(m, c || "EUR", dash.cur), 0);
}
function scopeEntities(sc = dash.scope) {
  if (sc === "all") return ["ie ltd", "uk ltd", "personal"];
  if (sc === "companies") return ["ie ltd", "uk ltd"];
  return [sc];
}
// in a combined view, pay from your own company into your personal account is internal, so it isn't counted twice
function internal(r) { return dash.scope === "all" && r.entity === "personal" && r.category === "income" && r.merchant.includes("conversion alchemy"); }

/* ---------- periods ---------- */
const iso = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const monthEnd = d => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const longDate = s => { const d = new Date(s + "T00:00:00"); return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear(); };
function fyStartFor(dateStr, ye) {
  const d = new Date(dateStr + "T00:00:00"); const startMonth = ye % 12;
  let y = d.getFullYear(); if (d.getMonth() < startMonth) y--;
  return new Date(y, startMonth, 1);
}
function fyLabel(start, ye) { return ye === 12 ? "fy " + start.getFullYear() : "fy " + start.getFullYear() + "–" + String(start.getFullYear() + 1).slice(2); }
function scopeYe() { return dash.scope === "uk ltd" ? data.ent["uk ltd"].ye : 12; }
function fyList() {
  const ye = scopeYe(); const ents = scopeEntities(); const rs = data.rows.filter(r => ents.includes(r.entity));
  if (!rs.length) return [];
  const lastDate = rs[rs.length - 1].date, today = iso(new Date());
  const first = fyStartFor(rs[0].date, ye), last = fyStartFor(today > lastDate ? today : lastDate, ye);
  const out = []; for (let d = first; d <= last; d = addMonths(d, 12)) out.push({ start: iso(d), label: fyLabel(d, ye) });
  return out.reverse();
}
function range() {
  const s = new Date(dash.fy + "T00:00:00");
  if (dash.month) { const m = new Date(dash.month + "-01T00:00:00"); return { from: iso(m), to: iso(monthEnd(m)), months: 1, kind: "month" }; }
  if (dash.q) { const a = addMonths(s, (dash.q - 1) * 3); return { from: iso(a), to: iso(monthEnd(addMonths(a, 2))), months: 3, kind: "quarter" }; }
  return { from: iso(s), to: iso(monthEnd(addMonths(s, 11))), months: 12, kind: "year" };
}
function prevRange(r) {
  const a = addMonths(new Date(r.from + "T00:00:00"), -r.months);
  return { from: iso(a), to: iso(monthEnd(addMonths(a, r.months - 1))), months: r.months, kind: r.kind };
}
// months of the range that have started, for per-month averages
function monthsElapsed(rg) {
  const today = iso(new Date()); if (today >= rg.to) return rg.months; if (today < rg.from) return 1;
  const a = new Date(rg.from + "T00:00:00"), b = new Date(today + "T00:00:00");
  return Math.max(1, (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth() + 1);
}

/* ---------- maths ---------- */
const inRange = (r, rg) => r.date >= rg.from && r.date <= rg.to;
const sel = (rg, fn, ents = scopeEntities()) => data.rows.filter(r => ents.includes(r.entity) && inRange(r, rg) && !internal(r) && (!fn || fn(r)));
const total = (rows, f = "v") => rows.reduce((a, r) => a + r[f], 0);
const isIncome = r => r.group === "income";
const isCost = r => r.group === "cost";
function ukTax(p) { if (p <= 0) return 0; if (p <= 50000) return p * 0.19; if (p >= 250000) return p * 0.25; return p * 0.25 - 0.015 * (250000 - p); }
function taxFor(e, rg) {
  const rs = sel(rg, null, [e]); const ent = data.ent[e] || {};
  const p = total(rs.filter(r => isIncome(r) || isCost(r) || r.category === "director pay"), "rep");
  const t = ent.rate == null ? ukTax(p) : Math.max(0, p) * (ent.rate || 0);
  return t * rate(rg.to.slice(0, 7), e === "uk ltd" ? "GBP" : "EUR", dash.cur);
}
function figures(rg) {
  const rows = sel(rg);
  const income = total(rows.filter(isIncome));
  const costs = total(rows.filter(isCost));
  const pay = dash.scope === "all" ? 0 : total(rows.filter(r => r.category === "director pay"));
  const profit = income + costs + pay;
  let tax = 0; scopeEntities().filter(e => e !== "personal").forEach(e => (tax += taxFor(e, rg)));
  return { income, costs, pay, profit, tax, cash: balance(rg.to), taxPaid: -total(rows.filter(r => r.group === "tax")) };
}
function money(v, sym) {
  const s = sym == null ? SYMBOL[dash.cur] : sym;
  return (v < -0.5 ? "−" : "") + s + Math.round(Math.abs(v)).toLocaleString("en-GB");
}
const pct = v => { if (!isFinite(v)) return "0%"; const p = v * 100; return (Math.abs(p) < 10 && Math.abs(p - Math.round(p)) > 0.05 ? p.toFixed(1) : Math.round(p)) + "%"; };
function short(v) { const a = Math.abs(v); return (v < 0 ? "−" : "") + (a >= 1e6 ? (a / 1e6).toFixed(1) + "m" : a >= 1e3 ? (a / 1e3 >= 100 ? Math.round(a / 1e3) : (a / 1e3).toFixed(a / 1e3 >= 10 ? 0 : 1)) + "k" : String(Math.round(a))); }
function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
function supplier(m) { return m.replace(/[^a-z0-9 &.]/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 2).join(" ") || m || "unknown"; }
function groupBy(rows, key) {
  const m = new Map(); rows.forEach(r => { const k = typeof key === "function" ? key(r) : r[key]; m.set(k, (m.get(k) || 0) + r.v); });
  return [...m.entries()].map(([label, v]) => ({ label, v })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
}
const streamOf = r => r.stream || (dash.scope === "personal" ? r.category : "other");

/* ---------- svg ---------- */
const F = 'font-size="14" font-family="PT Sans, Arial, sans-serif" fill="#26241f"';
const GREEN = "#00C601", RED = "#FF5429", GTEXT = "#079a10", RTEXT = "#e0431c";
const PASTEL = ["#f6c9b5", "#f2bcd5", "#bccbec", "#cfe3d4", "#e4d4f2", "#f3e3a6", "#e6e1d6"];
function svgBox(host, H, inner) {
  const W = Math.max(280, host.clientWidth || 600);
  host.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '">' + inner(W) + "</svg>";
}

/* ---------- small builders ---------- */
function lead(label, value, o = {}) {
  const d = el("div", "lead" + (o.sel ? " sel" : "") + (o.onclick ? " link" : "") + (o.cls ? " " + o.cls : ""));
  const l = el("span"); if (o.swatch) { const s = el("span", "sw"); s.style.background = o.swatch; l.append(s); }
  if (o.italic) l.append(el("i", null, label)); else l.append(document.createTextNode(label));
  const v = el("span"); if (typeof value === "string") v.textContent = value; else v.append(...value);
  d.append(l, el("span", "dots"), v);
  if (o.onclick) { d.onclick = o.onclick; d.tabIndex = 0; d.onkeydown = e => { if (e.key === "Enter") o.onclick(); }; }
  return d;
}

/* ---------- dashboard ---------- */
function renderDashboard() {
  if (!SCOPES.some(([k]) => k === dash.scope)) dash.scope = "all";
  if (!SYMBOL[dash.cur]) dash.cur = "USD";
  const fys = fyList();
  if (!fys.find(f => f.start === dash.fy)) { const cur = fyStartFor(iso(new Date()), scopeYe()); dash.fy = (fys.find(f => f.start === iso(cur)) || fys[0] || {}).start; dash.q = 0; dash.month = null; }
  try { localStorage.setItem(VIEW_KEY, JSON.stringify({ scope: dash.scope, cur: dash.cur })); } catch {}
  if (!dash.fy) return;

  const sp = $("#scopePick"); sp.innerHTML = "";
  SCOPES.forEach(([k, label]) => { const o = el("option", null, label); o.value = k; o.selected = k === dash.scope; sp.append(o); });
  sp.onchange = () => { dash.scope = sp.value; dash.fy = null; dash.stream = dash.cat = dash.acct = null; renderDashboard(); };
  const cp = $("#currencyPick"); cp.innerHTML = "";
  ["USD", "EUR", "GBP"].forEach(c => { const b = el("button", null, SYMBOL[c]); b.type = "button"; b.setAttribute("aria-pressed", c === dash.cur); b.setAttribute("aria-label", c.toLowerCase()); b.onclick = () => { dash.cur = c; data.fxCache = {}; applyCurrency(); renderDashboard(); }; cp.append(b); });
  const yp = $("#yearPick"); yp.innerHTML = "";
  fys.forEach(f => { const o = el("option", null, f.label); o.value = f.start; o.selected = f.start === dash.fy; yp.append(o); });
  yp.onchange = () => { dash.fy = yp.value; dash.q = 0; dash.month = null; renderDashboard(); };
  const qp = $("#quarterPick"); qp.innerHTML = "";
  ["full year", "q1", "q2", "q3", "q4"].forEach((t, k) => { const b = el("button", null, t); b.type = "button"; b.setAttribute("aria-pressed", dash.q === k && !dash.month); b.onclick = () => { dash.q = k; dash.month = null; renderDashboard(); }; qp.append(b); });
  const chip = $("#monthChip");
  chip.hidden = !dash.month; if (dash.month) { const m = new Date(dash.month + "-01T00:00:00"); chip.textContent = MONTHS[m.getMonth()] + " " + m.getFullYear(); chip.onclick = () => { dash.month = null; renderDashboard(); }; }
  const personal = dash.scope === "personal";
  $("#pdfButton").hidden = personal;

  const rg = range();
  $("#rangeLabel").textContent = longDate(rg.from) + " – " + longDate(rg.to);
  renderSummary(rg);
  renderMonthChart(rg);
  renderStreams(rg);
  renderCosts(rg);
  renderCash(rg);
  renderAttention();
}

function renderSummary(rg) {
  const f = figures(rg), p = figures(prevRange(rg)), personal = dash.scope === "personal";
  const than = { year: "last year", quarter: "the previous quarter", month: "the previous month" }[rg.kind];
  const change = (a, b) => { if (!b) return "nothing to compare"; const c = (Math.abs(a) - Math.abs(b)) / Math.abs(b); return pct(Math.abs(c)) + (c >= 0 ? " higher than " : " lower than ") + than; };
  const cols = [
    ["income", f.income, "g", change(f.income, p.income)],
    ["costs", -f.costs, "r", change(f.costs, p.costs)],
    [personal ? "left over" : "profit before tax", f.profit, f.profit < 0 ? "r" : "g", f.income ? pct(f.profit / f.income) + " of income" : ""]
  ];
  if (!personal) cols.push(["tax due (estimate)", f.tax, "r", f.taxPaid > 0.5 ? money(f.taxPaid) + " paid" : "nothing paid yet"]);
  cols.push(["cash", f.cash, f.cash < 0 ? "r" : "g", change(f.cash, p.cash)]);
  const t = el("table", "sum"), a = el("tr"), b = el("tr"), c = el("tr");
  cols.forEach(([label, v, cls, note]) => { const x = el("td"); x.append(el("i", null, label)); a.append(x); b.append(el("td", cls, money(v))); c.append(el("td", null, note)); });
  t.append(a, b, c); $("#summary").replaceChildren(t);
}

function renderMonthChart(rg) {
  const host = $("#monthChart"); host.className = "chart";
  const start = new Date(dash.fy + "T00:00:00"), today = iso(new Date());
  const series = [];
  for (let k = 0; k < 12; k++) {
    const m = addMonths(start, k), x = { from: iso(m), to: iso(monthEnd(m)) }, rows = sel(x);
    series.push({ m: iso(m).slice(0, 7), label: MONTHS[m.getMonth()], started: x.from <= today, inc: total(rows.filter(isIncome)), cost: -total(rows.filter(isCost)) });
  }
  const max = niceMax(Math.max(1, ...series.map(s => Math.max(s.inc, s.cost))));
  const chart = el("div");
  host.replaceChildren(chart);
  svgBox(chart, 250, W => {
    const L = 40, base = 190, y = v => base - v / max * 180, slot = (W - L) / 12; let s = "";
    [0, 0.25, 0.5, 0.75, 1].forEach(t => { const v = max * t; s += '<line x1="' + L + '" x2="' + W + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="' + (t ? "#ecebe7" : "#26241f") + '"/><text x="0" y="' + (y(v) + 5) + '" ' + F + ">" + (t ? short(v) : "0") + "</text>"; });
    series.forEach((d, k) => {
      const x = L + k * slot + slot * 0.14, bw = slot * 0.34, on = d.m >= rg.from.slice(0, 7) && d.m <= rg.to.slice(0, 7);
      s += '<g opacity="' + (on ? 1 : 0.3) + '"><rect x="' + x + '" y="' + y(d.inc) + '" width="' + bw + '" height="' + (base - y(d.inc)) + '" fill="' + GREEN + '"/>'
        + '<rect x="' + (x + bw + 2) + '" y="' + y(d.cost) + '" width="' + bw + '" height="' + (base - y(d.cost)) + '" fill="' + RED + '"/></g>'
        + '<text x="' + x + '" y="' + (base + 20) + '" ' + F + ">" + d.label + "</text>";
      if (d.started && (d.inc || d.cost)) { const n = d.inc - d.cost; s += '<text x="' + x + '" y="' + (base + 40) + '" font-size="14" font-family="PT Sans, Arial, sans-serif" fill="' + (n < 0 ? RTEXT : GTEXT) + '">' + (n < 0 ? "" : "+") + short(n) + "</text>"; }
      s += '<rect class="hit" x="' + (L + k * slot) + '" y="0" width="' + slot + '" height="250" fill="transparent" data-month="' + d.m + '" data-tip="' + esc(d.label + " " + d.m.slice(0, 4) + "|income " + money(d.inc) + "|costs " + money(d.cost) + "|" + (d.inc - d.cost < 0 ? "loss " : "profit ") + money(Math.abs(d.inc - d.cost))) + '"/>';
    });
    return s;
  });
  const lg = el("div", "legend"); lg.innerHTML = '<span><span class="sw" style="background:' + GREEN + '"></span>income</span><span><span class="sw" style="background:' + RED + '"></span>costs</span>';
  host.append(lg);
  host.querySelectorAll(".hit").forEach(b => b.addEventListener("click", () => { dash.month = dash.month === b.dataset.month ? null : b.dataset.month; renderDashboard(); }));
}

// income by stream, with each stream's margin after the costs tagged to it and its share of payment fees
function streamMargins(rg) {
  const inc = groupBy(sel(rg, isIncome), streamOf).filter(i => Math.abs(i.v) > 0.5);
  const allInc = inc.reduce((a, i) => a + i.v, 0);
  const fees = total(sel(rg, r => isCost(r) && !r.stream && r.category === "payment fees"));
  return inc.map(i => {
    const tagged = sel(rg, r => isCost(r) && r.stream && r.stream === i.label);
    const steps = groupBy(tagged, "category").map(c => ({ label: c.label, v: c.v }));
    const share = allInc > 0 ? fees * i.v / allInc : 0;
    if (Math.abs(share) > 0.5) steps.push({ label: "payment fees", v: share });
    steps.sort((a, b) => a.v - b.v);
    const top = steps.slice(0, 4), rest = steps.slice(4).reduce((a, s) => a + s.v, 0);
    if (Math.abs(rest) > 0.5) top.push({ label: "other costs", v: rest });
    const margin = i.v + steps.reduce((a, s) => a + s.v, 0);
    return { label: i.label, v: i.v, steps: top, margin };
  });
}
function renderStreams(rg) {
  const list = $("#streamList"), detail = $("#streamDetail"), streams = streamMargins(rg);
  list.replaceChildren(el("i", "mt", dash.scope === "personal" ? "by source" : "by stream"));
  if (!streams.length) { list.append(el("p", "empty", "no income in this period")); detail.replaceChildren(); return; }
  if (!streams.find(s => s.label === dash.stream)) dash.stream = streams[0].label;
  streams.forEach(s => {
    const v = [el("span", null, money(s.v))]; if (s.v > 0) { v.push(document.createTextNode("  ")); v.push(el("i", null, pct(s.margin / s.v) + (s === streams[0] ? " margin" : ""))); }
    list.append(lead(s.label, v, { sel: s.label === dash.stream, onclick: () => { dash.stream = s.label; renderStreams(rg); } }));
  });
  list.append(lead("all revenue", money(streams.reduce((a, s) => a + s.v, 0)), { italic: true, cls: "total" }));

  const s = streams.find(x => x.label === dash.stream);
  const box = el("div", "chart"), key = el("div");
  detail.replaceChildren(el("i", "mt", s.label + ", where the revenue goes"), box, key);
  const SHADES = [RED, "#ff8566", "#ffad99", "#ffd0c4", "#ffe6df"];
  const parts = [{ label: "margin", v: Math.max(0, s.margin), c: GREEN }].concat(s.steps.map((st, k) => ({ label: st.label, v: -st.v, c: SHADES[k] || SHADES[4] })));
  const whole = parts.reduce((a, p) => a + Math.max(0, p.v), 0) || 1;
  svgBox(box, 40, W => {
    let x = 0, out = "";
    parts.forEach(p => {
      const w = Math.max(0, p.v) / whole * W; if (w <= 0) return;
      out += '<rect x="' + x + '" y="0" width="' + w + '" height="32" fill="' + p.c + '" stroke="#fff" stroke-width="1" data-tip="' + esc(p.label + "|" + money(p.v) + "|" + pct(p.v / whole)) + '"/>';
      if (w > 44) out += '<text x="' + (x + 8) + '" y="21" ' + F + ">" + pct(p.v / whole) + "</text>";
      x += w;
    });
    return out;
  });
  key.append(lead("revenue", money(s.v)));
  parts.forEach(p => {
    const v = [el("span", p.label === "margin" ? (s.margin < 0 ? "r" : "g") : "r", money(p.label === "margin" ? s.margin : -p.v))];
    if (s.v > 0) { v.push(document.createTextNode("  ")); v.push(el("i", null, pct((p.label === "margin" ? s.margin : p.v) / s.v))); }
    key.append(lead(p.label, v, { swatch: p.c }));
  });
}

function renderCosts(rg) {
  const list = $("#costList"), detail = $("#costDetail");
  const rows = sel(rg, isCost), cats = groupBy(rows, "category").filter(c => Math.abs(c.v) > 0.5);
  list.replaceChildren(el("i", "mt", "by category"));
  if (!cats.length) { list.append(el("p", "empty", "no costs in this period")); detail.replaceChildren(); return; }
  if (dash.cat && !cats.find(c => c.label === dash.cat)) dash.cat = null;
  list.append(lead("all costs", money(-total(rows)), { sel: !dash.cat, onclick: () => { dash.cat = null; renderCosts(rg); } }));
  const top = cats.slice(0, 7), rest = cats.slice(7);
  top.forEach(c => list.append(lead(c.label, money(-c.v), { sel: c.label === dash.cat, onclick: () => { dash.cat = c.label; renderCosts(rg); } })));
  if (rest.length) list.append(lead("everything else", money(-rest.reduce((a, c) => a + c.v, 0)), { onclick: () => goTransactions({ group: "cost" }) }));

  const pick = dash.cat ? rows.filter(r => r.category === dash.cat) : rows;
  let parts = dash.cat ? groupBy(pick, r => supplier(r.merchant)) : cats.slice();
  parts = parts.filter(p => p.v < -0.5);
  const shown = parts.slice(0, 6), others = parts.slice(6);
  if (others.length) shown.push({ label: others.length + " others", v: others.reduce((a, p) => a + p.v, 0), others: true });
  const sum = -shown.reduce((a, p) => a + p.v, 0);
  const pie = el("div", "pie"), key = el("div");
  detail.replaceChildren(el("i", "mt", dash.cat ? dash.cat + ", by supplier" : "all costs, by category"), pie);
  let a0 = -Math.PI / 2, p = "";
  shown.forEach((it, k) => {
    const v = -it.v, frac = sum ? v / sum : 0, a1 = a0 + frac * 2 * Math.PI, R = 96, r = 56, lg = a1 - a0 > Math.PI ? 1 : 0;
    const pt = (rr, a) => (100 + rr * Math.cos(a)).toFixed(2) + "," + (100 + rr * Math.sin(a)).toFixed(2);
    p += frac > 0.9999 ? '<circle cx="100" cy="100" r="76" fill="none" stroke="' + PASTEL[k] + '" stroke-width="40"/>'
      : '<path d="M' + pt(R, a0) + " A" + R + "," + R + " 0 " + lg + " 1 " + pt(R, a1) + " L" + pt(r, a1) + " A" + r + "," + r + " 0 " + lg + " 0 " + pt(r, a0) + ' Z" fill="' + PASTEL[k] + '" stroke="#fff" stroke-width="2"/>';
    const am = (a0 + a1) / 2; if (frac >= 0.06) p += '<text x="' + (100 + 76 * Math.cos(am)).toFixed(1) + '" y="' + (100 + 76 * Math.sin(am) + 5).toFixed(1) + '" font-size="13" text-anchor="middle" font-family="PT Sans, Arial, sans-serif" fill="#26241f">' + Math.round(frac * 100) + "%</text>";
    const go = it.others ? null : dash.cat ? () => goTransactions({ category: dash.cat, text: it.label }) : () => { dash.cat = it.label; renderCosts(rg); };
    key.append(lead(it.label, money(v), { swatch: PASTEL[k], onclick: go }));
    a0 = a1;
  });
  const when = { year: "this year", quarter: "this quarter", month: "this month" }[rg.kind];
  p += '<text x="100" y="98" ' + F + ' text-anchor="middle">' + esc(money(sum)) + '</text><text x="100" y="117" font-size="14" font-style="italic" text-anchor="middle" font-family="PT Sans, Arial, sans-serif" fill="#26241f">' + when + "</text>";
  const svg = '<svg viewBox="0 0 200 200" width="190" height="190">' + p + "</svg>";
  pie.innerHTML = svg; pie.append(key);
  if (rg.months > 1) key.append(lead("per month", money(sum / monthsElapsed(rg)), { italic: true, cls: "total" }));
}

function renderCash(rg) {
  const list = $("#cashList"), detail = $("#cashDetail"), to = rg.to;
  const accounts = [...new Set(data.rows.filter(r => scopeEntities().includes(r.entity)).map(r => r.account))];
  const items = accounts.map(a => ({ label: a, v: balance(to, r => r.account === a) })).filter(i => Math.abs(i.v) >= 0.5).sort((a, b) => b.v - a.v);
  if (dash.acct && !items.find(i => i.label === dash.acct)) dash.acct = null;
  list.replaceChildren(el("i", "mt", "by account, at " + longDate(to > iso(new Date()) ? iso(new Date()) : to)));
  list.append(lead("all accounts", money(balance(to)), { sel: !dash.acct, onclick: () => { dash.acct = null; renderCash(rg); } }));
  items.forEach(i => list.append(lead(i.label, money(i.v), { sel: i.label === dash.acct, onclick: () => { dash.acct = i.label; renderCash(rg); } })));

  const start = new Date(dash.fy + "T00:00:00"), today = iso(new Date()), pts = [];
  for (let k = 0; k < 12; k++) { const m = monthEnd(addMonths(start, k)), d = iso(m); pts.push({ label: MONTHS[m.getMonth()], v: d.slice(0, 7) <= today.slice(0, 7) ? balance(d < today ? d : today, dash.acct ? r => r.account === dash.acct : null) : null }); }
  const box = el("div", "chart");
  detail.replaceChildren(el("i", "mt", (dash.acct || "all accounts") + ", balance by month"), box);
  const known = pts.filter(p => p.v != null).map(p => p.v);
  const hi = niceMax(Math.max(1, ...known)), lo = Math.min(0, ...known) < 0 ? -niceMax(-Math.min(0, ...known)) : 0;
  svgBox(box, 200, W => {
    const L = 44, T = 10, B = 170, y = v => B - (v - lo) / (hi - lo) * (B - T), slot = (W - L - 20) / 11; let s = "";
    const ticks = lo < 0 ? [lo, 0, hi] : [0, hi * 0.25, hi * 0.5, hi * 0.75, hi];
    ticks.forEach(v => { s += '<line x1="' + L + '" x2="' + W + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="' + (v === 0 ? "#26241f" : "#ecebe7") + '"/><text x="0" y="' + (y(v) + 5) + '" ' + F + ">" + (v ? short(v) : "0") + "</text>"; });
    const line = pts.map((p, k) => p.v == null ? null : (L + k * slot).toFixed(1) + "," + y(p.v).toFixed(1)).filter(Boolean);
    if (line.length > 1) s += '<polyline points="' + line.join(" ") + '" fill="none" stroke="' + GREEN + '" stroke-width="2"/>';
    pts.forEach((p, k) => {
      s += '<text x="' + (L + k * slot) + '" y="' + (B + 22) + '" ' + F + ' text-anchor="middle">' + p.label + "</text>";
      if (p.v != null) s += '<rect x="' + (L + k * slot - slot / 2) + '" y="0" width="' + slot + '" height="' + B + '" fill="transparent" data-tip="' + esc(p.label + "|" + money(p.v)) + '"/>';
    });
    return s;
  });
}

/* ---------- needs attention ---------- */
function openTasks() {
  const t = data.tasks; if (!t) return [];
  const out = [];
  t.display.forEach((r, i) => (r || []).forEach((v, j) => { const f = (t.fmt[i] || [])[j] || {}; if (i > 1 && lc(v) && !f.b && !f.s && !(typeof ((t.raw[i] || [])[j]) === "string" && t.raw[i][j].startsWith("="))) out.push({ i, j, text: String(v) }); }));
  return out;
}
function attentionItems() {
  const all = { from: "0000-01-01", to: "9999-12-31" };
  const check = sel(all, r => r.category === "check").length;
  const rg = range(), cos = scopeEntities().filter(e => e !== "personal");
  const wrong = sel(rg, r => WRONG_ACCOUNT.includes(r.category)).length;
  const noReceipt = sel(rg, r => isCost(r) && !r.receipt, cos).length;
  let due = 0; const fl = data.filings;
  if (fl) fl.display.forEach(r => (r || []).forEach(v => { if (["to do", "confirm"].includes(lc(v))) due++; }));
  return [
    { n: check, text: (check === 1 ? "transaction" : "transactions") + " to categorise", urgent: true, go: () => goTransactions({ category: "check", from: "", to: "" }) },
    { n: due, text: (due === 1 ? "filing" : "filings") + " to do or confirm", urgent: true, go: () => fl && showView(fl.name) },
    { n: wrong, text: (wrong === 1 ? "cost" : "costs") + " paid from the wrong account", go: () => goTransactions({ only: "wrong" }) },
    { n: noReceipt, text: (noReceipt === 1 ? "cost" : "costs") + " with no receipt", go: () => goTransactions({ only: "receipt", entities: cos.length > 1 ? cos : null, entity: cos.length === 1 ? cos[0] : "" }) }
  ].filter(i => i.n > 0 || i.urgent);
}
function renderAttention() {
  const box = $("#attention"), items = attentionItems(), tasks = openTasks();
  const copy = el("button", "btn", "copy"); copy.type = "button";
  copy.onclick = () => {
    const txt = ["needs attention"].concat(items.map(i => i.n + " " + i.text), tasks.length ? ["", "tasks"] : [], tasks.map(t => "- " + t.text)).join("\n");
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => { copy.textContent = "copied"; setTimeout(() => (copy.textContent = "copy"), 1500); }, () => {});
  };
  const hd = el("div", "hd"); hd.append(el("b", null, "needs attention"), copy);
  box.replaceChildren(hd);
  items.forEach(i => {
    const b = el("button", "item"); b.type = "button";
    b.append(el("span", i.urgent && i.n ? "hl" : null, String(i.n)), document.createTextNode(" " + i.text));
    b.onclick = i.go; box.append(b);
  });
  if (!data.tasks) return;
  box.append(el("i", "mt tasks-label", tasks.length ? "tasks, " + tasks.length + " left" : "tasks, all done"));
  const shown = dash.allTasks ? tasks : tasks.slice(0, 3);
  shown.forEach(t => {
    const row = el("div", "task"), tick = el("button", "tick"); tick.type = "button"; tick.setAttribute("aria-label", "done");
    tick.onclick = () => { row.classList.add("done"); setStrike(data.tasks, t.i, t.j, true); setTimeout(renderAttention, 700); };
    row.append(tick, el("span", null, t.text)); box.append(row);
  });
  if (tasks.length > 3) { const m = el("button", "more", dash.allTasks ? "show fewer" : "show " + (tasks.length - 3) + " more"); m.type = "button"; m.onclick = () => { dash.allTasks = !dash.allTasks; renderAttention(); }; box.append(m); }
}

/* ---------- statements, saved as pdf through the print dialog ---------- */
const COMPANY = { "ie ltd": "Conversion Alchemy Limited", "uk ltd": "Conversion Alchemy Ltd" };
const CUR_NAME = { USD: "US dollars", EUR: "euro", GBP: "pounds sterling" };
function companyYear(e) {
  // the company's own financial year that ends inside the year picked on the dashboard
  const ye = data.ent[e].ye, s = new Date(dash.fy + "T00:00:00");
  for (let k = 0; k < 12; k++) { const m = addMonths(s, k); if (m.getMonth() + 1 === ye) { const end = monthEnd(m); return { from: iso(addMonths(end, -11)), to: iso(end), months: 12, kind: "year" }; } }
  return range();
}
function yearProfit(e, rg) {
  const rows = sel(rg, null, [e]);
  return total(rows.filter(r => isIncome(r) || isCost(r) || r.category === "director pay")) - taxFor(e, rg);
}
function statementFigures(e, rg) {
  const ents = [e], rows = sel(rg, null, ents);
  const direct = rows.filter(r => isCost(r) && (r.stream || r.category === "payment fees"));
  const admin = rows.filter(r => (isCost(r) && !direct.includes(r)) || r.category === "director pay");
  const turnover = total(rows.filter(isIncome)), cos = total(direct), adminT = total(admin);
  const op = turnover + cos + adminT, tax = taxFor(e, rg), taxPaid = -total(rows.filter(r => r.group === "tax"));
  const cashEnd = balance(rg.to, null, ents), cashStart = balance(iso(new Date(new Date(rg.from + "T00:00:00").getTime() - 864e5)), null, ents);
  const loanCats = ["director's loan", "business costs paid personally"];
  const loanEnd = -balance(rg.to, r => loanCats.includes(r.category), ents);
  const loanMove = total(rows.filter(r => loanCats.includes(r.category)));
  // tax owed at the year end: this year's estimate less anything paid since the year end, kept simple
  const taxOwed = Math.max(0, tax);
  const adminLines = groupBy(admin, "category").map(c => ({ label: c.label === "check" ? "not yet categorised" : c.label, v: c.v }));
  // retained profit from the first year to this one; what's left over is intercompany money, transfers and exchange differences
  let reserves = 0; const first = (data.rows.find(r => r.entity === e) || {}).date || rg.from;
  for (let y = rg; y.to >= first; y = prevRange(y)) reserves += yearProfit(e, y);
  return { turnover, cos, gross: turnover + cos, adminT, adminLines, op, tax, profit: op - tax, taxPaid, cashEnd, cashStart, loanEnd, loanMove, taxOwed,
    net: reserves, otherBal: reserves - (cashEnd + loanEnd - taxOwed), other: cashEnd - cashStart - op + taxPaid - loanMove };
}
function statementsHtml() {
  const ents = dash.scope === "ie ltd" || dash.scope === "uk ltd" ? [dash.scope] : ["ie ltd", "uk ltd"];
  const n = v => Math.abs(v) < 0.5 ? "–" : (v < 0 ? "(" : "") + Math.round(Math.abs(v)).toLocaleString("en-GB") + (v < 0 ? ")" : "");
  const sym = SYMBOL[dash.cur];
  let html = "";
  ents.forEach(e => {
    const rg = companyYear(e), pv = prevRange(rg), a = statementFigures(e, rg), b = statementFigures(e, pv);
    const y1 = rg.to.slice(0, 4), y0 = pv.to.slice(0, 4), ed = new Date(rg.to + "T00:00:00"), end = ed.getDate() + " " + ed.toLocaleString("en-GB", { month: "long" }) + " " + ed.getFullYear();
    const row = (label, k, cls = "", fa, fb) => '<tr class="' + cls + '"><td>' + esc(label) + '</td><td class="n now">' + n(fa != null ? fa : a[k]) + '</td><td class="n">' + n(fb != null ? fb : b[k]) + "</td></tr>";
    const head = '<tr class="head"><td></td><td class="n now">' + y1 + "<br>" + sym + '</td><td class="n">' + y0 + "<br>" + sym + "</td></tr>";
    const gap = '<tr class="gap"><td></td><td></td><td></td></tr>';
    const page = (title, body) => '<section class="page"><h1>' + esc(COMPANY[e]) + "</h1><h2>" + esc(title) + '</h2><table class="stmt">' + head + body + '</table><p class="foot">Management accounts prepared from bank and Stripe records, not statutory accounts. Presented in ' + CUR_NAME[dash.cur] + ".</p></section>";
    const adminKeys = [...new Set(a.adminLines.concat(b.adminLines).map(l => l.label))];
    const find = (x, k) => (x.adminLines.find(l => l.label === k) || { v: 0 }).v;
    html += page("Profit and loss account for the year ended " + end,
      row("Turnover", "turnover") + row("Cost of sales", "cos") + row("Gross profit", "gross", "rule bold") + gap
      + adminKeys.map(k => row(k.charAt(0).toUpperCase() + k.slice(1), null, "ind", find(a, k), find(b, k))).join("")
      + row("Administrative expenses", "adminT", "rule") + gap
      + row("Operating profit", "op", "bold") + row("Tax on profit (estimate)", null, "", -a.tax, -b.tax)
      + row("Profit for the financial year", "profit", "dbl bold"));
    html += page("Statement of financial position at " + end,
      '<tr class="sub"><td>Current assets</td><td></td><td></td></tr>'
      + row("Cash at bank and in hand", "cashEnd", "ind") + gap
      + row("Creditors: corporation tax", null, "", -a.taxOwed, -b.taxOwed)
      + (Math.abs(a.loanEnd) + Math.abs(b.loanEnd) > 0.5 ? row("Director's loan account", "loanEnd") : "")
      + row("Intercompany and other balances", "otherBal") + gap
      + row("Net current assets", "net", "rule bold") + gap
      + '<tr class="sub"><td>Capital and reserves</td><td></td><td></td></tr>'
      + row("Profit and loss account", "net", "ind") + row("Shareholders' funds", "net", "dbl bold"));
    html += page("Statement of cash flows for the year ended " + end,
      row("Operating profit", "op") + row("Tax paid", null, "", -a.taxPaid, -b.taxPaid) + row("Director's loan account", "loanMove")
      + row("Transfers, intercompany and exchange differences", "other")
      + row("Net change in cash", null, "rule bold", a.cashEnd - a.cashStart, b.cashEnd - b.cashStart) + gap
      + row("Cash at the start of the year", "cashStart") + row("Cash at the end of the year", "cashEnd", "dbl bold"));
  });
  return html;
}
function saveStatements() {
  $("#print").innerHTML = statementsHtml();
  const before = document.title, e = dash.scope === "ie ltd" || dash.scope === "uk ltd" ? dash.scope : "companies";
  document.title = "conversion alchemy " + (e === "ie ltd" ? "irish company" : e === "uk ltd" ? "uk company" : "companies") + " statements " + fyLabel(new Date(dash.fy + "T00:00:00"), scopeYe()) + " " + dash.cur.toLowerCase();
  const done = () => { document.title = before; window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  window.print();
}

/* ---------- sheet tabs ---------- */
function goTransactions(f) {
  const rg = range();
  const ents = scopeEntities();
  Object.assign(txFilter, TX_CLEAR, { entity: ents.length === 1 ? ents[0] : "", entities: ents.length > 1 ? ents : null, from: rg.from, to: rg.to }, f);
  showView("transactions");
}
function showView(name) {
  view = name;
  [...$("#tabs").children].forEach(b => b.setAttribute("aria-selected", b.dataset.view === name));
  $("#viewDashboard").hidden = name !== "dashboard";
  $("#viewSheet").hidden = name === "dashboard";
  if (name === "dashboard") renderDashboard(); else renderSheet(tabByName(name.toLowerCase()) || book.tabs.find(t => t.name === name));
}
function usedSize(tab) {
  let rows = 0, cols = 0;
  [tab.display, tab.raw].forEach(g => g.forEach((r, i) => (r || []).forEach((v, j) => { if (v !== "" && v != null) { rows = Math.max(rows, i + 1); cols = Math.max(cols, j + 1); } })));
  return { rows, cols };
}
function firstUsedCol(tab) {
  let c = Infinity; tab.display.forEach(r => (r || []).forEach((v, j) => { if (v !== "" && v != null) c = Math.min(c, j); }));
  return c === Infinity ? 0 : c;
}
let more = null;
function renderSheet(tab) {
  const head = $("#sheetHead"), grid = $("#grid"); head.innerHTML = ""; grid.innerHTML = ""; $("#more").innerHTML = "";
  if (more) { more.disconnect(); more = null; }
  if (!tab) return;
  const isTx = tab.name.toLowerCase() === "transactions", isTasks = tab.name.toLowerCase() === "tasks";
  const size = usedSize(tab), c0 = firstUsedCol(tab);
  if (isTx && data.head >= 0) return renderTransactions(tab, c0, size.cols);
  const body = el("tbody");
  for (let i = 0; i <= size.rows; i++) {
    const tr = el("tr");
    for (let j = c0; j < size.cols; j++) tr.append(cell(tab, i, j, { tasks: isTasks }));
    body.append(tr);
  }
  grid.append(body);
}
function cell(tab, i, j, o = {}) {
  const td = el("td");
  const raw = ((tab.raw[i] || [])[j]); const disp = ((tab.display[i] || [])[j]);
  const f = (tab.fmt[i] || [])[j] || {};
  const isFormula = typeof raw === "string" && raw.startsWith("=");
  if (f.b) td.classList.add("b"); if (f.i) td.classList.add("i"); if (f.s) td.classList.add("s"); if (f.y) td.classList.add("y"); if (f.line) td.classList.add("line");
  if (o.right) td.classList.add("r");
  const link = isFormula && /^=HYPERLINK\(\s*"([^"]+)"/i.exec(raw);
  if (link && /^https:\/\//.test(link[1])) { const a = el("a", null, disp || "link"); a.href = link[1]; a.target = "_blank"; a.rel = "noopener"; td.append(a); return td; }
  td.textContent = disp == null ? "" : disp;
  if (isFormula) { td.classList.add("formula"); return td; }
  if (o.tasks && lc(disp) && !f.b) {
    td.classList.add("task", "edit");
    td.addEventListener("click", e => { if (e.detail > 1) return; setTimeout(() => { if (td.dataset.editing) return; const on = !td.classList.contains("s"); td.classList.toggle("s", on); setStrike(tab, i, j, on); }, 220); });
    td.addEventListener("dblclick", () => edit(td, tab, i, j));
    return td;
  }
  td.classList.add("edit");
  td.addEventListener("click", () => edit(td, tab, i, j));
  return td;
}
function edit(td, tab, i, j) {
  if (td.dataset.editing) return; td.dataset.editing = "1";
  const before = (tab.raw[i] || [])[j]; const input = el("input"); input.value = before == null ? "" : before;
  td.textContent = ""; td.append(input); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  let done = false;
  const finish = save => {
    if (done) return; done = true; delete td.dataset.editing;
    const v = input.value;
    if (save && String(v) !== String(before == null ? "" : before)) { td.textContent = v; writeCell(tab, i, j, v).then(() => { buildModel(); if (view !== "dashboard") rerenderCellRow(tab); }); }
    else td.textContent = (tab.display[i] || [])[j] || "";
  };
  input.addEventListener("keydown", e => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
  input.addEventListener("blur", () => finish(true));
}
function rerenderCellRow(tab) {
  const sc = $("#sheetScroll").scrollTop; renderSheet(tab); $("#sheetScroll").scrollTop = sc;
}

function renderTransactions(tab, c0, cols) {
  const head = $("#sheetHead"), grid = $("#grid"), c = data.cols;
  const search = el("input"); search.type = "search"; search.placeholder = "search"; search.value = txFilter.text;
  const mk = (label, values, key) => { const s = el("select"); s.append(new Option(label, "")); values.forEach(v => s.append(new Option(v, v))); s.value = txFilter[key] || ""; s.onchange = () => { txFilter[key] = s.value; if (key === "entity") txFilter.entities = null; draw(); }; return s; };
  const entities = [...new Set(data.rows.map(r => r.entity))].sort(), accounts = [...new Set(data.rows.map(r => r.account))].sort();
  const cats = [...new Set(data.cats.concat(data.rows.map(r => r.category)))].filter(Boolean).sort();
  const count = el("span", "count");
  head.append(search, mk("all entities", entities, "entity"), mk("all accounts", accounts, "account"), mk("all categories", cats, "category"));
  if (txFilter.only) { const b = el("button", "chip", txFilter.only === "wrong" ? "paid from the wrong account" : "no receipt"); b.type = "button"; b.onclick = () => { txFilter.only = null; renderSheet(tab); }; head.append(b); }
  if (txFilter.group) { const b = el("button", "chip", "all " + txFilter.group + "s"); b.type = "button"; b.onclick = () => { txFilter.group = ""; renderSheet(tab); }; head.append(b); }
  if (txFilter.from) { const b = el("button", "chip", txFilter.from + " to " + txFilter.to); b.type = "button"; b.onclick = () => { txFilter.from = txFilter.to = ""; renderSheet(tab); }; head.append(b); }
  head.append(count);
  let t; search.oninput = () => { clearTimeout(t); t = setTimeout(() => { txFilter.text = search.value; draw(); }, 150); };

  const hdr = tab.display[data.head] || [];
  function draw() {
    grid.innerHTML = ""; $("#more").innerHTML = ""; if (more) more.disconnect();
    const thead = el("thead"), tr = el("tr"); for (let j = c0; j < cols; j++) tr.append(el("th", null, hdr[j] || "")); thead.append(tr); grid.append(thead);
    const q = lc(txFilter.text);
    const list = data.rows.filter(r => (!txFilter.from || (r.date >= txFilter.from && r.date <= txFilter.to)) && (!txFilter.entities || txFilter.entities.includes(r.entity)) && (!txFilter.entity || r.entity === txFilter.entity) && (!txFilter.account || r.account === txFilter.account)
      && (!txFilter.category || r.category === txFilter.category) && (!txFilter.group || r.group === txFilter.group)
      && (txFilter.only !== "wrong" || WRONG_ACCOUNT.includes(r.category)) && (txFilter.only !== "receipt" || (r.group === "cost" && !r.receipt))
      && (!q || (r.merchant + " " + lc((tab.display[r.i] || [])[c.reference]) + " " + r.category + " " + r.date).includes(q))).reverse();
    count.textContent = list.length.toLocaleString("en-GB") + " rows";
    const body = el("tbody"); grid.append(body);
    let shown = 0;
    const page = () => {
      const frag = document.createDocumentFragment();
      list.slice(shown, shown + 300).forEach(r => {
        const row = el("tr");
        for (let j = c0; j < cols; j++) {
          if (j === c.category) {
            const td = el("td"); const s = el("select", "cat"); cats.forEach(v => s.append(new Option(v, v))); s.value = r.category;
            s.onchange = () => { writeCell(tab, r.i, j, s.value).then(() => { buildModel(); }); };
            td.append(s); row.append(td);
          } else row.append(cell(tab, r.i, j, { right: j === c.amount || j === c["reporting amount"] }));
        }
        frag.append(row);
      });
      body.append(frag); shown += 300;
      if (shown >= list.length && more) more.disconnect();
    };
    page();
    const sentinel = el("div"); sentinel.style.height = "1px"; $("#more").append(sentinel);
    more = new IntersectionObserver(es => { if (es[0].isIntersecting && shown < list.length) page(); }, { root: $("#sheetScroll"), rootMargin: "400px" });
    more.observe(sentinel);
  }
  draw();
}

/* ---------- shell ---------- */
function start() {
  buildModel();
  $("#gate").hidden = true; $("#app").hidden = false; $("#top").hidden = false;
  document.title = book.title; $("#brandName").textContent = book.title;
  const tabs = $("#tabs"); tabs.innerHTML = "";
  ["dashboard"].concat(book.tabs.map(t => t.name).filter(n => !HIDE_TABS.includes(n.toLowerCase()))).forEach(n => {
    const b = el("button", null, n); b.type = "button"; b.setAttribute("role", "tab"); b.dataset.view = n;
    b.onclick = () => { if (n.toLowerCase() === "transactions") Object.assign(txFilter, TX_CLEAR); showView(n); };
    tabs.append(b);
  });
  $("#openInSheets").href = "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(book.id) + "/edit";
  try { const v = JSON.parse(localStorage.getItem(VIEW_KEY)) || {}; dash.scope = v.scope || dash.scope; dash.cur = v.cur || dash.cur; } catch {}
  applyCurrency();
  showView(view);
}
function showGate() { $("#gate").hidden = false; $("#app").hidden = true; $("#top").hidden = true; }
function menu(open) { $("#brandMenu").hidden = !open; $("#brandButton").setAttribute("aria-expanded", open); }

$("#signIn").addEventListener("click", () => {
  gateError("");
  requestToken(() => { const f = lastFile(); f ? loadBook(f.id) : openPicker(); });
});
$("#brandButton").addEventListener("click", e => { e.stopPropagation(); menu($("#brandMenu").hidden); });
document.addEventListener("click", e => { if (!e.target.closest(".brand")) menu(false); });
document.addEventListener("keydown", e => { if (e.key === "Escape") menu(false); });
$("#pickFile").addEventListener("click", () => { menu(false); if (TEST) return; signedIn() ? openPicker() : requestToken(openPicker); });
$("#openInSheets").addEventListener("click", () => menu(false));
$("#signOut").addEventListener("click", () => {
  menu(false);
  if (auth.token && window.google && google.accounts) google.accounts.oauth2.revoke(auth.token, () => {});
  auth.token = null; book = null; data = null; setLastFile(null); showGate();
});
$("#pdfButton").addEventListener("click", saveStatements);
let resizeTimer = null;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (data && view === "dashboard") renderDashboard(); }, 150); });
document.addEventListener("mousemove", e => {
  const tip = $("#tip"), t = e.target.closest && e.target.closest("[data-tip]");
  if (!t) { tip.hidden = true; return; }
  tip.innerHTML = t.dataset.tip.split("|").map(esc).join("<br>"); tip.hidden = false;
  tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px"; tip.style.top = (e.clientY + 14) + "px";
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && book && !TEST && !signedIn()) status("signed out. sign out from the menu, then sign in again."); });

if (TEST) { book = TEST; start(); }
else loadScript("https://accounts.google.com/gsi/client").catch(() => gateError("google sign-in couldn't load. check your connection."));
