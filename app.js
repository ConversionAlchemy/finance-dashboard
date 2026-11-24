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
const WRONG_ACCOUNT = ["director's loan", "business costs paid personally"];
const SYMBOL = { GBP: "£", EUR: "€", USD: "$" };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTHS_LONG = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TEST = window.__TEST_BOOK__ || null;

const auth = { token: null, expires: 0, client: null };
const TOKEN_KEY = "ca-finance-pass";   // kept for this tab only, cleared when the tab closes or on sign out
function savePass() { try { auth.token ? sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ t: auth.token, e: auth.expires })) : sessionStorage.removeItem(TOKEN_KEY); } catch {} }
function loadPass() { try { const p = JSON.parse(sessionStorage.getItem(TOKEN_KEY)); if (p && p.e > Date.now()) { auth.token = p.t; auth.expires = p.e; } else sessionStorage.removeItem(TOKEN_KEY); } catch {} }
let book = null;       // { id, title, tabs: [{ name, sheetId, display, raw, fmt }] }
let view = "dashboard";
let data = null;       // parsed model used by the dashboard
const dash = { mode: "business", co: "companies", scope: "companies", period: "fy", cur: "USD", fy: null, month: null, stream: null, cat: null, acct: null, allTasks: false };
const COMPANIES = [["companies", "both companies"], ["ie ltd", "irish company"], ["uk ltd", "uk company"]];
const PERIODS = [["all", "all time"], ["fy", "this year"], ["3m", "last 3 months"], ["1m", "last month"]];
const FX_FALLBACK = { GBPEUR: 1.17, USDEUR: 0.92, EURGBP: 0.855, USDGBP: 0.78 };
const TX_CLEAR = { text: "", entity: "", entities: null, category: "", account: "", group: "", only: null, from: "", to: "", rec: "", supplier: "", notIn: null };
const txFilter = Object.assign({}, TX_CLEAR);
const EXPORT_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M7 7.5H4.5v9h11v-9H13"/><path d="M10 12.5V2.5M6.5 6L10 2.5 13.5 6"/></svg>';
const COLS_KEY = "ca-finance-columns-2";
const TX_OPTIONAL = ["account", "entity", "reference", "amount"], TX_DEFAULT_OFF = ["account", "entity", "amount"];
const txHidden = new Set((() => { try { return JSON.parse(localStorage.getItem(COLS_KEY)) || null; } catch { return null; } })() || TX_DEFAULT_OFF);

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
    savePass();
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
  if (res.status === 401) { auth.token = null; savePass(); throw Object.assign(new Error("signed out"), { expired: true }); }
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
  // as a director, your income is what the companies pay you: salary and dividends come from their books,
  // so the same money landing in a personal account is a transfer, and company costs you paid are owed back, not spending
  rows.forEach(r => {
    if (r.entity !== "personal") return;
    if (r.group === "income" && r.merchant.includes("conversion alchemy")) r.group = "transfer";
    if (r.category === "business costs paid personally") r.group = "owed";
  });
  rows.filter(r => r.entity !== "personal" && (r.category === "director pay" || r.category === "dividends")).forEach(r => {
    rows.push(Object.assign({}, r, { entity: "personal", synthetic: true, account: r.entity === "uk ltd" ? "from the uk company" : "from the irish company",
      category: r.category === "director pay" ? "salary" : "dividends", group: "income", stream: "", amount: -r.amount, rep: -r.rep }));
  });
  rows.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
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
// every amount converts once, straight from the currency it actually moved in
function applyCurrency() { data.rows.forEach(r => { const m = r.date.slice(0, 7); r.v = SYMBOL[r.cur] ? r.amount * rate(m, r.cur, dash.cur) : r.rep * rate(m, r.repCur, dash.cur); }); }
// a balance on a date, from each row's own currency, at that date's rate
function balance(to, fn, ents = scopeEntities()) {
  const byCur = {};
  data.rows.forEach(r => { if (!r.synthetic && ents.includes(r.entity) && r.date <= to && (!fn || fn(r))) byCur[r.cur] = (byCur[r.cur] || 0) + r.amount; });
  const now = iso(new Date()); const m = (to > now ? now : to).slice(0, 7);
  return Object.entries(byCur).reduce((a, [c, v]) => a + v * rate(m, c || "EUR", dash.cur), 0);
}
function scopeEntities(sc = dash.scope) {
  if (sc === "companies") return ["ie ltd", "uk ltd"];
  return [sc];
}

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
// all time, the last 3 complete months, the last complete month, or a financial year; a clicked month overrides them
function range() {
  const thisMonth = new Date(iso(new Date()).slice(0, 7) + "-01T00:00:00");
  if (dash.month) { const m = new Date(dash.month + "-01T00:00:00"); return { from: iso(m), to: iso(monthEnd(m)), months: 1, kind: "month" }; }
  if (dash.period === "1m") { const m = addMonths(thisMonth, -1); return { from: iso(m), to: iso(monthEnd(m)), months: 1, kind: "month" }; }
  if (dash.period === "3m") { const m = addMonths(thisMonth, -3); return { from: iso(m), to: iso(monthEnd(addMonths(m, 2))), months: 3, kind: "3m" }; }
  if (dash.period === "all") {
    const ents = scopeEntities(), first = data.rows.find(r => ents.includes(r.entity)), a = new Date(((first && first.date) || iso(thisMonth)).slice(0, 7) + "-01T00:00:00");
    const n = (thisMonth.getFullYear() - a.getFullYear()) * 12 + thisMonth.getMonth() - a.getMonth() + 1;
    return { from: iso(a), to: iso(monthEnd(thisMonth)), months: n, kind: "all" };
  }
  const s = new Date(dash.fy + "T00:00:00");
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
const sel = (rg, fn, ents = scopeEntities()) => data.rows.filter(r => ents.includes(r.entity) && inRange(r, rg) && (!fn || fn(r)));
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
function taxOwed(d) {
  let owed = 0;
  scopeEntities().filter(e => e !== "personal").forEach(e => {
    const ye = (data.ent[e] || {}).ye || 12, cur = fyStartFor(d, ye), prev = addMonths(cur, -12);
    const accrued = taxFor(e, { from: iso(prev), to: iso(monthEnd(addMonths(cur, -1))) }) + taxFor(e, { from: iso(cur), to: d });
    const paid = -total(sel({ from: iso(prev), to: d }, r => r.group === "tax", [e]));
    owed += Math.max(0, accrued - paid);
  });
  return owed;
}
function figures(rg) {
  const rows = sel(rg);
  const income = total(rows.filter(isIncome));
  const costs = total(rows.filter(isCost));
  const pay = total(rows.filter(r => r.category === "director pay"));
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
const catName = c => c === "check" ? "to categorise" : c === "income" && dash.scope === "personal" ? "other income" : c;
const words = () => dash.scope === "personal"
  ? { rev: "income", cost: "spending", allRev: "all income", allCost: "all spending", keep: "saved / invested", stream: "source", box: "income and spending", pbt: "saved / invested", of: "of income" }
  : { rev: "revenue", cost: "costs", allRev: "all revenue", allCost: "all costs", keep: "profit", stream: "stream", box: "revenue and costs", pbt: "profit before tax", of: "of revenue" };
const streamOf = r => r.stream || (dash.scope === "personal" ? catName(r.category) : "other");

/* ---------- svg ---------- */
const F = 'font-size="14" font-family="PT Sans, Arial, sans-serif" fill="currentColor"';
const GREEN = "#00C601", RED = "#FF5429", GTEXT = "var(--gtext)", RTEXT = "var(--rtext)";
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

/* ---------- stepping through periods: a year, or a month once you click into one ---------- */
function nextPeriod(dir, fys = fyList()) {
  const has = fy => fys.some(f => f.start === fy);
  if (dash.month) {
    const m = addMonths(new Date(dash.month + "-01T00:00:00"), dir), fy = iso(fyStartFor(iso(m), scopeYe()));
    return has(fy) && iso(m) <= iso(new Date()) ? { fy, month: iso(m).slice(0, 7) } : null;
  }
  if (dash.period !== "fy") return { period: "fy" };
  const fy = iso(addMonths(new Date(dash.fy + "T00:00:00"), 12 * dir));
  return has(fy) ? { fy, month: null } : null;
}
function stepPeriod(dir) { const n = nextPeriod(dir); if (n) { Object.assign(dash, n); renderDashboard(); } }
document.addEventListener("keydown", e => {
  if (!data || view !== "dashboard" || e.metaKey || e.ctrlKey || e.altKey || /input|select|textarea/i.test((e.target.tagName || ""))) return;
  if (e.key === "ArrowLeft") { e.preventDefault(); stepPeriod(-1); }
  if (e.key === "ArrowRight") { e.preventDefault(); stepPeriod(1); }
});

/* ---------- business or personal: the master switch in the top bar ---------- */
function modeFilter() { return dash.mode === "personal" ? { entity: "personal", entities: null } : { entity: "", entities: ["ie ltd", "uk ltd"] }; }
function renderMode() {
  document.documentElement.classList.toggle("dark", dash.mode === "personal");
  const mp = $("#modePick"); mp.innerHTML = "";
  [["business", "business"], ["personal", "personal"]].forEach(([k, t]) => {
    const b = el("button", null, t); b.type = "button"; b.setAttribute("aria-pressed", dash.mode === k);
    b.onclick = () => {
      if (dash.mode === k) return;
      dash.mode = k; dash.fy = null; dash.month = null; dash.flow = dash.acct = null;
      if (view === "dashboard") renderDashboard();
      else { renderMode(); if (view === "transactions") Object.assign(txFilter, TX_CLEAR, modeFilter()); showView(view); }
    };
    mp.append(b);
  });
}

/* ---------- dashboard ---------- */
function renderDashboard() {
  dash.scope = dash.mode === "personal" ? "personal" : (COMPANIES.some(([k]) => k === dash.co) ? dash.co : (dash.co = "companies"));
  dash.cur = "USD";
  const fys = fyList();
  if (!fys.find(f => f.start === dash.fy)) { const cur = fyStartFor(iso(new Date()), scopeYe()); dash.fy = (fys.find(f => f.start === iso(cur)) || fys[0] || {}).start; dash.month = null; }
  try { localStorage.setItem(VIEW_KEY, JSON.stringify({ mode: dash.mode, co: dash.co, period: dash.period })); } catch {}
  if (!dash.fy) return;
  renderMode();

  const sp = $("#scopePick"); sp.innerHTML = "";
  COMPANIES.forEach(([k, label]) => { const o = el("option", null, label); o.value = k; o.selected = k === dash.co; sp.append(o); });
  sp.onchange = () => { dash.co = sp.value; dash.fy = null; dash.flow = dash.acct = null; renderDashboard(); };
  $("#coBox").hidden = dash.mode === "personal";
  const pp = $("#periodPick"); pp.innerHTML = "";
  // "this year" is the financial year we're in now; the arrows and the year list step to other years
  const curFy = iso(fyStartFor(iso(new Date()), scopeYe()));
  PERIODS.forEach(([k, t]) => {
    const b = el("button", null, t); b.type = "button";
    b.setAttribute("aria-pressed", dash.period === k && !dash.month && (k !== "fy" || dash.fy === curFy));
    b.onclick = () => { dash.period = k; dash.month = null; if (k === "fy" && fys.some(f => f.start === curFy)) dash.fy = curFy; renderDashboard(); };
    pp.append(b);
  });
  const yp = $("#yearPick"); yp.innerHTML = "";
  fys.forEach(f => { const o = el("option", null, f.label); o.value = f.start; o.selected = f.start === dash.fy; yp.append(o); });
  yp.onchange = () => { dash.fy = yp.value; dash.period = "fy"; dash.month = null; renderDashboard(); };
  yp.closest(".step").classList.toggle("on", dash.period === "fy" && !dash.month && dash.fy !== iso(fyStartFor(iso(new Date()), scopeYe())));
  const chip = $("#monthChip");
  chip.hidden = !dash.month; if (dash.month) { const m = new Date(dash.month + "-01T00:00:00"); chip.textContent = MONTHS[m.getMonth()] + " " + m.getFullYear(); chip.onclick = () => { dash.month = null; renderDashboard(); }; }
  const personal = dash.scope === "personal";
  $("#pdfButton").hidden = personal;

  const rg = range();
  document.querySelectorAll(".step .prev").forEach(b => { b.disabled = !nextPeriod(-1, fys); b.onclick = () => stepPeriod(-1); });
  document.querySelectorAll(".step .next").forEach(b => { b.disabled = !nextPeriod(1, fys); b.onclick = () => stepPeriod(1); });
  renderSummary(rg);
  renderMonthChart(rg);
  renderFlow(rg);
  renderFilings();
  renderCash(rg);
  renderMore();
  renderTasks();
  renderAttention();
}

function renderSummary(rg) {
  const f = figures(rg), p = rg.kind === "all" ? {} : figures(prevRange(rg)), personal = dash.scope === "personal";
  const than = { year: "last year", "3m": "the 3 months before", month: "the month before" }[rg.kind];
  // against the period before, in brackets after each figure; the heading says what it's compared with
  const change = (a, b) => { if (rg.kind === "all" || !b) return ""; const c = (Math.abs(a) - Math.abs(b)) / Math.abs(b); return (c >= 0 ? "+" : "−") + pct(Math.abs(c)); };
  const cols = [
    [words().rev, f.income, "g", change(f.income, p.income)],
    [words().cost, -f.costs, "r", change(f.costs, p.costs)],
    [words().pbt, f.profit, f.profit < 0 ? "r" : "g", f.income > 0 && Math.abs(f.profit / f.income) <= 5 ? pct(f.profit / f.income) + " " + words().of : ""]
  ];
  const bud = personal && monthlyBudget();
  if (bud) {
    const planned = bud.spend * monthsElapsed(rg), over = -f.costs - planned;
    cols.push(["budget", planned, "", [el("span", over > 0.5 ? "r" : "g", over > 0.5 ? money(over) + " over" : money(-over) + " under")]]);
  }
  if (!personal) cols.push(["tax due (estimate)", f.tax, "r", f.taxPaid > 0.5 ? money(f.taxPaid) + " paid" : "none paid"]);
  cols.push(["cash", f.cash, f.cash < 0 ? "r" : "g", rg.kind === "all" ? "" : change(f.cash, p.cash)]);
  const bi = cols.findIndex(c => c[0] === "budget"); if (bi > 2) cols.splice(2, 0, cols.splice(bi, 1)[0]);
  if (personal) {
    // net worth: your cash, plus what the companies owe you on your director's loan (minus what you owe them)
    const loan = c => balance(c, r => ["director's loan", "business costs paid personally"].includes(r.category), ["ie ltd", "uk ltd", "personal"]);
    const nw = f.cash + loan(rg.to), nwp = rg.kind === "all" ? null : (p.cash || 0) + loan(prevRange(rg).to);
    cols.push(["net worth", nw, nw < 0 ? "r" : "g", nwp == null ? "" : change(nw, nwp)]);
  }
  // a list like the sections below: each figure coloured, its comparison in brackets after it
  const heading = rg.kind === "all" ? "since " + longDate(rg.from) : "compared with " + than;
  $("#summary").replaceChildren(el("i", "mt", heading), ...cols.map(([label, v, cls, note]) => {
    const val = [el("span", cls || null, money(v))];
    if (note && (Array.isArray(note) ? note.length : true)) { val.push(document.createTextNode(" (")); if (Array.isArray(note)) val.push(...note); else val.push(document.createTextNode(note)); val.push(document.createTextNode(")")); }
    return lead(label, val);
  }));
}

// the months the chart shows: the financial year, everything since the start, or the 12 months up to the period picked
function chartWindow() {
  const thisMonth = new Date(iso(new Date()).slice(0, 7) + "-01T00:00:00");
  if (dash.period === "all") {
    const ents = scopeEntities(), first = data.rows.find(r => ents.includes(r.entity)), a = new Date(((first && first.date) || iso(thisMonth)).slice(0, 7) + "-01T00:00:00");
    return { start: a, n: (thisMonth.getFullYear() - a.getFullYear()) * 12 + thisMonth.getMonth() - a.getMonth() + 1 };
  }
  if (dash.period === "fy") return { start: new Date(dash.fy + "T00:00:00"), n: 12 };
  return { start: addMonths(thisMonth, -12), n: 12 };
}
let filedRows = {}, subGroups = {};
// google-style hover for charts: a dotted guide, a dot on each series and its value beside it, drawn in the chart itself
// google-sheets-style hover: a dot on each series, and one block beside the guide naming the point and each value in it,
// so the chart needs no key underneath
const SVGT = ' font-size="13" font-family="PT Sans, Arial, sans-serif" fill="currentColor"';
const tw = t => String(t).length * 7.1;
function hoverBlock(x, top, lines, W, H, B) {
  // lines: [{ t, c?, hollow?, title? }]; drawn beside x, flipped left when it would run off the right edge
  const lw = Math.max(...lines.map(l => tw(l.t) + (l.title ? 12 : 30))), h = lines.length * 19 + 8;
  // l.sub: a detail line under the one before it, indented, no dot
  const lx = x + 12 + lw <= W ? x + 10 : x - 10 - lw, ty = Math.max(2, Math.min(top, B - h));
  let s = '<rect x="' + lx + '" y="' + ty + '" width="' + lw + '" height="' + h + '" style="fill:var(--card);stroke:var(--hair)"/>';
  lines.forEach((l, i) => {
    const cy = ty + 14 + i * 19;
    if (!l.title && !l.sub) s += '<circle cx="' + (lx + 8) + '" cy="' + cy + '" r="4" style="fill:' + (l.hollow ? "var(--card)" : l.c) + ';stroke:' + l.c + '" stroke-width="1.5"/>';
    s += '<text x="' + (lx + (l.title ? 4 : 18)) + '" y="' + (cy + 4.5) + '"' + SVGT + (l.title ? ' font-style="italic"' : "") + (l.sub ? ' style="fill:var(--grey)"' : "") + ">" + esc(l.t) + "</text>";
  });
  return s;
}
function hoverCol(o) {
  let s = '<g class="col"><rect class="' + (o.hitCls || "hit") + '" x="' + o.x + '" y="0" width="' + o.w + '" height="' + (o.B + 4) + '" fill="transparent"' + (o.attrs || "") + '/><g class="hov" pointer-events="none">';
  if (o.guide !== false) s += '<line x1="' + o.gx + '" x2="' + o.gx + '" y1="' + o.T + '" y2="' + o.B + '" style="stroke:var(--grey)" stroke-dasharray="2 3"/>';
  const pts = o.pts.filter(p => p && p.y != null && isFinite(p.y));
  if (!pts.length) return s + "</g></g>";
  pts.forEach(p => { s += '<circle cx="' + p.x + '" cy="' + p.y + '" r="4.5" style="fill:' + (p.hollow ? "var(--card)" : p.c) + ';stroke:' + p.c + '" stroke-width="2"/>'; });
  const lines = (o.title ? [{ t: o.title, title: true }] : []).concat(pts.map(p => ({ t: (p.label ? p.label + "  " : "") + p.t, c: p.c, hollow: p.hollow })));
  s += hoverBlock(o.gx, Math.min(...pts.map(p => p.y)) - (o.title ? 24 : 10), lines, o.W, 0, o.B);
  return s + "</g></g>";
}
// the buckets the summary chart draws: months for a year or all time, weeks for 3 months, days for a single month,
// so a short period shows its own ups and downs instead of a year with a few months picked out
function chartBuckets(rg) {
  const day = d => new Date(d + "T00:00:00"), plus = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const step = rg.kind === "month" ? 1 : rg.kind === "3m" ? 7 : 0;
  if (!step) {
    const win = chartWindow();
    return { unit: "month", list: Array.from({ length: win.n }, (_, k) => { const m = addMonths(win.start, k); return { from: iso(m), to: iso(monthEnd(m)), m: iso(m).slice(0, 7), mi: m.getMonth(), label: MONTHS[m.getMonth()], ly: -12 }; }) };
  }
  const list = [], end = day(rg.to);
  for (let d = day(rg.from); d <= end; d = plus(d, step)) {
    const e = plus(d, step - 1), to = e > end ? end : e;
    list.push({ from: iso(d), to: iso(to), d: d.getDate(), mi: d.getMonth(), label: d.getDate() + " " + MONTHS[d.getMonth()], ly: -364 });
  }
  return { unit: step === 1 ? "day" : "week", list };
}
function renderMonthChart(rg) {
  const host = $("#monthChart"); host.className = "chart";
  const today = iso(new Date()), bk = chartBuckets(rg), N = bk.list.length, monthly = bk.unit === "month";
  const back = (d, n) => { const x = new Date(d + "T00:00:00"); return iso(n === -12 ? new Date(x.getFullYear() - 1, x.getMonth(), x.getDate()) : new Date(x.getFullYear(), x.getMonth(), x.getDate() + n)); };
  const series = bk.list.map(b => {
    const rows = sel(b);
    // the same stretch a year earlier (the same weekdays for weeks and days), drawn as a hatched shadow behind the bar; not on all time
    const ly = dash.period === "all" ? null : total(sel({ from: back(b.from, b.ly), to: back(b.to, b.ly) }).filter(isIncome));
    return Object.assign({}, b, { started: b.from <= today, inc: total(rows.filter(isIncome)), cost: -total(rows.filter(isCost)), ly });
  });
  const start = new Date(series[0].from + "T00:00:00");
  const mb = dash.scope === "personal" ? monthlyBudget() : null, per = monthly ? 1 : bk.unit === "week" ? 7 / 30.44 : 1 / 30.44;
  const bud = mb ? { spend: mb.spend * per } : null;
  const max = niceMax(Math.max(1, bud ? bud.spend : 0, ...series.map(s => Math.max(s.inc, s.cost, s.ly || 0))));
  const chart = el("div");
  host.replaceChildren(chart);
  const fyStart = series[0].from, fyEnd = series[N - 1].to, fyStartMonth = scopeYe() % 12;
  // which bar a date falls in
  const idx = d => series.findIndex(b => d >= b.from && d <= b.to);
  const dated = upcomingFilings();
  const laterGroups = dated.filter(g => g.when > fyEnd), padR = 12;
  svgBox(chart, 250, Wd => {
    const L = 40, base = 190, y = v => base - v / max * 180, slot = (Wd - L - padR) / N, many = monthly && N > 18; let s = "";
    const txt = (x, t) => '<text x="' + x + '" y="' + (base + 20) + '" ' + F + ">" + t + "</text>";
    // months: the name (or the year on all time); weeks: the day they start; days: every 7th day, with the month on the first
    const axisLabel = (d, k, x) => monthly ? (many ? (d.mi === 0 ? txt(L + k * slot, d.m.slice(0, 4)) : "") : txt(x, slot < 30 ? d.label[0] : d.label))
      : bk.unit === "week" ? (slot >= 58 || k % 2 === 0 ? txt(x, d.label) : "")
      : ((d.d - 1) % 7 === 0 ? txt(L + k * slot, d.d === 1 || k === 0 ? d.label : String(d.d)) : "");
    const cols = [];
    s += '<defs><pattern id="hatch" patternUnits="userSpaceOnUse" width="6" height="6"><path d="M0 0L6 6M6 0L0 6" style="stroke:var(--hatch)" stroke-width="0.9"/></pattern></defs>';
    [0, 0.25, 0.5, 0.75, 1].forEach(t => { const v = max * t; s += '<line x1="' + L + '" x2="' + (Wd - padR) + '" y1="' + y(v) + '" y2="' + y(v) + '" style="stroke:' + (t ? "var(--grid)" : "currentColor") + '"/><text x="0" y="' + (y(v) + 5) + '" ' + F + ">" + (t ? short(v) : "0") + "</text>"; });
    series.forEach((d, k) => {
      const x = L + k * slot + slot * 0.14, bw = slot * 0.34, on = !monthly || (d.m >= rg.from.slice(0, 7) && d.m <= rg.to.slice(0, 7));
      const ghost = d.ly > 0.5 ? '<rect x="' + (x - 3) + '" y="' + y(d.ly) + '" width="' + (bw + 6) + '" height="' + (base - y(d.ly)) + '" fill="url(#hatch)"/>' : "";
      s += '<g opacity="' + (on ? 1 : 0.3) + '">' + ghost + '<rect x="' + x + '" y="' + y(Math.max(0, d.inc)) + '" width="' + bw + '" height="' + (base - y(Math.max(0, d.inc))) + '" fill="' + GREEN + '"/>'
        + '<rect x="' + (x + bw + 2) + '" y="' + y(Math.max(0, d.cost)) + '" width="' + bw + '" height="' + (base - y(Math.max(0, d.cost))) + '" fill="' + RED + '"/></g>'
        + axisLabel(d, k, x);
      // a dotted line where each financial year starts
      if (monthly && k && d.mi === fyStartMonth) { const lx = L + k * slot; s += '<line x1="' + lx + '" x2="' + lx + '" y1="4" y2="' + base + '" style="stroke:var(--fyline)" stroke-dasharray="2 3"/><text x="' + (lx + 4) + '" y="40" font-size="14" font-family="PT Sans, Arial, sans-serif" style="fill:var(--grey)" font-style="italic">' + fyLabel(new Date(d.m + "-01T00:00:00"), scopeYe()) + "</text>"; }
      if (bud && slot >= 44 && d.started) { const u = bud.spend - d.cost; s += '<text x="' + x + '" y="' + (base + 40) + '" font-size="14" font-family="PT Sans, Arial, sans-serif" style="fill:' + (u < 0 ? RTEXT : GTEXT) + '">' + (u < 0 ? "+" : "−") + short(Math.abs(u)) + "</text>"; }
      else if (slot >= 44 && d.started && (d.inc || d.cost)) { const n = d.inc - d.cost; s += '<text x="' + x + '" y="' + (base + 40) + '" font-size="14" font-family="PT Sans, Arial, sans-serif" style="fill:' + (n < 0 ? RTEXT : GTEXT) + '">' + (n < 0 ? "" : "+") + short(n) + "</text>"; }
      cols.push(hoverCol({ x: L + k * slot, w: slot, gx: x + bw + 1, T: 4, B: base, W: Wd - padR, attrs: ' data-k="' + k + '"',
        title: monthly ? MONTHS_LONG[d.mi] + " " + d.from.slice(0, 4) : bk.unit === "day" ? longDate(d.from) : longDate(d.from) + " – " + longDate(d.to),
        pts: [{ x: x + bw / 2, y: y(d.inc), c: GREEN, label: words().rev, t: money(d.inc) }, { x: x + bw * 1.5 + 2, y: y(d.cost), c: RED, label: words().cost, t: money(d.cost) },
          d.ly > 0.5 ? { x: x + bw / 2, y: y(d.ly), c: "var(--hatch)", hollow: true, label: "a year earlier", t: money(d.ly) + " (" + (d.inc >= d.ly ? "+" : "−") + pct(Math.abs(d.inc - d.ly) / d.ly) + ")" } : null,
          bud ? { x: x + bw * 1.5 + 2, y: y(bud.spend), c: "var(--rtext)", hollow: true, label: "budget", t: money(bud.spend) } : null] }));
    });
    s += cols.join("");
    // your monthly spending budget as a dashed line across the chart
    if (bud) s += '<line x1="' + L + '" x2="' + (Wd - padR) + '" y1="' + y(bud.spend) + '" y2="' + y(bud.spend) + '" style="stroke:var(--rtext)" stroke-dasharray="5 4" stroke-width="1.5"/>';
    // submissions: a dotted line with a numbered ball on top, at the start of the month they're due in;
    // anything after this period gathers at the very end of the axis. every ball is the same size
    const marker = (x, gs, key) => {
      const n = gs.reduce((a, g) => a + g.items.length, 0);
      return '<g class="sub hit" data-key="' + key + '">'
        + '<line x1="' + x + '" x2="' + x + '" y1="21" y2="' + base + '" stroke="currentColor" stroke-dasharray="2 3" pointer-events="none"/>'
        + '<circle cx="' + x + '" cy="11" r="10" style="fill:var(--card)" stroke="currentColor" stroke-width="1.5"/>'
        + '<text x="' + x + '" y="15.5" font-size="12" text-anchor="middle" font-family="PT Sans, Arial, sans-serif" fill="currentColor" pointer-events="none">' + n + "</text>"
        + '<g class="hov" pointer-events="none">' + hoverBlock(x + 4, 26, [{ t: "to submit", title: true }].concat(gs.flatMap(g => g.items).flatMap(i => { const e = filingEstimate(i);
          return [{ t: i.name + " (" + i.who + ")", c: "currentColor", hollow: true }, { t: [submitText(i), i.deadline ? "due " + longDate(i.deadline) : "", e != null && e > 0.5 ? "about " + money(e) + " tax" : ""].filter(Boolean).join(", "), sub: true }]; })), Wd - padR, 0, base + 60) + "</g></g>";
    };
    const byMonth = new Map();
    dated.filter(g => g.when >= fyStart && g.when <= fyEnd).forEach(g => { const m = idx(g.when); byMonth.set(m, (byMonth.get(m) || []).concat([g])); });
    subGroups = {}; filedRows = {};
    byMonth.forEach((gs, k) => { subGroups[k] = gs; s += marker(L + k * slot, gs, k); });
    if (laterGroups.length) { subGroups.later = laterGroups; s += marker(L + N * slot, laterGroups, "later"); }
    // filings already sent: a filled ball at the month they went in
    const ents = scopeEntities(), filedBy = new Map();
    pastFilings().filter(f => ents.includes(f.who) && f.date >= fyStart && f.date <= fyEnd).forEach(f => { const m = idx(f.date); filedBy.set(m, (filedBy.get(m) || []).concat([f])); });
    filedBy.forEach((fs, k) => {
      const x = L + k * slot + (subGroups[k] ? 22 : 0);
      filedRows["f" + k] = fs[0].row;
      const fl = fs.map(f => ({ t: f.name + (f.period ? " " + f.period : "") + (ents.length > 1 ? " (" + f.who + ")" : "") + ", filed " + f.text, c: "var(--grey)" }));
      s += '<g class="sub filed hit" data-key="f' + k + '">'
        + '<line x1="' + x + '" x2="' + x + '" y1="21" y2="' + base + '" style="stroke:var(--grey)" stroke-dasharray="2 3" pointer-events="none"/>'
        + '<circle cx="' + x + '" cy="11" r="10" style="fill:var(--grey)" stroke="none"/>'
        + '<text x="' + x + '" y="15.5" font-size="12" text-anchor="middle" font-family="PT Sans, Arial, sans-serif" style="fill:var(--card)" pointer-events="none">' + fs.length + "</text>"
        + '<g class="hov" pointer-events="none">' + hoverBlock(x + 4, 26, [{ t: "filed", title: true }].concat(fl), Wd - padR, 0, base + 60) + "</g></g>";
    });
    return s;
  });

  host.querySelectorAll("g.sub").forEach(g => g.addEventListener("click", e => {
    e.stopPropagation();
    const k = g.dataset.key;
    if (k in filedRows) return openFiling(filedRows[k]);
    const gs = subGroups[k] || [], first = gs[0] && gs[0].items[0];
    if (first) openFiling(first.row);
  }));
  // a month picks that month for the whole dashboard; a week or a day opens its transactions
  host.querySelectorAll("rect.hit").forEach(b => b.addEventListener("click", () => {
    const d = series[+b.dataset.k];
    if (monthly) { dash.month = dash.month === d.m ? null : d.m; renderDashboard(); }
    else openTx({ from: d.from, to: d.to }, bk.unit === "day" ? longDate(d.from) : longDate(d.from) + " – " + longDate(d.to));
  }));
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
    if (Math.abs(rest) > 0.5) top.push({ label: "everything else", v: rest });
    const margin = i.v + steps.reduce((a, s) => a + s.v, 0);
    return { label: i.label, v: i.v, steps: top, margin };
  });
}
/* revenue and costs in one box: a list in two groups on the left, one chart on the right that follows the selection */
const BAR_REDS = [RED, "#ff7a57", "#ff9d82", "#ffbba8", "#ffd6ca", "#ffe9e2"];
function renderFlow(rg) {
  const list = $("#flowList"), detail = $("#flowDetail");
  const streams = streamMargins(rg), costRows = sel(rg, isCost);
  const cats = groupBy(costRows, "category").filter(c => c.v < -0.5).sort((a, b) => a.v - b.v);
  const f = dash.flow || (dash.flow = { side: "rev", key: null });
  if (f.side === "rev" && f.key && !streams.find(s => s.label === f.key)) f.key = null;
  if (f.side === "cost" && f.key && !cats.find(c => c.label === f.key)) f.key = null;
  const go = (side, key) => { dash.flow = { side, key }; renderFlow(rg); };
  const isSel = (side, key) => f.side === side && f.key === key;

  const allInc = streams.reduce((a, s) => a + s.v, 0);
  const outRows = sel(rg, r => isCost(r) || r.category === "director pay");
  const profit = allInc + total(outRows);
  const pctOf = (m, v) => v > 0 ? " (" + pct(m / v) + ")" : "";
  const w = words(), personal = dash.scope === "personal";
  $("#flowTitle").textContent = w.box;
  list.replaceChildren(el("i", "mt", w.rev));
  list.append(lead(w.allRev, money(allInc) + pctOf(profit, allInc), { sel: isSel("rev", null), onclick: () => go("rev", null) }));
  streams.forEach(s => list.append(lead(s.label, money(s.v) + (personal ? "" : pctOf(s.margin, s.v)), { sel: isSel("rev", s.label), onclick: () => go("rev", s.label) })));
  list.append(el("i", "mt group", w.cost));
  list.append(lead(w.allCost, money(-total(costRows)), { sel: isSel("cost", null), onclick: () => go("cost", null) }));
  cats.slice(0, 6).forEach(c => list.append(lead(catName(c.label), money(-c.v), { sel: isSel("cost", c.label), onclick: () => go("cost", c.label) })));
  const rest = cats.slice(6); if (rest.length) list.append(lead("everything else", money(-rest.reduce((a, c) => a + c.v, 0)), { onclick: () => openTx({ group: "cost", notIn: cats.slice(0, 6).map(c => c.label) }, "everything else") }));

  // what the chart shows for the selection
  let title, items, kind;
  const catClick = label => cats.find(c => c.label === label) ? () => go("cost", label) : null;
  if (f.side === "rev") {
    kind = "rev";
    const s = f.key ? streams.find(x => x.label === f.key) : null;
    const v = s ? s.v : allInc, keepV = s ? s.margin : profit;
    let steps = s ? s.steps : groupBy(outRows, "category").filter(c => c.v < -0.5).sort((a, b) => a.v - b.v);
    const long = !s && !personal, nTop = long ? 4 : 5;
    if (!s) { const top = steps.slice(0, nTop), r = steps.slice(nTop).reduce((a, c) => a + c.v, 0); steps = r < -0.5 ? top.concat([{ label: "everything else", v: r }]) : top; }
    title = s ? s.label : w.allRev;
    items = [{ label: s ? (personal ? w.keep : "margin") : w.keep, v: Math.max(0, keepV), keep: true, value: [el("span", keepV < 0 ? "r" : "g", money(keepV)), document.createTextNode(pctOf(keepV, v))] }]
      .concat(steps.map(st => ({ label: catName(st.label), v: -st.v, value: [el("span", "r", money(st.v)), document.createTextNode(pctOf(-st.v, v))], onclick: catClick(st.label) })));
    items.total = { label: w.rev, v }; items.keepV = keepV;
    if (long) {
      // past profit: the tax on it, what's left after tax, then where that money went, ending at how much cash went up or down
      items[0].label = "profit before tax";
      const fg = figures(rg), afterTax = keepV - fg.tax;
      const paidOut = -total(sel(rg, r => r.group === "director" && r.category !== "director pay"));
      const notYet = fg.tax - fg.taxPaid;
      const day = new Date(rg.from + "T00:00:00"); day.setDate(day.getDate() - 1);
      const change = balance(rg.to) - (rg.kind === "all" ? 0 : balance(iso(day)));
      const other = change - (afterTax - paidOut + notYet);
      items.after = [
        { label: "tax (estimate)", v: -fg.tax },
        { label: "after tax", sub: true },
        { label: "paid to you", v: -paidOut, onclick: () => openTx({ group: "director", notIn: ["director pay"] }, "paid to you") },
        { label: notYet >= 0 ? "tax not paid yet" : "earlier tax paid", v: notYet },
        { label: "transfers and timing", v: other },
        { label: change >= 0 ? "added to cash" : "taken from cash", sub: true }
      ].filter(x => x.sub || Math.abs(x.v) >= 0.5);
    }
  } else {
    kind = "cost";
    const pick = f.key ? costRows.filter(r => r.category === f.key) : costRows;
    const parts = (f.key ? groupBy(pick, r => supplier(r.merchant)) : cats.slice()).filter(p => p.v < -0.5).sort((a, b) => a.v - b.v);
    const shown = parts.slice(0, 6), others = parts.slice(6);
    if (others.length) shown.push({ label: others.length + " others", v: others.reduce((a, p) => a + p.v, 0), others: true });
    const sum = -shown.reduce((a, p) => a + p.v, 0);
    title = f.key ? catName(f.key) : w.allCost;
    items = shown.map(it => ({ label: f.key ? it.label : catName(it.label), v: -it.v, value: money(-it.v) + pctOf(-it.v, sum),
      onclick: it.others ? () => openTx(f.key ? { category: f.key, notIn: null } : { group: "cost" }, f.key ? catName(f.key) : "all costs") : f.key ? () => openTx({ category: f.key, supplier: it.label }, it.label) : () => go("cost", it.label) }));
    items.total = { label: f.key ? catName(f.key) : w.allCost, v: sum };
  }
  let cost = 0; items.forEach(it => { it.c = it.keep ? GREEN : BAR_REDS[Math.min(cost++, 5)]; });

  detail.replaceChildren(el("i", "mt", title), kind === "rev" ? waterfall(items) : columns(items));
  if (!items.length) detail.append(el("p", "empty", "nothing in this period"));
}

// one column per figure: the bar on top, then its share, its name and its amount underneath
function colChart(cols, lo, hi) {
  const wrap = el("div", "wf"), span = (hi - lo) || 1;
  cols.forEach(c => {
    const col = el("div", "wf-col" + (c.onclick ? " link" : "")), plot = el("div", "wf-plot"), bar = el("div", "wf-bar");
    const a = Math.min(c.from, c.to), z = Math.max(c.from, c.to);
    const b = (a - lo) / span * 100, h = Math.max(0.5, (z - a) / span * 100);
    bar.style.bottom = b + "%"; bar.style.height = h + "%"; bar.style.background = c.c;
    // the share sits in the bar's top-left corner, or just under the bar when the bar is too short to hold it
    const share = el("span", "wf-pct", c.pct);
    // (a short bar standing on the baseline gets it just above instead, so it never runs into the labels)
    if (h / 100 * 220 >= 28) bar.append(share);
    else { share.classList.add("out"); if (b < 1) share.style.bottom = "calc(" + (b + h) + "% + 4px)", share.style.top = "auto"; else share.style.top = "calc(" + (100 - b) + "% + 4px)"; }
    plot.append(bar); if (!bar.contains(share)) plot.append(share);
    if (lo < 0) { const zero = el("div", "wf-zero"); zero.style.bottom = (-lo / span * 100) + "%"; plot.append(zero); }
    const lab = el("div", "wf-lab"); lab.append(el("span", "nm", c.label), el("span", c.cls, c.value));
    lab.title = c.label + "  " + c.value + " (" + c.pct + ")";
    col.append(plot, lab);
    if (c.onclick) col.addEventListener("click", c.onclick);
    wrap.append(col);
  });
  return wrap;
}

// revenue at the start, each cost stepping down from it, and what is left at the end
function waterfall(items) {
  if (!items.total || !items.total.v) return el("div");
  const v = items.total.v, keep = items.find(i => i.keep), steps = items.filter(i => !i.keep), k = items.keepV;
  const cols = [{ label: items.total.label, from: 0, to: v, c: GREEN, pct: "100%", value: money(v), cls: "g" }];
  let top = v;
  steps.forEach(s => { cols.push({ label: s.label, from: top, to: top - s.v, c: s.c, pct: pct(s.v / v), value: money(-s.v), cls: "r", onclick: s.onclick }); top -= s.v; });
  cols.push({ label: keep.label, from: 0, to: k, c: k < 0 ? RED : GREEN, pct: pct(k / v), value: money(k), cls: k < 0 ? "r" : "g" });
  // money that carries on past profit: steps up (light green) or down (light red), and subtotals standing on the baseline
  let lo = Math.min(0, top, k), hi = v; top = k;
  (items.after || []).forEach(a => {
    if (a.sub) cols.push({ label: a.label, from: 0, to: top, c: top < 0 ? RED : GREEN, pct: pct(top / v), value: money(top), cls: top < 0 ? "r" : "g" });
    else { cols.push({ label: a.label, from: top, to: top + a.v, c: a.v < 0 ? "#FFB4A0" : "#9BE49C", pct: pct(Math.abs(a.v) / v), value: (a.v < 0 ? "" : "+") + money(a.v), cls: a.v < 0 ? "r" : "g", onclick: a.onclick }); top += a.v; }
    lo = Math.min(lo, top); hi = Math.max(hi, top);
  });
  return colChart(cols, lo, hi);
}

// a cost category broken down: one column each, tallest first
function columns(items) {
  const sum = items.total ? items.total.v : 0, hi = Math.max(0, ...items.map(i => i.v));
  return colChart(items.map(i => ({ label: i.label, from: 0, to: i.v, c: i.c, pct: pct(i.v / (sum || 1)), value: money(-i.v), cls: "r", onclick: i.onclick })), 0, hi);
}

function renderCash(rg) {
  const list = $("#cashList"), detail = $("#cashDetail"), to = rg.to;
  const accounts = [...new Set(data.rows.filter(r => scopeEntities().includes(r.entity)).map(r => r.account))];
  const items = accounts.map(a => ({ label: a, v: balance(to, r => r.account === a) })).filter(i => Math.abs(i.v) >= 0.5).sort((a, b) => b.v - a.v);
  if (dash.acct && !items.find(i => i.label === dash.acct)) dash.acct = null;
  list.replaceChildren(el("i", "mt", "account"));
  list.append(lead("all accounts", money(balance(to)), { sel: !dash.acct, onclick: () => { dash.acct = null; renderCash(rg); } }));
  items.forEach(i => list.append(lead(i.label, money(i.v), { sel: i.label === dash.acct, onclick: () => { dash.acct = i.label; renderCash(rg); } })));

  // month-end cash for the year, the same months a year earlier, and (for the companies as a whole) cash after the tax owed
  const start = new Date(dash.fy + "T00:00:00"), today = iso(new Date()), pts = [], fn = dash.acct ? r => r.account === dash.acct : null;
  const firstDate = (data.rows.find(r => !r.synthetic && scopeEntities().includes(r.entity)) || {}).date || "9999";
  const showTax = !dash.acct && dash.scope !== "personal";
  for (let k = 0; k < 12; k++) {
    const m = monthEnd(addMonths(start, k)), d = iso(m), dd = d < today ? d : today, lyD = iso(monthEnd(addMonths(m, -12)));
    const v = d.slice(0, 7) <= today.slice(0, 7) ? balance(dd, fn) : null;
    pts.push({ label: MONTHS[m.getMonth()], y: m.getFullYear(), v, ly: lyD >= firstDate ? balance(lyD, fn) : null, free: v != null && showTax ? v - taxOwed(dd) : null });
  }
  const box = el("div", "chart");
  detail.replaceChildren(el("i", "mt", dash.acct || "all accounts"), box);
  const vals = pts.flatMap(p => [p.v, p.ly, p.free]).filter(v => v != null);
  if (!vals.length) return;
  // a scale that fits the values instead of starting at zero, so real movement shows
  const minV = Math.min(...vals), maxV = Math.max(...vals), span = Math.max(1, maxV - minV), step = niceMax(span / 4);
  const lo = Math.floor((minV - span * 0.08) / step) * step, hi = Math.ceil((maxV + span * 0.08) / step) * step;
  svgBox(box, 200, W => {
    const L = 44, T = 10, B = 170, y = v => B - (v - lo) / (hi - lo) * (B - T), slot = (W - L - 20) / 11; let s = "";
    for (let v = lo; v <= hi + 0.5; v += step) s += '<line x1="' + L + '" x2="' + W + '" y1="' + y(v) + '" y2="' + y(v) + '" style="stroke:' + (v === lo ? "currentColor" : "var(--grid)") + '"/><text x="0" y="' + (y(v) + 5) + '" ' + F + ">" + short(v) + "</text>";
    const path = key => pts.map((p, k) => p[key] == null ? null : (L + k * slot).toFixed(1) + "," + y(p[key]).toFixed(1)).filter(Boolean);
    const ly = path("ly"), free = path("free"), now = path("v"), hov = [];
    if (ly.length > 1) s += '<polyline points="' + ly.join(" ") + '" fill="none" style="stroke:var(--hatch)" stroke-width="2" stroke-dasharray="5 4"/>';
    if (free.length > 1) s += '<polyline points="' + free.join(" ") + '" fill="none" stroke="' + GREEN + '" stroke-width="1.5" stroke-dasharray="2 3"/>';
    if (now.length > 1) s += '<polyline points="' + now.join(" ") + '" fill="none" stroke="' + GREEN + '" stroke-width="2"/>';
    pts.forEach((p, k) => {
      s += '<text x="' + (L + k * slot) + '" y="' + (B + 22) + '" ' + F + ' text-anchor="middle">' + p.label + "</text>";
      hov.push(hoverCol({ x: L + k * slot - slot / 2, w: slot, gx: L + k * slot, T, B, W, hitCls: "spot", title: p.label + " " + p.y, pts: [
        p.v != null ? { x: L + k * slot, y: y(p.v), c: GREEN, label: "cash", t: money(p.v) } : null,
        p.free != null ? { x: L + k * slot, y: y(p.free), c: GREEN, hollow: true, label: "after tax owed", t: money(p.free) } : null,
        p.ly != null ? { x: L + k * slot, y: y(p.ly), c: "var(--hatch)", label: "a year earlier", t: money(p.ly) } : null] }));
    });
    return s + hov.join("");
  });

}


/* filings already sent, from the status tables on the filings tab (one per company): a marker at the month each went in */
function pastFilings() {
  const t = data.filings; if (!t) return [];
  const rows = t.display, out = [], MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  for (let i = 0; i < rows.length; i++) {
    const r = (rows[i] || []).map(lc), c = r.indexOf("filing");
    if (c < 0 || r[c + 2] !== "submitted" || r[c + 3] !== "status") continue;
    const title = lc(((rows[i - 1] || [])[c]) || ""), who = /irish/.test(title) ? "ie ltd" : /uk/.test(title) ? "uk ltd" : /personal|self/.test(title) ? "personal" : "";
    for (let j = i + 1; j < rows.length; j++) {
      const x = (rows[j] || []).map(lc); if (!x[c]) break;
      const sub = x[c + 2] || "", m = /^(?:paid )?(?:(\d{1,2}) )?([a-z]{3}) (\d{4})$/.exec(sub);
      if (!m || !MON[m[2]] || x[c + 3] === "later") continue;
      const date = m[3] + "-" + String(MON[m[2]]).padStart(2, "0") + "-" + String(m[1] || 1).padStart(2, "0");
      out.push({ row: j, name: x[c], period: x[c + 1], who, date, text: sub });
    }
  }
  return out;
}
/* filing dates from the filings tab: a dot at each target date (7 days after the window opens) */
function filingDates() {
  const t = data.filings; if (!t) return [];
  const rows = t.display, out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = (rows[i] || []).map(lc), c = r.indexOf("who");
    if (c < 1 || r[c + 1] !== "opens" || r[c + 2] !== "target") continue;
    for (let j = i + 1; j < rows.length; j++) {
      const x = rows[j] || []; if (!lc(x[c - 1])) break;
      const d = k => (/^\d{4}-\d{2}-\d{2}/.exec(String(x[k] || "")) || [""])[0];
      out.push({ row: j, col: c + 5, name: lc(x[c - 1]), who: lc(x[c]), opens: d(c + 1), target: d(c + 2), deadline: d(c + 3), notes: lc(x[c + 4]), status: lc(x[c + 5]) || "coming up" });
    }
    break;
  }
  return out;
}
function filingEstimate(f) {
  if (!/corporation tax/.test(f.name) || f.who !== "ie ltd") return null;
  const y = +((/(\d{4})/.exec(f.name) || [])[1]); if (!y) return null;
  const yr = /preliminary/.test(f.name) ? y - 1 : y;
  return taxFor("ie ltd", { from: yr + "-01-01", to: yr + "-12-31", months: 12 });
}
function upcomingFilings() {
  const today = iso(new Date()), ents = scopeEntities(), groups = new Map();
  filingDates().filter(f => ents.includes(f.who) && (f.target || f.deadline) && f.status !== "done" && !(f.deadline && f.deadline < today)).forEach(f => {
    let when = f.target || f.deadline; const late = when < today; if (late) when = today;
    const g = groups.get(when) || { when, items: [], late: false }; g.items.push(f); g.late = g.late || late; groups.set(when, g);
  });
  const gs = [...groups.values()].sort((a, b) => a.when < b.when ? -1 : 1);
  gs.forEach(g => {
    g.soon = g.late || (new Date(g.when + "T00:00:00") - new Date(today + "T00:00:00")) / 864e5 <= 30;
  });
  return gs;
}
// filings: only what still needs doing for this period or earlier. business and personal under italic headings,
// the current mode's first. statuses are changed in the sheet, not here. clicking a filing opens its row on the filings tab
function submitText(f, today = iso(new Date())) { const d = f.target || f.deadline; return !d ? "" : d < today ? "submit now" : "submit " + longDate(d); }
function filingYear(f) { return +((/(\d{4})/.exec(f.name) || [])[1]) || 0; }
function filingLive(f, today = iso(new Date())) { return f.status !== "done" && f.status !== "filed, to confirm" && filingYear(f) <= +today.slice(0, 4); }
function renderFilings() {
  const box = $("#filingsBox"), today = iso(new Date()), pick = null, y = today.slice(0, 4);
  box.replaceChildren(el("b", "hd", "filings"));
  const items = filingDates().filter(f => pick ? pick.names.includes(f.name) && f.status !== "done" : filingLive(f, today));
  const when = f => f.target || f.deadline || "";
  const sortKey = f => when(f) ? (when(f) < today ? "0" : "1" + when(f)) : "2";
  const sides = [["business", f => f.who !== "personal"], ["personal", f => f.who === "personal"]];
  if (dash.mode === "personal") sides.reverse();
  let any = false;
  sides.forEach(([label, fn]) => {
    const list = items.filter(fn).sort((a, b) => sortKey(a) < sortKey(b) ? -1 : 1);
    if (!list.length) return;
    any = true; box.append(el("i", "mt filing-group", label));
    list.forEach(f => {
      const d = when(f), late = d && d < today;
      const value = !d ? f.status : late ? "now" : (() => { const x = new Date(d + "T00:00:00"); return x.getDate() + " " + MONTHS[x.getMonth()] + (d.slice(0, 4) === y ? "" : " " + d.slice(0, 4)); })();
      const row = lead(f.name + (f.who !== "personal" ? " (" + f.who + ")" : ""), value, { cls: "filing" + (late ? " late" : ""), onclick: () => openFiling(f.row) });
      row.title = [f.name + (f.who !== "personal" ? " (" + f.who + ")" : ""), d ? submitText(f, today) : "", f.deadline ? "due " + longDate(f.deadline) : "", f.notes].filter(Boolean).join("\n");
      box.append(row);
    });
  });
  if (!any) box.append(el("p", "empty", "nothing to file"));
}


/* ---------- budget: a monthly target per line, beside what a normal month looks like ----------
   lines live on a "budget" tab in the sheet (mode, group, line, per month), one row each, added and edited here like a sheet.
   a line is compared with the category or stream of the same name; a line with no match (investments, say) is just a target. */
const BUD_GROUPS = { business: [["revenue", "in"], ["costs", "out"]], personal: [["income", "in"], ["spending", "out"], ["saving", "save"]] };
const bud = { tab: "budget", edit: null };
function budgetRows() {
  const t = tabByName("budget"); if (!t) return [];
  return t.display.map((r, i) => ({ i, mode: lc((r || [])[1]), group: lc((r || [])[2]), line: lc((r || [])[3]), amount: num((r || [])[4]) })).filter(r => r.i > 2 && r.line && (r.mode === "business" || r.mode === "personal"));
}
// the last 12 full months that have transactions in them (personal bank data can stop earlier than the company's)
const modeEnts = mode => mode === "personal" ? ["personal"] : ["ie ltd", "uk ltd"];
function lastTwelve(mode = dash.mode) {
  const ents = modeEnts(mode), last = data.rows.reduce((m, r) => ents.includes(r.entity) && !r.synthetic && r.date > m ? r.date : m, "");
  const ref = last ? new Date(last + "T00:00:00") : new Date(), end = new Date(ref.getFullYear(), ref.getMonth(), 0), from = new Date(end.getFullYear(), end.getMonth() - 11, 1);
  return { from: iso(from), to: iso(end) };
}
function median(xs) { if (!xs.length) return 0; const a = [...xs].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
// a normal month for a line: the median of the last 12 months, so one big or quiet month doesn't pull it about
function typical(kind, name, mode = dash.mode) {
  const ents = modeEnts(mode), rg = lastTwelve(mode), s = new Date(rg.from + "T00:00:00");
  const fn = kind === "in" ? r => isIncome(r) && (r.stream === name || r.category === name) : r => r.category === name && !isIncome(r);
  const rows = sel(rg, fn, ents); if (!rows.length) return null;
  return median(Array.from({ length: 12 }, (_, k) => { const m = iso(addMonths(s, k)).slice(0, 7); return Math.abs(total(rows.filter(r => r.date.slice(0, 7) === m))); }));
}
// the first time a mode is opened: one line per stream or category you actually used in the last 12 months, set at its normal month
function seedBudget(mode) {
  const ents = modeEnts(mode), rg = lastTwelve(mode), out = [];
  BUD_GROUPS[mode].forEach(([g, kind]) => {
    if (kind === "save") return;
    const rows = sel(rg, kind === "in" ? isIncome : isCost, ents), names = new Map();
    rows.forEach(r => { const n = kind === "in" && mode === "business" ? (r.stream || r.category) : r.category; if (n) names.set(n, (names.get(n) || 0) + Math.abs(r.v)); });
    [...names.entries()].sort((x, y) => y[1] - x[1]).forEach(([n]) => { const t = typical(kind, n, mode); if (t != null) out.push({ mode, group: g, line: n, amount: Math.round(t / 10) * 10 }); });
  });
  return out;
}
function budgetLines(mode = dash.mode) { const rows = budgetRows().filter(r => r.mode === mode); return rows.length ? rows : seedBudget(mode); }
// what you spend in a month on your personal budget (the dashboard's budget line)
function monthlyBudget() { const sp = budgetLines("personal").filter(r => r.group === "spending").reduce((a, r) => a + r.amount, 0); return sp > 0 ? { spend: sp } : null; }
async function saveBudget(lines) {
  // this mode's lines are rewritten; the other mode's are kept as they are
  const other = dash.mode === "personal" ? "business" : "personal", keep = budgetRows().filter(r => r.mode === other);
  const rows = lines.map(r => [dash.mode, r.group, r.line, r.amount]).concat(keep.map(r => [r.mode, r.group, r.line, r.amount]));
  let t = tabByName("budget");
  const old = t ? t.display.filter((r, i) => i > 2 && (r || []).some(Boolean)).length : 0;
  while (rows.length < old) rows.push(["", "", "", ""]);
  const head = [["budget"], [], ["mode", "group", "line", "per month"]];
  if (TEST) {
    if (!t) { t = { name: "budget", display: [], raw: [], fmt: [] }; book.tabs.push(t); }
    t.display = [["", "budget"], [], ["", ...head[2]]].concat(rows.map(r => ["", ...r.map(String)])); t.raw = t.display; return;
  }
  status("saving");
  try {
    if (!t) {
      const res = await api(SHEETS + book.id + ":batchUpdate", { method: "POST", body: JSON.stringify({ requests: [{ addSheet: { properties: { title: "budget" } } }] }) });
      t = { name: "budget", sheetId: res.replies[0].addSheet.properties.sheetId, display: [], raw: [], fmt: [] }; book.tabs.push(t);
    }
    const range = quote(t.name) + "!B1:E" + (3 + rows.length);
    await api(SHEETS + book.id + "/values/" + encodeURIComponent(range) + "?valueInputOption=USER_ENTERED", { method: "PUT", body: JSON.stringify({ range, majorDimension: "ROWS", values: [["budget"], [""], head[2]].concat(rows) }) });
    await refreshTab(t); status("saved");
  } catch (e) { status(e.expired ? "signed out. sign in again to save." : e.message); }
}
function renderBudget(host) {
  const mode = dash.mode, personal = mode === "personal", lines = budgetLines(mode).map(r => ({ group: r.group, line: r.line, amount: r.amount }));
  const commit = () => { saveBudget(lines).then(() => renderMore()); renderMore(); };
  const tb = el("table", "plan budget"), head = el("tr");
  const win = lastTwelve(mode), mo = d => MONTHS[+d.slice(5, 7) - 1] + " " + d.slice(0, 4);
  ["", "per month", "normal month", "difference"].forEach((h, k) => { const th = el("th", k ? "num" : null, h); if (k === 2) th.title = "the middle month of " + mo(win.from) + " – " + mo(win.to); head.append(th); });
  tb.append(el("thead")); tb.tHead.append(head);
  const body = el("tbody"), sp = (cls, txt) => { const td = el("td", cls); td.append(el("span", null, txt)); return td; };
  const diffCell = (b, t, kind) => { if (t == null) return sp("num", ""); const d = kind === "in" ? t - b : b - t; return sp("num " + (Math.abs(d) < 0.5 ? "" : d < 0 ? "r" : "g"), Math.abs(d) < 0.5 ? "–" : (d < 0 ? "−" : "+") + money(Math.abs(d)).replace(/^−/, "")); };
  // click a cell to type in it, like a sheet; enter or clicking away saves, escape cancels
  const editable = (td, value, set, isNum) => {
    td.classList.add("editable");
    td.onclick = () => {
      if (td.querySelector("input")) return;
      const input = el("input", "inline"); input.value = value; td.replaceChildren(input); input.focus(); input.select();
      let done = false; const finish = ok => { if (done) return; done = true; const v = isNum ? parseFloat(input.value.replace(/[^0-9.\-]/g, "")) : lc(input.value).trim(); if (ok && (isNum ? isFinite(v) : v)) { set(v); commit(); } else renderMore(); };
      input.onkeydown = e => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); }; input.onblur = () => finish(true);
    };
  };
  const sums = {};
  BUD_GROUPS[mode].forEach(([g, kind]) => {
    const mine = lines.filter(r => r.group === g), ts = mine.map(r => typical(kind, r.line));
    const bt = mine.reduce((a, r) => a + r.amount, 0), tt = ts.reduce((a, t) => a + (t || 0), 0); sums[g] = { b: bt, t: tt, kind };
    // the group's difference only counts lines that have a normal month to compare with
    const bm = mine.reduce((a, r, k) => a + (ts[k] == null ? 0 : r.amount), 0), has = ts.some(t => t != null);
    const hr = el("tr", "head line"); hr.append(sp(null, g), sp("num", money(bt)), sp("num", has ? money(tt) : ""), diffCell(bm, has ? tt : null, kind)); body.append(hr);
    mine.forEach((r, k) => {
      const tr = el("tr", "line"), name = sp(null, r.line), amt = sp("num", money(r.amount));
      editable(name, r.line, v => { r.line = v; }, false); editable(amt, String(r.amount), v => { r.amount = v; }, true);
      const x = el("button", "del", "×"); x.type = "button"; x.title = "remove " + r.line; x.onclick = e => { e.stopPropagation(); lines.splice(lines.indexOf(r), 1); commit(); };
      name.append(x);
      tr.append(name, amt, sp("num", ts[k] == null ? "" : money(ts[k])), diffCell(r.amount, ts[k], kind)); body.append(tr);
    });
    // a new line: type its name; it compares itself with the category or stream of that name, if there is one
    const add = el("tr", "add"), td = el("td"); td.colSpan = 4; const b = el("button", "add-line", "add line"); b.type = "button";
    b.onclick = () => { const input = el("input", "inline"); input.placeholder = "name"; td.replaceChildren(input); input.focus();
      let done = false; const finish = ok => { if (done) return; done = true; const v = lc(input.value).trim(); if (ok && v) { const t = typical(kind, v); lines.push({ group: g, line: v, amount: t ? Math.round(t / 10) * 10 : 0 }); commit(); } else renderMore(); };
      input.onkeydown = e => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); }; input.onblur = () => finish(true); };
    td.append(b); add.append(td); body.append(add);
  });
  // the bottom line
  const res = (label, b, t, good) => { const tr = el("tr", "head line"); tr.append(sp(null, label), sp("num " + (b < 0 ? "r" : ""), money(b)), sp("num", t == null ? "" : money(t)), t == null ? sp("num", "") : diffCell(b, t, good)); body.append(tr); };
  if (personal) {
    const s = sums, needB = s.spending.b + s.saving.b, needT = s.spending.t + s.saving.t;
    res("left over", s.income.b - needB, s.income.t - needT, "in");
    // what the company needs to pay you: everything you spend and put aside, less income from anywhere else
    const other = lines.filter(r => r.group === "income" && !/salary|dividend|director/.test(r.line)).reduce((a, r) => a + r.amount, 0);
    res("pay yourself", needB - other, null);
  } else {
    res("profit", sums.revenue.b - sums.costs.b, sums.revenue.t - sums.costs.t, "in");
  }
  tb.append(body);
  host.replaceChildren(tb);
}

/* ---------- filings, in full: what's coming up and what's gone in ---------- */
function renderFilingList(host) {
  const today = iso(new Date()), when = f => f.target || f.deadline || "";
  const up = filingDates().filter(f => f.status !== "done").sort((a, b) => (when(a) || "9") < (when(b) || "9") ? -1 : 1);
  const done = pastFilings().sort((a, b) => a.date < b.date ? 1 : -1);
  const who = w => w && w !== "personal" ? " (" + w + ")" : "";
  const col = (title, rows) => { const d = el("div", "pick"); d.append(el("i", "mt", title), ...rows); if (!rows.length) d.append(el("p", "empty", "nothing")); return d; };
  const upRows = up.map(f => { const d = when(f), late = d && d < today; const r = lead(f.name + who(f.who), d ? (late ? "now" : longDate(d)) : f.status, { cls: "filing" + (late ? " late" : "") }); r.dataset.row = "u" + f.row; r.title = [submitText(f, today), f.deadline ? "due " + longDate(f.deadline) : "", f.notes].filter(Boolean).join("\n"); return r; });
  const doneRows = done.map(f => { const r = lead(f.name + (f.period ? " " + f.period : "") + who(f.who), f.text, { cls: "filing" }); r.dataset.row = "d" + f.row; return r; });
  const g = el("div", "split"); g.append(col("coming up", upRows), col("filed", doneRows)); host.replaceChildren(g);
}
// a filing clicked anywhere opens the filings tab at that row
function openFiling(row) {
  bud.tab = "filings"; if (view !== "dashboard") showView("dashboard"); else renderMore();
  const r = $('#moreBody [data-row="u' + row + '"], #moreBody [data-row="d' + row + '"]'); if (!r) return;
  r.scrollIntoView({ block: "center" }); r.classList.add("flash"); setTimeout(() => r.classList.remove("flash"), 2500);
}
function renderMore() {
  const pick = $("#morePick"); pick.innerHTML = "";
  [["budget", "budget"], ["filings", "filings"]].forEach(([k, l]) => { const b = el("button", null, l); b.type = "button"; b.setAttribute("aria-pressed", bud.tab === k); b.onclick = () => { bud.tab = k; renderMore(); }; pick.append(b); });
  $("#moreTitle").textContent = bud.tab;
  if (bud.tab === "filings") renderFilingList($("#moreBody")); else renderBudget($("#moreBody"));
}

/* ---------- needs attention ---------- */
function openTasks() {
  const t = data.tasks; if (!t) return [];
  const out = [];
  // the task is in column b; "personal" in column c marks it as yours rather than the business's
  const mine = dash.mode === "personal";
  t.display.forEach((r, i) => { const v = (r || [])[1], f = (t.fmt[i] || [])[1] || {}; if (i > 1 && lc(v) && !f.b && !f.s && (lc((r || [])[2]) === "personal") === mine) out.push({ i, j: 1, text: String(v) }); });
  return out;
}
function attentionItems() {
  const all = { from: "0000-01-01", to: "9999-12-31" };
  const check = sel(all, r => r.category === "check").length;
  const rg = range(), cos = scopeEntities().filter(e => e !== "personal");
  const wrong = sel(rg, r => WRONG_ACCOUNT.includes(r.category)).length;
  const noReceipt = sel(rg, r => receiptExpected(r) && !r.receipt, cos).length;
  return [
    { n: check, text: (check === 1 ? "transaction" : "transactions") + " to categorise", urgent: true, go: () => openTx({ category: "check", from: "", to: "" }, "to categorise") },
    { n: wrong, text: (wrong === 1 ? "cost" : "costs") + " paid from the wrong account", go: () => openTx({ only: "wrong" }, "paid from the wrong account") },
    { n: noReceipt, text: (noReceipt === 1 ? "cost" : "costs") + " with no receipt", go: () => openTx({ only: "receipt", entities: cos.length > 1 ? cos : null, entity: cos.length === 1 ? cos[0] : "" }, "costs with no receipt") }
  ].filter(i => i.n > 0 || i.urgent);
}
function renderAttention() {
  const box = $("#attention"), items = attentionItems().filter(i => i.n > 0);
  const copy = el("button", "btn", "copy"); copy.type = "button";
  copy.onclick = () => {
    const txt = ["needs attention"].concat(items.map(i => i.n + " " + i.text)).join("\n");
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => { copy.textContent = "copied"; setTimeout(() => (copy.textContent = "copy"), 1500); }, () => {});
  };
  const hd = el("div", "hd"); hd.append(el("b", null, "needs attention"), copy);
  box.replaceChildren(hd);
  if (!items.length) box.append(el("p", "empty", "nothing to flag"));
  items.forEach(i => {
    const b = el("button", "item"); b.type = "button";
    b.append(el("span", null, String(i.n)), document.createTextNode(" " + i.text));
    b.onclick = i.go; box.append(b);
  });
}
// tasks: a plain text box, one task per line. it saves to the tasks tab when you click away
let fitTasks = () => {};
addEventListener("resize", () => fitTasks());
function renderTasks() {
  const box = $("#tasksBox"), t = data.tasks;
  box.hidden = !t; if (!t) return;
  const ta = el("textarea", "tasks-text"); ta.value = openTasks().map(x => x.text).join("\n\n"); ta.spellcheck = true; ta.setAttribute("aria-label", "tasks");
  // the box ends level with the bottom of the cash section; longer lists scroll inside the text box
  const fit = () => {
    const cash = $("#cashList") && $("#cashList").closest(".sec"), side = box.closest(".side-col");
    let room = Infinity;
    // off the dashboard the side column stops where the window ends, just above the watermark
    if (view !== "dashboard" && side) { const mark = $(".mark"); room = innerHeight - (mark ? mark.offsetHeight : 0) - (ta.getBoundingClientRect().top + scrollY) - parseFloat(getComputedStyle(box).paddingBottom); }
    else if (cash && side && cash.offsetParent && box.getBoundingClientRect().left >= cash.getBoundingClientRect().right) {
      room = cash.getBoundingClientRect().bottom - ta.getBoundingClientRect().top - parseFloat(getComputedStyle(box).paddingBottom);
    }
    ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight + 2, Math.max(160, room)) + "px";
  };
  ta.oninput = fit; fitTasks = fit;
  ta.onblur = () => saveTasks(ta.value.split("\n").map(x => x.trim()).filter(Boolean));
  box.replaceChildren(el("b", "hd", "tasks"), ta);
  setTimeout(fit, 0); setTimeout(fit, 150);
}
async function saveTasks(mine) {
  const t = data.tasks, personal = dash.mode === "personal", before = openTasks().map(x => x.text);
  if (before.join("\n") === mine.join("\n")) return;
  // keep the other mode's tasks as they are; rewrite this mode's
  const others = [];
  t.display.forEach((r, i) => { const v = String((r || [])[1] || "").trim(), tag = lc((r || [])[2]); if (i > 2 && v && ((tag === "personal") !== personal)) others.push([v, tag]); });
  const rows = mine.map(v => [v, personal ? "personal" : ""]).concat(others);
  const oldCount = t.display.filter((r, i) => i > 2 && String((r || [])[1] || "").trim()).length;
  while (rows.length < oldCount) rows.push(["", ""]);
  if (TEST) { rows.forEach((r, k) => { const i = 3 + k; t.display[i] = ["", r[0], r[1]]; t.raw[i] = ["", r[0], r[1]]; t.fmt[i] = []; }); return; }
  status("saving");
  try {
    const range = quote(t.name) + "!B4:C" + (3 + rows.length);
    await api(SHEETS + book.id + "/values/" + encodeURIComponent(range) + "?valueInputOption=RAW", { method: "PUT", body: JSON.stringify({ range, majorDimension: "ROWS", values: rows }) });
    await refreshTab(t); status("saved");
  } catch (e) { status(e.expired ? "signed out. sign in again to save." : e.message); }
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
function txMatches(f, tab) {
  const c = data.cols, q = lc(f.text);
  return data.rows.filter(r => !r.synthetic && (!f.from || (r.date >= f.from && r.date <= f.to)) && (!f.entities || f.entities.includes(r.entity)) && (!f.entity || r.entity === f.entity) && (!f.account || r.account === f.account)
    && (!f.category || r.category === f.category) && (!f.group || r.group === f.group) && (!f.notIn || !f.notIn.includes(r.category))
    && (f.only !== "wrong" || WRONG_ACCOUNT.includes(r.category)) && (f.only !== "receipt" || (receiptExpected(r) && !r.receipt))
    && (!f.supplier || supplier(r.merchant) === f.supplier)
    && (!f.rec || (f.rec === "missing" ? receiptExpected(r) && !r.receipt : f.rec === "linked" ? !!r.receipt : !receiptExpected(r) && !r.receipt))
    && (!q || (r.merchant + " " + lc((tab.display[r.i] || [])[c.reference]) + " " + r.category + " " + r.date).includes(q))).reverse();
}
/* the transactions behind anything you click on the dashboard, in a pop-up you can edit and copy from */
let txmDirty = false, moreModal = null;
function openTx(f, title) {
  const rg = range(), ents = scopeEntities(), tab = tabByName("transactions"), c = data.cols;
  const filt = Object.assign({}, TX_CLEAR, { entity: ents.length === 1 ? ents[0] : "", entities: ents.length > 1 ? ents : null, from: rg.from, to: rg.to }, f);
  $("#txmTitle").textContent = title; $("#txmCount").textContent = "";
  const show = () => txView({ head: $("#txmHead"), grid: $("#txmGrid"), scroller: $("#txmGrid").closest(".modal-body"), host: $("#txmMore"), tab, f: filt, rebuild: show, key: "modal" });
  $("#txModal").hidden = false; show();
  $("#txmOpen").onclick = () => { Object.assign(txFilter, TX_CLEAR, filt); closeTx(); showView("transactions"); };
  $("#txmCopy").onclick = () => {
    const list = txMatches(filt, tab);
    const rows = [["row", "date", "account", "entity", "merchant", "reference", "amount", "currency", "category"].join("\t")].concat(list.map(r => { const d = tab.display[r.i] || []; return [r.i + 1, r.date, r.account, r.entity, d[c.merchant] || "", d[c.reference] || "", d[c.amount] || "", r.cur, r.category].join("\t"); }));
    const txt = title + "\n" + rows.join("\n");
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => { $("#txmCopy").textContent = "copied"; setTimeout(() => ($("#txmCopy").textContent = "copy"), 1500); }, () => {});
  };
}
function closeTx() { $("#txModal").hidden = true; if (txObs.modal) txObs.modal.disconnect(); buildModel(); if (view === "dashboard") renderDashboard(); }
// on the sheet tabs the page fits the window exactly: the table scrolls inside its box and the watermark always shows
function fitSheet() {
  const sheet = !$("#viewSheet").hidden, sc = $("#sheetScroll");
  document.documentElement.classList.toggle("fit", sheet);
  if (!sheet) { sc.style.height = ""; return; }
  sc.style.height = "0px";
  // measured from the page column, not the whole page, so the side column beside it doesn't change the answer
  const mark = $(".mark"), views = $(".views"), main = $("main"), mh = mark ? mark.offsetHeight : 0;
  const used = views.getBoundingClientRect().bottom + scrollY + parseFloat(getComputedStyle(main).paddingBottom) + mh;
  sc.style.height = Math.max(200, Math.floor(sc.offsetHeight + innerHeight - used)) + "px";
}
addEventListener("resize", () => fitSheet());
function showView(name) {
  if (!["dashboard", "transactions"].includes(name) || (name === "transactions" && !tabByName("transactions"))) name = "dashboard";
  view = name;
  [...$("#tabs").children].forEach(b => b.setAttribute("aria-selected", b.dataset.view === name));
  $("#viewDashboard").hidden = name !== "dashboard";
  $("#viewSheet").hidden = name === "dashboard";
  if (name === "dashboard") renderDashboard(); else renderSheet(tabByName(name));
  // filings, needs attention and tasks show beside every page
  if (name !== "dashboard") { renderFilings(); renderTasks(); renderAttention(); fitTasks(); }
  fitSheet();
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
  if (txObs.sheet) { txObs.sheet.disconnect(); txObs.sheet = null; }
  if (!tab) return;
  const size = usedSize(tab), c0 = firstUsedCol(tab);
  if (tab.name.toLowerCase() === "transactions" && data.head >= 0) return renderTransactions(tab, c0, size.cols);
  grid.className = "grid sheet";
  const emptyCols = new Set(); for (let j = c0; j < size.cols; j++) { let any = false; for (let i = 0; i <= size.rows && !any; i++) any = ((tab.display[i] || [])[j] ?? "") !== ""; if (!any) emptyCols.add(j); }
  const body = el("tbody");
  for (let i = 0; i <= size.rows; i++) {
    const tr = el("tr"), kind = rowKind(tab, i, c0, size.cols);
    if (kind) tr.className = kind;
    // dots only run between values of the same table: columns left empty all the way down split tables apart
    const dotted = new Set(); let seg = [];
    const flush = () => { if (seg.length > 1) for (let j = seg[0]; j < seg[seg.length - 1]; j++) dotted.add(j); seg = []; };
    for (let j = c0; j < size.cols; j++) { if (emptyCols.has(j)) { flush(); continue; } if (((tab.display[i] || [])[j] ?? "") !== "") seg.push(j); }
    flush();
    for (let j = c0; j < size.cols; j++) { const td = cell(tab, i, j, { kind }); if (!dotted.has(j)) td.classList.add("nodots"); tr.append(td); }
    body.append(tr);
  }
  grid.append(body);
}
// the sheet's bold is read as the dashboard's hierarchy: a lone bold cell is a section title, a row of bold cells is a header of labels
function rowKind(tab, i, c0, cols) {
  const vals = [], f = tab.fmt[i] || [];
  for (let j = c0; j < cols; j++) { const v = (tab.display[i] || [])[j]; if (v !== "" && v != null) vals.push(j); }
  if (!vals.length) return "blank";
  const bold = vals.filter(j => (f[j] || {}).b);
  if (bold.length && bold.length === vals.length) return vals.some((j, k) => k && vals[k - 1] === j - 1) ? "labels" : "title";
  return "";
}
const NUMERIC = /^[(−-]?[£€$]?[\d,]+(\.\d+)?%?\)?$/;
function cell(tab, i, j, o = {}) {
  const td = el("td");
  const raw = ((tab.raw[i] || [])[j]); const disp = ((tab.display[i] || [])[j]);
  const f = (tab.fmt[i] || [])[j] || {};
  const isFormula = typeof raw === "string" && raw.startsWith("=");
  if (f.i) td.classList.add("i"); if (f.s) td.classList.add("s"); if (f.y) td.classList.add("y");
  const txt = disp == null ? "" : String(disp);
  if (o.right || (!o.kind && NUMERIC.test(txt.trim()) && !/^\d{4}$/.test(txt.trim()))) { td.classList.add("num"); if (/^[(−-]/.test(txt.trim())) td.classList.add("neg"); else if (o.colour && num(txt) > 0) td.classList.add("pos"); }
  const link = isFormula && /^=HYPERLINK\(\s*"([^"]+)"/i.exec(raw);
  if (link && /^https:\/\//.test(link[1])) { const a = el("a", null, disp || "link"); a.href = link[1]; a.target = "_blank"; a.rel = "noopener"; td.append(a); return td; }
  td.append(el("span", null, disp == null ? "" : String(disp)));
  if (isFormula) { td.classList.add("formula"); return td; }
  td.classList.add("edit");
  td.addEventListener("click", () => edit(td, tab, i, j));
  return td;
}
function edit(td, tab, i, j) {
  if (td.dataset.editing) return; td.dataset.editing = "1";
  const raw = (tab.raw[i] || [])[j], shown = (tab.display[i] || [])[j];
  const before = typeof raw === "string" && raw.startsWith("=") ? raw : shown; const input = el("input"); input.value = before == null ? "" : before;
  td.textContent = ""; td.append(input); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  let done = false;
  const finish = save => {
    if (done) return; done = true; delete td.dataset.editing;
    const v = input.value;
    const put = x => td.replaceChildren(el("span", null, x == null ? "" : String(x)));
    if (save && String(v) !== String(before == null ? "" : before)) { put(v); writeCell(tab, i, j, v).then(() => { buildModel(); if (view !== "dashboard") rerenderCellRow(tab); }); }
    else put((tab.display[i] || [])[j] || "");
  };
  input.addEventListener("keydown", e => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
  input.addEventListener("blur", () => finish(true));
}
function rerenderCellRow(tab) {
  const sc = $("#sheetScroll").scrollTop; renderSheet(tab); $("#sheetScroll").scrollTop = sc;
}

function renderTransactions(tab) {
  txView({ head: $("#sheetHead"), grid: $("#grid"), scroller: $("#sheetScroll"), host: $("#more"), tab, f: txFilter, rebuild: () => renderSheet(tab), key: "sheet" });
}
// the transactions view: a filter bar and the table under it. the transactions tab and every pop-up are this same view,
// each with its own filter; a pop-up is just the transactions tab with a filter already applied
const txObs = {};
function txView({ head, grid, scroller, host, tab, f, rebuild, key }) {
  const c = data.cols; head.innerHTML = ""; head.className = "sheet-head";
  grid.className = "grid tx";

  const search = el("input", "box"); search.type = "search"; search.placeholder = "search"; search.value = f.text;
  const mk = (label, values, key) => { const s = el("select", "box"); s.append(new Option(label, "")); values.forEach(v => s.append(new Option(v, v))); s.value = f[key] || ""; s.onchange = () => { f[key] = s.value; if (key === "entity") f.entities = null; draw(); }; return s; };
  const real = data.rows.filter(r => !r.synthetic), entities = [...new Set(real.map(r => r.entity))].sort(), accounts = [...new Set(real.map(r => r.account))].sort();
  const cats = [...new Set(data.cats.concat(data.rows.map(r => r.category)))].filter(Boolean).sort();
  const count = el("span", "count");
  // receipts: the ones still to reconcile, the ones linked, and the ones that don't need one
  const recSel = el("select", "box"); [["", "all receipts"], ["missing", "receipt missing"], ["linked", "receipt linked"], ["none", "no receipt needed"]].forEach(([v, l]) => recSel.append(new Option(l, v)));
  recSel.value = f.rec || ""; recSel.onchange = () => { f.rec = recSel.value; draw(); };
  head.append(search, mk("all entities", entities, "entity"), mk("all accounts", accounts, "account"), mk("all categories", cats, "category"), recSel);
  const chipRow = el("div", "chips");
  if (f.only) { const b = el("button", "box chip", f.only === "wrong" ? "paid from the wrong account" : "no receipt"); b.type = "button"; b.onclick = () => { f.only = null; rebuild(); }; chipRow.append(b); }
  if (f.group && !f.category) { const b = el("button", "box chip", "all " + f.group + "s"); b.type = "button"; b.onclick = () => { f.group = ""; rebuild(); }; chipRow.append(b); }
  if (f.from) { const b = el("button", "box chip", longDate(f.from) + " – " + longDate(f.to)); b.type = "button"; b.onclick = () => { f.from = f.to = ""; rebuild(); }; chipRow.append(b); }
  if (f.supplier) { const b = el("button", "box chip", f.supplier); b.type = "button"; b.onclick = () => { f.supplier = ""; rebuild(); }; chipRow.append(b); }
  if (f.notIn) { const b = el("button", "box chip", "everything else"); b.type = "button"; b.onclick = () => { f.notIn = null; rebuild(); }; chipRow.append(b); }
  head.append(count);
  let t; search.oninput = () => { clearTimeout(t); t = setTimeout(() => { f.text = search.value; draw(); }, 150); };

  // the columns: the optional ones are switched on and off from the columns menu, remembered between visits
  const ALL = txCols(c);
  const colBtn = el("button", "box cols icon"); colBtn.type = "button"; colBtn.title = "columns"; colBtn.setAttribute("aria-label", "columns");
  colBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="3.5" width="15" height="13"/><line x1="7.5" y1="3.5" x2="7.5" y2="16.5"/><line x1="12.5" y1="3.5" x2="12.5" y2="16.5"/></svg>';
  const menu = el("div", "colmenu"); menu.hidden = true; menu.append(el("i", "hd", "columns"));
  // every column is listed; the ones the table needs are ticked and greyed out, like shopify
  ALL.forEach(([n]) => {
    const optional = TX_OPTIONAL.includes(n), lab = el("label", optional ? null : "fixed"), cb = el("input"); cb.type = "checkbox"; cb.checked = !txHidden.has(n); cb.disabled = !optional;
    cb.onchange = () => { cb.checked ? txHidden.delete(n) : txHidden.add(n); try { localStorage.setItem(COLS_KEY, JSON.stringify([...txHidden])); } catch {} draw(); };
    lab.append(cb, " " + (n === "amount" ? "original amount" : n)); menu.append(lab);
  });
  colBtn.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; colBtn.setAttribute("aria-expanded", !menu.hidden); };
  head.onclick = e => { if (!menu.contains(e.target) && !colBtn.contains(e.target)) { menu.hidden = true; colBtn.setAttribute("aria-expanded", false); } };
  // export: the transactions as filtered, every column, as a csv file
  const exp = el("button", "box icon"); exp.type = "button"; exp.title = "export"; exp.setAttribute("aria-label", "export"); exp.innerHTML = EXPORT_ICON;
  exp.onclick = () => {
    const list = txMatches(f, tab), bal = runningBalance(f), q = v => { const x = v == null ? "" : String(v); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
    const lines = [["date", "account", "entity", "merchant", "reference", "amount", "currency", "usd", "balance", "category", "receipt"].join(",")]
      .concat(list.map(r => { const d = tab.display[r.i] || [], link = receiptLink((tab.raw[r.i] || [])[c.receipt], d[c.receipt]);
        return [r.date, r.account, r.entity, d[c.merchant], d[c.reference], r.amount.toFixed(2), r.cur, r.v.toFixed(2), bal.has(r.i) ? bal.get(r.i).toFixed(2) : "", r.category, link ? link.url : d[c.receipt] || ""].map(q).join(","); }));
    const a = el("a"); a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" })); a.download = "transactions " + iso(new Date()) + ".csv"; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  };
  const colWrap = el("span", "colwrap"); colWrap.append(colBtn, menu); head.append(exp, colWrap);
  head.prepend(count); head.classList.add("tx-head");
  // active filters sit on a line of their own under the bar, left-aligned, so the bar never wraps
  if (chipRow.children.length) head.append(chipRow);
  const fmt2 = v => (v < 0 ? "-" : "") + Math.abs(v).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const PAGE = 120;
  function draw() {
    const shownCols = ALL.filter(([n]) => !txHidden.has(n));
    grid.innerHTML = ""; host.innerHTML = ""; if (txObs[key]) txObs[key].disconnect();
    const list = txMatches(f, tab);
    count.textContent = list.length.toLocaleString("en-GB") + (list.length === 1 ? " transaction" : " transactions");
    txObs[key] = txTable({ grid, scroller, host, tab, list, shownCols, bal: runningBalance(f), cats, entities, accounts });
  }
  draw();
}
// the transactions table, shared by the transactions tab and the pop-up: a month column on the left with its totals
// pinned beside its rows, the chosen columns, and rows loaded a page at a time as you scroll
const TX_PAGE = 120, TX_FMT2 = v => (v < 0 ? "-" : "") + Math.abs(v).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function txCols(c) { return [["date", c.date, "date"], ["account", c.account, "pick"], ["entity", c.entity, "pick"], ["merchant", c.merchant, "text"], ["reference", c.reference, "text"], ["amount", c.amount, "amt"], ["usd", -1, "num"], ["balance", -2, "num"], ["receipt", c.receipt, "receipt"], ["category", c.category, "cat"]]; }
function txTable({ grid, scroller, host, tab, list, shownCols, bal, cats, entities, accounts }) {
  grid.className = "grid tx"; let obs = null;
    const cg = el("colgroup"); cg.append(el("col", "c-gut")); shownCols.forEach(([n]) => cg.append(el("col", "c-" + n))); grid.append(cg);
  const thead = el("thead"), tr = el("tr"); tr.append(el("th", "gut"));
  shownCols.forEach(([n, , k]) => tr.append(el("th", "c-" + n + (k === "num" || k === "amt" ? " num" : ""), n === "amount" ? "original" : n)));
  thead.append(tr); grid.append(thead);
  // totals for each month and year of the rows shown, in one pass; the list runs newest first
  const sums = new Map();
  list.forEach(r => [r.date.slice(0, 7), r.date.slice(0, 4)].forEach(k => {
    const t = sums.get(k) || { inc: 0, cost: 0, end: null, start: null };
    if (isIncome(r)) t.inc += r.v; if (isCost(r)) t.cost += r.v;
    if (bal.has(r.i)) { if (t.end == null) t.end = bal.get(r.i); t.start = bal.get(r.i) - r.v; }
    sums.set(k, t);
  }));
  const body = el("tbody"); grid.append(body);
  let shown = 0, lastM = "", lastY = "", gut = null, open = [];
  const figs = (box, k) => { const t = sums.get(k);
    box.append(lead("income", [el("span", t.inc ? "g" : null, money(t.inc))], { italic: true }), lead("costs", [el("span", t.cost ? "r" : null, money(t.cost))], { italic: true }));
    if (t.start != null) box.append(lead("start", money(t.start), { italic: true }), lead("end", money(t.end), { italic: true })); };
  const page = () => {
    const frag = document.createDocumentFragment();
    list.slice(shown, shown + TX_PAGE).forEach(r => {
      const row = txRow(tab, r, shownCols, cats, entities, accounts, bal, TX_FMT2), m = r.date.slice(0, 7), y = r.date.slice(0, 4);
      if (m !== lastM) {
        // a blank row between months, two between years
        if (lastM) { const gap = el("tr", "gaprow" + (y !== lastY ? " year" : "")), td = el("td"); td.colSpan = shownCols.length + 1; gap.append(td); frag.append(gap); }
        // the month's label and totals sit at the left beside its rows, pinned while you scroll through it
        gut = el("td", "gut"); gut.rowSpan = 1;
        const pin = el("div", "pin"), box = el("div", "pinbox");
        if (y !== lastY) { box.append(el("b", "hd", y)); figs(box, y); box.append(el("div", "gap")); lastY = y; }
        box.append(el("b", "hd", MONTHS[+m.slice(5) - 1] + " " + y)); figs(box, m);
        pin.append(box); gut.append(pin); row.prepend(gut); lastM = m; open.push(gut);
      } else gut.rowSpan++;
      gut._last = row;
      frag.append(row);
    });
    body.append(frag); shown += TX_PAGE;
    // a month with only a row or two is shorter than its label and totals: pad it with an empty row so nothing is cut off
    // (the month still being loaded is left until its last rows arrive)
    const done = shown >= list.length ? open : open.slice(0, -1);
    done.forEach(g => { const short = g.firstChild.firstChild.offsetHeight - g.offsetHeight;
      if (short > 0) { const f = el("tr", "filler"), td = el("td"); td.colSpan = shownCols.length; td.style.height = short + "px"; f.append(td); g._last.after(f); g.rowSpan++; } });
    open = open.slice(done.length);
    if (shown >= list.length && obs) obs.disconnect();
  };
  page();
  grid.style.setProperty("--th-h", thead.offsetHeight + "px");
  const sentinel = el("div"); sentinel.style.height = "1px"; host.append(sentinel);
  obs = new IntersectionObserver(es => { if (es[0].isIntersecting && shown < list.length) page(); }, { root: scroller, rootMargin: "600px" });
  obs.observe(sentinel);
  return obs;
}
// the balance after each transaction, across the accounts and entities in view (not narrowed by search or category),
// each currency kept apart and converted at that month's rate, the same way the dashboard does it
function runningBalance(f) {
  const out = new Map(), byCur = {};
  const rs = data.rows.filter(r => !r.synthetic && (!f.entities || f.entities.includes(r.entity)) && (!f.entity || r.entity === f.entity) && (!f.account || r.account === f.account))
    .sort((p, q) => p.date < q.date ? -1 : p.date > q.date ? 1 : p.i - q.i);
  const now = iso(new Date()).slice(0, 7);
  rs.forEach(r => { byCur[r.cur] = (byCur[r.cur] || 0) + r.amount; const m = r.date.slice(0, 7) > now ? now : r.date.slice(0, 7);
    out.set(r.i, Object.entries(byCur).reduce((a, [c, v]) => a + v * rate(m, c || "EUR", dash.cur), 0)); });
  return out;
}

// one transaction row: dropdowns for account, entity and category, links for receipts, a faint flag where a receipt is expected but missing
const NO_RECEIPT_NEEDED = ["payment fees", "bank fees", "transfer fees"];
function receiptExpected(r) { return (r.entity !== "personal" && r.group === "cost" && !NO_RECEIPT_NEEDED.includes(r.category)) || r.category === "business costs paid personally"; }
function receiptLink(raw, shown) {
  const m = /^=HYPERLINK\(\s*"([^"]+)"/i.exec(String(raw || "")), url = m ? m[1] : /^https:\/\//.test(String(shown || raw || "")) ? String(shown || raw) : "";
  if (!url || !/^https:\/\//.test(url)) return null;
  return { url, label: /mail\.google/.test(url) ? "gmail" : /drive\.google|docs\.google/.test(url) ? "drive" : "link" };
}
const CAT_HUE = { "client work": 135, program: 150, affiliate: 165, "other income": 120, income: 135, salary: 135, dividends: 160, team: 210, software: 230, "ads & marketing": 260, "professional fees": 280, training: 300, "travel & meals": 25, travel: 25, "eating out": 35, groceries: 90, equipment: 190, rent: 0, bills: 15, transport: 45, shopping: 320, entertainment: 340, lifestyle: 300, "payment fees": 50, "bank fees": 50, "transfer fees": 50, "director pay": 270, "director's loan": 270, dividends_: 0, intercompany: 200, "own transfer": 200, transfers: 200, "opening balance": 200, "corporation tax": 10, vat: 10, paye: 10, check: 55, "business costs paid personally": 285, "other costs": 40, other: 40 };
// a value in a cell sits in a span over the row's dotted line, which it hides behind itself
function txt(cls, text) { const td = el("td", cls); td.append(el("span", null, text == null ? "" : String(text))); return td; }
// account, entity and category show as text; the dropdown is only built when clicked, which keeps long lists fast
// category choices for a row: only that side's categories (business or personal), under the group headings from the sheet
const PERSONAL_ONLY = ["rent", "bills", "groceries", "eating out", "transport", "travel", "shopping", "entertainment", "lifestyle", "salary", "transfers", "business costs paid personally", "income"];
const BUSINESS_ONLY = ["client work", "program", "affiliate", "team", "software", "ads & marketing", "professional fees", "training", "equipment", "travel & meals", "payment fees", "bank fees", "transfer fees", "director pay", "director's loan", "intercompany", "own transfer", "corporation tax", "vat", "paye", "other costs", "other income"];
const GROUP_LABEL = { income: "income", cost: "costs", director: "director", transfer: "transfers", tax: "tax" };
function catOptions(r, cats) {
  const personal = r.entity === "personal";
  const list = cats.filter(c => c !== "check" && (personal ? !BUSINESS_ONLY.includes(c) : !PERSONAL_ONLY.includes(c)));
  if (!list.includes(r.category)) list.push(r.category);
  if (!list.includes("to categorise")) list.push("to categorise");
  const groups = new Map();
  list.forEach(c => { const g = c === "to categorise" || c === "check" ? "to sort" : GROUP_LABEL[data.catGroup[c]] || "other"; groups.set(g, (groups.get(g) || []).concat([c])); });
  const order = ["to sort", "income", "costs", "director", "tax", "transfers", "other"];
  return [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([g, cs]) => [g, cs.sort()]);
}
function pickCell(td, value, label, opts, onpick, tag) {
  const show = v => { td.replaceChildren(); const sp = el("span", tag ? "tag" : "pick", label(v)); if (tag) sp.style.setProperty("--h", CAT_HUE[v] != null ? CAT_HUE[v] : 40); td.append(sp); };
  show(value);
  td.onclick = () => {
    if (td.querySelector("select")) return;
    const sl = el("select", tag ? "cat tag" : "cat");
    const list = typeof opts === "function" ? opts() : opts;
    list.forEach(v => { if (Array.isArray(v)) { const og = el("optgroup"); og.label = v[0]; v[1].forEach(x => og.append(new Option(label(x), x))); sl.append(og); } else sl.append(new Option(label(v), v)); });
    sl.value = value;
    if (tag) sl.style.setProperty("--h", CAT_HUE[value] != null ? CAT_HUE[value] : 40);
    td.replaceChildren(sl); sl.focus(); try { sl.showPicker(); } catch {}
    sl.onchange = () => { value = sl.value; onpick(value); show(value); };
    sl.onblur = () => show(value);
  };
}
function txRow(tab, r, cols, cats, entities, accounts, bal, fmt2) {
  const row = el("tr"), d = tab.display[r.i] || [], raw = tab.raw[r.i] || [];
  cols.forEach(([name, j, kind]) => {
    let td;
    if (kind === "pick" || kind === "cat") {
      td = el("td", "c-" + name);
      const write = v => writeCell(tab, r.i, j, v).then(() => buildModel());
      if (kind === "cat") pickCell(td, r.category, catName, () => catOptions(r, cats), write, true);
      else pickCell(td, name === "entity" ? r.entity : r.account, v => v, name === "entity" ? entities : accounts, write);
    } else if (name === "usd") td = txt("c-usd num " + (r.v < 0 ? "neg" : "pos"), fmt2(r.v));
    else if (name === "balance") td = txt("c-balance num", bal.has(r.i) ? fmt2(bal.get(r.i)) : "");
    else if (kind === "amt") {
      td = txt("c-amount num edit " + (r.amount < 0 ? "neg" : "pos"), (r.amount < 0 ? "-" : "") + (SYMBOL[r.cur] || r.cur + " ") + Math.abs(r.amount).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
      td.onclick = () => edit(td, tab, r.i, j);
    } else if (kind === "receipt") {
      const link = receiptLink(raw[j], d[j]); td = el("td", "c-receipt");
      if (link) { const a = el("a", null, link.label); a.href = link.url; a.target = "_blank"; a.rel = "noopener"; td.append(a); }
      else { td.append(el("span", null, d[j] || "")); td.classList.add("edit"); if (!d[j] && receiptExpected(r)) row.classList.add("need"); td.onclick = () => edit(td, tab, r.i, j); }
    } else {
      td = txt("c-" + name + " edit", d[j] || ""); td.onclick = () => edit(td, tab, r.i, j);
      if (name === "merchant" || name === "reference") td.title = d[j] || "";
    }
    row.append(td);
  });
  return row;
}

/* ---------- shell ---------- */
function start() {
  buildModel();
  $("#gate").hidden = true; $("#app").hidden = false; $("#top").hidden = false;
  document.title = book.title; $("#brandName").textContent = book.title;
  const tabs = $("#tabs"); tabs.innerHTML = "";
  ["dashboard", "transactions"].filter(n => n === "dashboard" || tabByName(n)).forEach(n => {
    const b = el("button", null, n); b.type = "button"; b.setAttribute("role", "tab"); b.dataset.view = n;
    b.onclick = () => { if (n === "transactions") Object.assign(txFilter, TX_CLEAR, modeFilter()); showView(n); };
    tabs.append(b);
  });
  $("#openInSheets").href = "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(book.id) + "/edit";
  try { const v = JSON.parse(localStorage.getItem(VIEW_KEY)) || {}; ["mode", "co", "period"].forEach(k => { if (v[k]) dash[k] = v[k]; }); } catch {}
  if (!PERIODS.some(([k]) => k === dash.period)) dash.period = "fy";
  renderMode();
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
  auth.token = null; savePass(); book = null; data = null; setLastFile(null); showGate();
});
$("#pdfButton").addEventListener("click", saveStatements);
$("#txmClose").addEventListener("click", closeTx);
$("#txModal").addEventListener("click", e => { if (e.target.id === "txModal") closeTx(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#txModal").hidden) closeTx(); });
let resizeTimer = null;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (data && view === "dashboard") renderDashboard(); }, 150); });
document.addEventListener("visibilitychange", () => { if (!document.hidden && book && !TEST && !signedIn()) status("signed out. sign out from the menu, then sign in again."); });

if (TEST) { book = TEST; start(); }
else {
  loadScript("https://accounts.google.com/gsi/client").catch(() => gateError("google sign-in couldn't load. check your connection."));
  loadPass();
  const f = lastFile(); if (signedIn() && f) { $("#gate").hidden = true; loadBook(f.id); }
}
