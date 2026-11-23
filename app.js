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
const WRONG_ACCOUNT = ["director's loan", "business costs paid personally"];
const SYMBOL = { GBP: "£", EUR: "€", USD: "$" };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

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
const TX_CLEAR = { text: "", entity: "", entities: null, category: "", account: "", group: "", only: null, from: "", to: "" };
const txFilter = Object.assign({}, TX_CLEAR);
const FOLD_KEY = "ca-finance-folded";
const txFolded = new Set((() => { try { return JSON.parse(localStorage.getItem(FOLD_KEY)) || null; } catch { return null; } })() || ["account", "entity", "reference", "amount"]);

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
  const inv = tabByName("investments"), invRows = inv ? inv.display : [], invVal = k => { const i = findRow(invRows, [k]); return i < 0 ? "" : String((invRows[i] || [])[(invRows[i] || []).map(lc).indexOf(k) + 1] || ""); };
  const investments = inv ? {
    monthly: num(invVal("invest per month")), starts: invVal("starts").slice(0, 10), years: num(invVal("years")) || 5,
    watch: block(invRows, ["name", "ticker", "price now", "today"]).map(([n, t, p, d]) => ({ name: lc(n), ticker: String(t || ""), price: lc(p) === "private" ? null : num(p), priv: lc(p) === "private", today: String(d || "").trim() ? parseFloat(d) / 100 : null })),
    holdings: block(invRows, ["date", "ticker", "shares", "paid", "price now", "value now"]).filter(r => lc(r[1])).map(([d, t, sh, pd, pr, v]) => ({ date: String(d).slice(0, 10), ticker: String(t).toUpperCase(), shares: num(sh), paid: num(pd), price: num(pr), value: num(v) || num(pd) }))
  } : null;
  data = { rows, cols, head, catGroup, cats: Object.keys(catGroup), ent, tasks, filings, fx, fxCache: {}, investments };
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
  const ft = [...$("#tabs").children].find(b => lc(b.dataset.view) === "forecast"); if (ft) ft.textContent = dash.mode === "personal" ? "budget" : "forecast";
  const it = [...$("#tabs").children].find(b => lc(b.dataset.view) === "investments"); if (it) it.hidden = dash.mode !== "personal";
  const mp = $("#modePick"); mp.innerHTML = "";
  [["business", "business"], ["personal", "personal"]].forEach(([k, t]) => {
    const b = el("button", null, t); b.type = "button"; b.setAttribute("aria-pressed", dash.mode === k);
    b.onclick = () => {
      if (dash.mode === k) return;
      dash.mode = k; dash.fy = null; dash.month = null; dash.flow = dash.acct = null;
      if (view === "dashboard") renderDashboard();
      else { renderMode(); if (view.toLowerCase() === "transactions") Object.assign(txFilter, TX_CLEAR, modeFilter()); if (view.toLowerCase() === "forecast") fc.pick = null; showView(view); }
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
  yp.closest(".step").classList.toggle("on", dash.period === "fy" && !dash.month);
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
  renderInvestments();
  renderTasks();
  renderAttention();
}

function renderSummary(rg) {
  const f = figures(rg), p = rg.kind === "all" ? {} : figures(prevRange(rg)), personal = dash.scope === "personal";
  const than = { year: "last year", "3m": "the 3 months before", month: "the month before" }[rg.kind];
  const change = (a, b) => { if (rg.kind === "all") return "since " + longDate(rg.from); if (!b) return "nothing to compare"; const c = (Math.abs(a) - Math.abs(b)) / Math.abs(b); return pct(Math.abs(c)) + (c >= 0 ? " higher than " : " lower than ") + than; };
  const cols = [
    [words().rev, f.income, "g", change(f.income, p.income)],
    [words().cost, -f.costs, "r", change(f.costs, p.costs)],
    [words().pbt, f.profit, f.profit < 0 ? "r" : "g", f.income > 0 && Math.abs(f.profit / f.income) <= 5 ? pct(f.profit / f.income) + " " + words().of : ""]
  ];
  const bud = personal && monthlyBudget();
  if (bud) {
    const planned = bud.spend * monthsElapsed(rg), over = -f.costs - planned;
    cols.push(["budget", planned, "", [el("span", over > 0.5 ? "r" : "g", over > 0.5 ? "over by " + money(over) : money(-over) + " under")]]);
  }
  if (!personal) cols.push(["tax due (estimate)", f.tax, "r", f.taxPaid > 0.5 ? money(f.taxPaid) + " paid" : "nothing paid yet"]);
  cols.push(["cash", f.cash, f.cash < 0 ? "r" : "g", rg.kind === "all" ? "today" : change(f.cash, p.cash)]);
  const bi = cols.findIndex(c => c[0] === "budget"); if (bi > 2) cols.splice(2, 0, cols.splice(bi, 1)[0]);
  if (personal) {
    // net worth: your cash, plus what the companies owe you on your director's loan (minus what you owe them)
    const loan = c => balance(c, r => ["director's loan", "business costs paid personally"].includes(r.category), ["ie ltd", "uk ltd", "personal"]);
    const nw = f.cash + loan(rg.to) + investValue(), nwp = rg.kind === "all" ? null : (p.cash || 0) + loan(prevRange(rg).to) + investedBy(prevRange(rg).to);
    cols.push(["net worth", nw, nw < 0 ? "r" : "g", nwp == null ? "cash, investments and director's loan" : change(nw, nwp)]);
  }
  $("#summary").replaceChildren(...cols.map(([label, v, cls, note]) => { const d = el("div", "fig"), n = el("span"); if (Array.isArray(note)) n.append(...note); else n.textContent = note; d.append(el("i", null, label), el("span", cls || null, money(v)), n); return d; }));
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
let subGroups = {};
function renderMonthChart(rg) {
  const host = $("#monthChart"); host.className = "chart";
  const today = iso(new Date()), win = chartWindow(), start = win.start, N = win.n;
  const series = [];
  for (let k = 0; k < N; k++) {
    const m = addMonths(start, k), x = { from: iso(m), to: iso(monthEnd(m)) }, rows = sel(x);
    series.push({ m: iso(m).slice(0, 7), mi: m.getMonth(), label: MONTHS[m.getMonth()], started: x.from <= today, inc: total(rows.filter(isIncome)), cost: -total(rows.filter(isCost)) });
  }
  const bud = dash.scope === "personal" ? monthlyBudget() : null;
  const max = niceMax(Math.max(1, bud ? bud.spend : 0, ...series.map(s => Math.max(s.inc, s.cost))));
  const chart = el("div");
  host.replaceChildren(chart);
  const fyStart = iso(start), fyEnd = iso(monthEnd(addMonths(start, N - 1))), fyStartMonth = scopeYe() % 12;
  const dated = upcomingFilings();
  const laterGroups = dated.filter(g => g.when > fyEnd), padR = 12;
  svgBox(chart, 250, Wd => {
    const L = 40, base = 190, y = v => base - v / max * 180, slot = (Wd - L - padR) / N, many = N > 18; let s = "";
    [0, 0.25, 0.5, 0.75, 1].forEach(t => { const v = max * t; s += '<line x1="' + L + '" x2="' + (Wd - padR) + '" y1="' + y(v) + '" y2="' + y(v) + '" style="stroke:' + (t ? "var(--grid)" : "currentColor") + '"/><text x="0" y="' + (y(v) + 5) + '" ' + F + ">" + (t ? short(v) : "0") + "</text>"; });
    series.forEach((d, k) => {
      const x = L + k * slot + slot * 0.14, bw = slot * 0.34, on = d.m >= rg.from.slice(0, 7) && d.m <= rg.to.slice(0, 7);
      s += '<g opacity="' + (on ? 1 : 0.3) + '"><rect x="' + x + '" y="' + y(d.inc) + '" width="' + bw + '" height="' + (base - y(d.inc)) + '" fill="' + GREEN + '"/>'
        + '<rect x="' + (x + bw + 2) + '" y="' + y(d.cost) + '" width="' + bw + '" height="' + (base - y(d.cost)) + '" fill="' + RED + '"/></g>'
        + (many ? (d.mi === 0 ? '<text x="' + (L + k * slot) + '" y="' + (base + 20) + '" ' + F + ">" + d.m.slice(0, 4) + "</text>" : "") : '<text x="' + x + '" y="' + (base + 20) + '" ' + F + ">" + (slot < 44 ? d.label[0] : d.label) + "</text>");
      // a dotted line where each financial year starts
      if (k && d.mi === fyStartMonth) { const lx = L + k * slot; s += '<line x1="' + lx + '" x2="' + lx + '" y1="4" y2="' + base + '" style="stroke:var(--fyline)" stroke-dasharray="2 3"/><text x="' + (lx + 4) + '" y="14" font-size="14" font-family="PT Sans, Arial, sans-serif" style="fill:var(--grey)" font-style="italic">' + fyLabel(new Date(d.m + "-01T00:00:00"), scopeYe()) + "</text>"; }
      if (bud && slot >= 44 && d.started) { const u = bud.spend - d.cost; s += '<text x="' + x + '" y="' + (base + 40) + '" font-size="14" font-family="PT Sans, Arial, sans-serif" style="fill:' + (u < 0 ? RTEXT : GTEXT) + '">' + (u < 0 ? "+" : "−") + short(Math.abs(u)) + "</text>"; }
      else if (slot >= 44 && d.started && (d.inc || d.cost)) { const n = d.inc - d.cost; s += '<text x="' + x + '" y="' + (base + 40) + '" font-size="14" font-family="PT Sans, Arial, sans-serif" style="fill:' + (n < 0 ? RTEXT : GTEXT) + '">' + (n < 0 ? "" : "+") + short(n) + "</text>"; }
      s += '<rect class="hit" x="' + (L + k * slot) + '" y="0" width="' + slot + '" height="245" fill="transparent" data-month="' + d.m + '" data-tip="' + esc(d.label + " " + d.m.slice(0, 4) + "|" + words().rev + " " + money(d.inc) + "|" + words().cost + " " + money(d.cost) + "|" + (d.inc - d.cost < 0 ? (dash.scope === "personal" ? "short " : "loss ") : words().keep + " ") + money(Math.abs(d.inc - d.cost)) + (bud ? "|budget " + money(bud.spend) + ", " + (d.cost > bud.spend ? "over by " + money(d.cost - bud.spend) : money(bud.spend - d.cost) + " under") : "")) + '"/>';
    });
    // your monthly spending budget as a dashed line across the chart
    if (bud) s += '<line x1="' + L + '" x2="' + (Wd - padR) + '" y1="' + y(bud.spend) + '" y2="' + y(bud.spend) + '" style="stroke:var(--rtext)" stroke-dasharray="5 4" stroke-width="1.5"/>';
    // submissions: a dotted line with a numbered ball on top, at the start of the month they're due in;
    // anything after this period gathers at the very end of the axis. every ball is the same size
    const tipText = gs => gs.map(g => g.tip.split("|").filter(Boolean).join("\n")).join("\n\n");
    const marker = (x, gs, key) => {
      const n = gs.reduce((a, g) => a + g.items.length, 0);
      return '<g class="sub hit" data-key="' + key + '"><title>' + esc(tipText(gs)) + '</title>'
        + '<line x1="' + x + '" x2="' + x + '" y1="21" y2="' + base + '" stroke="currentColor" stroke-dasharray="2 3" pointer-events="none"/>'
        + '<circle cx="' + x + '" cy="11" r="10" style="fill:var(--card)" stroke="currentColor" stroke-width="1.5"/>'
        + '<text x="' + x + '" y="15.5" font-size="12" text-anchor="middle" font-family="PT Sans, Arial, sans-serif" fill="currentColor" pointer-events="none">' + n + "</text></g>";
    };
    const byMonth = new Map();
    dated.filter(g => g.when >= fyStart && g.when <= fyEnd).forEach(g => { const m = g.when.slice(0, 7); byMonth.set(m, (byMonth.get(m) || []).concat([g])); });
    subGroups = {};
    byMonth.forEach((gs, m) => { const k = (+m.slice(0, 4) - start.getFullYear()) * 12 + (+m.slice(5) - 1) - start.getMonth(); subGroups[m] = gs; s += marker(L + k * slot, gs, m); });
    if (laterGroups.length) { subGroups.later = laterGroups; s += marker(L + N * slot, laterGroups, "later"); }
    return s;
  });
  const lg = el("div", "legend"); lg.innerHTML = '<span><span class="sw" style="background:' + GREEN + '"></span>' + words().rev + '</span><span><span class="sw" style="background:' + RED + '"></span>' + words().cost + "</span>";
  if (bud) lg.insertAdjacentHTML("beforeend", '<span><span class="dash-key"></span>budget ' + esc(money(bud.spend)) + " a month</span>");
  if (dated.length) {
    lg.insertAdjacentHTML("beforeend", '<span><span class="dot"></span>submit</span>');
  }
  lg.insertAdjacentHTML("beforeend", '<span class="range">' + esc(longDate(rg.from) + " – " + longDate(rg.to)) + "</span>");
  host.append(lg);
  host.querySelectorAll("g.sub").forEach(g => g.addEventListener("click", e => {
    e.stopPropagation();
    const k = g.dataset.key, gs = subGroups[k] || [];
    dash.filingsPick = { label: k === "later" ? "after " + longDate(fyEnd) : MONTHS[+k.slice(5) - 1] + " " + k.slice(0, 4), names: gs.flatMap(x => x.items.map(i => i.name)) };
    renderFilings();
  }));
  host.querySelectorAll("rect.hit").forEach(b => b.addEventListener("click", () => { dash.month = dash.month === b.dataset.month ? null : b.dataset.month; renderDashboard(); }));
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
    if (!s) { const top = steps.slice(0, 5), r = steps.slice(5).reduce((a, c) => a + c.v, 0); steps = r < -0.5 ? top.concat([{ label: "everything else", v: r }]) : top; }
    title = s ? s.label : w.allRev;
    items = [{ label: s ? (personal ? w.keep : "margin") : w.keep, v: Math.max(0, keepV), keep: true, value: [el("span", keepV < 0 ? "r" : "g", money(keepV)), document.createTextNode(pctOf(keepV, v))] }]
      .concat(steps.map(st => ({ label: catName(st.label), v: -st.v, value: [el("span", "r", money(st.v)), document.createTextNode(pctOf(-st.v, v))], onclick: catClick(st.label) })));
    items.total = { label: w.rev, v };
  } else {
    kind = "cost";
    const pick = f.key ? costRows.filter(r => r.category === f.key) : costRows;
    const parts = (f.key ? groupBy(pick, r => supplier(r.merchant)) : cats.slice()).filter(p => p.v < -0.5).sort((a, b) => a.v - b.v);
    const shown = parts.slice(0, 6), others = parts.slice(6);
    if (others.length) shown.push({ label: others.length + " others", v: others.reduce((a, p) => a + p.v, 0), others: true });
    const sum = -shown.reduce((a, p) => a + p.v, 0);
    title = f.key ? catName(f.key) : w.allCost;
    items = shown.map(it => ({ label: f.key ? it.label : catName(it.label), v: -it.v, value: money(-it.v) + pctOf(-it.v, sum),
      onclick: it.others ? () => openTx(f.key ? { category: f.key, notIn: null } : { group: "cost" }, f.key ? catName(f.key) : "all costs") : f.key ? () => openTx({ category: f.key, text: it.label }, it.label) : () => go("cost", it.label) }));
    items.total = { label: f.key ? catName(f.key) : w.allCost, v: sum };
  }
  let cost = 0; items.forEach(it => { it.c = it.keep ? GREEN : BAR_REDS[Math.min(cost++, 5)]; });

  detail.replaceChildren(el("i", "mt", title), splitBar(items, rg));
  if (!items.length) detail.append(el("p", "empty", "nothing in this period"));
}

function splitBar(items, rg) {
  const wrap = el("div"), box = el("div", "chart"), key = el("div");
  const whole = items.reduce((a, p) => a + Math.max(0, p.v), 0) || 1;
  wrap.append(box, key);
  setTimeout(() => { svgBox(box, 40, W => {
    let x = 0, out = "";
    items.forEach((p, k) => {
      const w = Math.max(0, p.v) / whole * W; if (w <= 0) return;
      const t = pct(p.v / whole), fs = Math.max(7, Math.min(14, (w - 4) / (t.length * 0.56)));
      out += '<g class="seg-part' + (p.onclick ? " hit" : "") + '" data-k="' + k + '" data-tip="' + esc(p.label + "|" + money(p.v) + "|" + t) + '"><rect x="' + x + '" y="0" width="' + w + '" height="32" fill="' + p.c + '" style="stroke:var(--card)" stroke-width="1"/>'
        + '<text x="' + (w > 44 ? x + 8 : x + w / 2) + '" y="' + (16 + fs * 0.35) + '" font-size="' + fs.toFixed(1) + '" font-family="PT Sans, Arial, sans-serif" fill="#1a1917" text-anchor="' + (w > 44 ? "start" : "middle") + '" pointer-events="none">' + t + "</text></g>";
      x += w;
    });
    return out;
  }); box.querySelectorAll(".seg-part").forEach(g => { const it = items[g.dataset.k]; if (it.onclick) g.addEventListener("click", it.onclick); }); }, 0);
  if (items.total) key.append(lead(items.total.label, money(items.total.v)));
  items.forEach(it => key.append(lead(it.label, it.value || money(it.v), { swatch: it.c, onclick: it.onclick })));
  if (rg.months > 1) key.append(lead("per month", money((items.total ? items.total.v : whole) / monthsElapsed(rg)), { italic: true, cls: "total" }));
  return wrap;
}

function renderCash(rg) {
  const list = $("#cashList"), detail = $("#cashDetail"), to = rg.to;
  const accounts = [...new Set(data.rows.filter(r => scopeEntities().includes(r.entity)).map(r => r.account))];
  const items = accounts.map(a => ({ label: a, v: balance(to, r => r.account === a) })).filter(i => Math.abs(i.v) >= 0.5).sort((a, b) => b.v - a.v);
  if (dash.acct && !items.find(i => i.label === dash.acct)) dash.acct = null;
  list.replaceChildren(el("i", "mt", "account"));
  list.append(lead("all accounts", money(balance(to)), { sel: !dash.acct, onclick: () => { dash.acct = null; renderCash(rg); } }));
  items.forEach(i => list.append(lead(i.label, money(i.v), { sel: i.label === dash.acct, onclick: () => { dash.acct = i.label; renderCash(rg); } })));

  const start = new Date(dash.fy + "T00:00:00"), today = iso(new Date()), pts = [];
  for (let k = 0; k < 12; k++) { const m = monthEnd(addMonths(start, k)), d = iso(m); pts.push({ label: MONTHS[m.getMonth()], v: d.slice(0, 7) <= today.slice(0, 7) ? balance(d < today ? d : today, dash.acct ? r => r.account === dash.acct : null) : null }); }
  const box = el("div", "chart");
  detail.replaceChildren(el("i", "mt", dash.acct || "all accounts"), box);
  const known = pts.filter(p => p.v != null).map(p => p.v);
  const hi = niceMax(Math.max(1, ...known)), lo = Math.min(0, ...known) < 0 ? -niceMax(-Math.min(0, ...known)) : 0;
  svgBox(box, 200, W => {
    const L = 44, T = 10, B = 170, y = v => B - (v - lo) / (hi - lo) * (B - T), slot = (W - L - 20) / 11; let s = "";
    const ticks = lo < 0 ? [lo, 0, hi] : [0, hi * 0.25, hi * 0.5, hi * 0.75, hi];
    ticks.forEach(v => { s += '<line x1="' + L + '" x2="' + W + '" y1="' + y(v) + '" y2="' + y(v) + '" style="stroke:' + (v === 0 ? "currentColor" : "var(--grid)") + '"/><text x="0" y="' + (y(v) + 5) + '" ' + F + ">" + (v ? short(v) : "0") + "</text>"; });
    const line = pts.map((p, k) => p.v == null ? null : (L + k * slot).toFixed(1) + "," + y(p.v).toFixed(1)).filter(Boolean);
    if (line.length > 1) s += '<polyline points="' + line.join(" ") + '" fill="none" stroke="' + GREEN + '" stroke-width="2"/>';
    pts.forEach((p, k) => {
      s += '<text x="' + (L + k * slot) + '" y="' + (B + 22) + '" ' + F + ' text-anchor="middle">' + p.label + "</text>";
      if (p.v != null) s += '<rect x="' + (L + k * slot - slot / 2) + '" y="0" width="' + slot + '" height="' + B + '" fill="transparent" data-tip="' + esc(p.label + "|" + money(p.v)) + '"/>';
    });
    return s;
  });
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
    g.tip = g.items.map(i => { const e = filingEstimate(i); return i.name + " (" + i.who + ")|" + submitText(i) + (i.deadline ? "|due " + longDate(i.deadline) : "") + (e != null && e > 0.5 ? "|about " + money(e) + " tax" : "") + (i.notes ? "|" + i.notes : ""); }).join("| |");
  });
  return gs;
}
// filings: only what still needs doing for this period or earlier. business and personal under italic headings,
// the current mode's first. statuses are changed in the sheet, not here. clicking a filing opens its row on the filings tab
function submitText(f, today = iso(new Date())) { const d = f.target || f.deadline; return !d ? "" : d < today ? "submit now" : "submit " + longDate(d); }
function filingYear(f) { return +((/(\d{4})/.exec(f.name) || [])[1]) || 0; }
function filingLive(f, today = iso(new Date())) { return f.status !== "done" && f.status !== "filed, to confirm" && filingYear(f) <= +today.slice(0, 4); }
function renderFilings() {
  const box = $("#filingsBox"), today = iso(new Date()), pick = dash.filingsPick, y = today.slice(0, 4);
  box.replaceChildren(el("b", "hd", "filings"));
  if (pick) { const chip = el("button", "box chip", pick.label); chip.type = "button"; chip.onclick = () => { dash.filingsPick = null; renderFilings(); }; box.append(chip); }
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
      row.title = [d ? submitText(f, today) : "", f.deadline ? "due " + longDate(f.deadline) : "", f.notes].filter(Boolean).join("\n");
      box.append(row);
    });
  });
  if (!any) box.append(el("p", "empty", "nothing to file"));
}
function openFiling(row) {
  const fl = data.filings; if (!fl) return;
  showView(fl.name);
  const tr = $("#grid tbody").children[row]; if (!tr) return;
  tr.scrollIntoView({ block: "center" }); tr.classList.add("flash"); setTimeout(() => tr.classList.remove("flash"), 2500);
}


/* ---------- forecast (business) and budget (personal): inputs live on the forecast tab, the plan is worked out here, in dollars ---------- */
const FC = {
  business: { title: "forecast", col: 1, sides: ["revenue", "costs"], inputs: [
    ["revenue", "retainer income", "retainers per month", "money"], ["revenue", "program price", "program price", "money"], ["revenue", "program sales", "program sales per month", "count"],
    ["costs", "team", "team", "money"], ["costs", "ad spend", "ads", "money"], ["costs", "software", "software", "money"], ["costs", "other costs", "other costs", "money"],
    ["costs", "payment fees", "payment fees", "pct"], ["costs", "corporation tax", "corporation tax", "pct"]] },
  personal: { title: "budget", col: 18, sides: ["income", "spending"], inputs: [
    ["income", "salary", "salary", "money"], ["income", "dividends", "dividends", "money"], ["income", "other income", "other income", "money"],
    ["spending", "rent", "rent", "money"], ["spending", "bills", "bills", "money"], ["spending", "groceries", "groceries", "money"], ["spending", "eating out", "eating out", "money"],
    ["spending", "transport", "transport", "money"], ["spending", "travel", "travel", "money"], ["spending", "everything else", "everything else", "money"]] }
};
const fc = { pick: null, sheet: false };
// your personal budget, per month, from the budget block on the forecast tab
function monthlyBudget() {
  const inp = fcInputs(FC.personal); if (!inp) return null;
  const spend = FC.personal.inputs.filter(x => x[0] === "spending").reduce((a, x) => a + ((inp[x[1]] || {}).v || 0), 0);
  return spend > 0 ? { spend } : null;
}
function fcConf() { return FC[dash.mode === "personal" ? "personal" : "business"]; }
function fcInputs(conf = fcConf()) {
  const t = tabByName("forecast"), out = {}; if (!t) return null;
  t.display.forEach((r, i) => { const k = lc((r || [])[conf.col]); if (k && (conf.inputs.some(x => x[1] === k) || k === "start month") && !(k in out)) { const v = String((r || [])[conf.col + 1] || "").trim(); out[k] = { i, raw: v, v: /%$/.test(v) ? parseFloat(v) / 100 : num(v) }; } });
  return out["start month"] ? out : null;
}
function fcPlan(inp) {
  const g = k => (inp[k] || {}).v || 0;
  if (dash.mode === "personal") {
    const inc = g("salary") + g("dividends") + g("other income"), parts = FC.personal.inputs.filter(x => x[0] === "spending").map(x => [x[2], g(x[1])]);
    const costs = parts.reduce((a, p) => a + p[1], 0);
    return { rev: inc, costs, pbt: inc - costs, keep: inc - costs, sources: [["salary", g("salary")], ["dividends", g("dividends")], ["other income", g("other income")]], all: { label: "all income", v: inc, steps: parts, keep: "saved / invested" }, products: [] };
  }
  const ret = g("retainer income"), prog = g("program price") * g("program sales"), rev = ret + prog, rate = g("payment fees");
  const team = g("team"), ads = g("ad spend"), soft = g("software"), other = g("other costs"), fees = rev * rate;
  const costs = team + ads + soft + other + fees, pbt = rev - costs, tax = Math.max(0, pbt) * g("corporation tax");
  return { rev, costs, pbt, tax, keep: pbt - tax, sales: g("program sales"), ads,
    all: { label: "all products", v: rev, steps: [["team", team], ["ads", ads], ["software", soft], ["other costs", other], ["payment fees", fees], ["corporation tax", tax]], keep: "profit after tax" },
    products: [{ label: "retainers", v: ret, steps: [["team", team], ["payment fees", ret * rate]] }, { label: "program", v: prog, steps: [["ads", ads], ["payment fees", prog * rate]] }] };
}
function renderForecast() {
  dash.scope = dash.mode === "personal" ? "personal" : (dash.co || "companies");
  const conf = fcConf(), inp = fcInputs(conf), t = tabByName("forecast"), personal = dash.mode === "personal", w = words();
  if (!inp) return;
  $("#fcTitle").textContent = conf.title;
  const p = fcPlan(inp), start = new Date(((inp["start month"] || {}).raw || iso(new Date())).slice(0, 7) + "-01T00:00:00");
  const sm = $("#fcStart"); sm.value = iso(start).slice(0, 7);
  sm.onchange = () => { if (/^\d{4}-\d{2}$/.test(sm.value)) saveInput(t, inp["start month"], sm.value + "-01", conf.col); };
  $("#fcSheet").onclick = () => { fc.sheet = true; showView("forecast"); };

  renderPlanTable(conf, inp, p, t);

  // the next 12 months from the start month; months that have started show what actually happened
  const today = iso(new Date()), ents = personal ? ["personal"] : ["ie ltd", "uk ltd"], months = [];
  for (let k = 0; k < 12; k++) {
    const m = addMonths(start, k), x = { from: iso(m), to: iso(monthEnd(m)) }, started = x.from <= today;
    const rows = started ? sel(x, null, ents) : [];
    months.push({ m: iso(m).slice(0, 7), label: MONTHS[m.getMonth()], started, inc: total(rows.filter(isIncome)), cost: -total(rows.filter(r => isCost(r) || (!personal && r.category === "director pay"))) });
  }
  const host = $("#fcChart"), chart = el("div"); host.replaceChildren(chart);
  const max = niceMax(Math.max(p.rev, p.costs, ...months.map(d => Math.max(d.inc, d.cost)), 1));
  svgBox(chart, 250, W2 => {
    const L = 40, base = 190, y = v => base - v / max * 180, slot = (W2 - L) / 12; let s = "";
    [0, 0.25, 0.5, 0.75, 1].forEach(tk => { const v = max * tk; s += '<line x1="' + L + '" x2="' + W2 + '" y1="' + y(v) + '" y2="' + y(v) + '" style="stroke:' + (tk ? "var(--grid)" : "currentColor") + '"/><text x="0" y="' + (y(v) + 5) + '" ' + F + ">" + (tk ? short(v) : "0") + "</text>"; });
    months.forEach((d, k) => {
      const x = L + k * slot + slot * 0.14, bw = slot * 0.34, inc = d.started ? d.inc : p.rev, cost = d.started ? d.cost : p.costs, a = d.started ? 1 : 0.4;
      s += '<g opacity="' + a + '"><rect x="' + x + '" y="' + y(inc) + '" width="' + bw + '" height="' + (base - y(inc)) + '" fill="' + GREEN + '"/><rect x="' + (x + bw + 2) + '" y="' + y(cost) + '" width="' + bw + '" height="' + (base - y(cost)) + '" fill="' + RED + '"/></g>'
        + '<text x="' + x + '" y="' + (base + 20) + '" ' + F + ">" + (slot < 44 ? d.label[0] : d.label) + "</text>";
      const n = inc - cost; if (slot >= 44) s += '<text x="' + x + '" y="' + (base + 40) + '" font-size="14" font-family="PT Sans, Arial, sans-serif" style="fill:' + (n < 0 ? RTEXT : GTEXT) + '">' + (n < 0 ? "" : "+") + short(n) + "</text>";
      s += '<rect x="' + (L + k * slot) + '" y="0" width="' + slot + '" height="245" fill="transparent" data-tip="' + esc(d.label + " " + d.m.slice(0, 4) + "|" + (d.started ? "actual" : "plan") + "|" + w.rev + " " + money(inc) + "|" + w.cost + " " + money(cost) + (d.started ? "|plan: " + w.rev + " " + money(p.rev) + ", " + w.cost + " " + money(p.costs) : "")) + '"/>';
    });
    return s;
  });
  const lg = el("div", "legend"); lg.innerHTML = '<span><span class="sw" style="background:' + GREEN + '"></span>' + w.rev + '</span><span><span class="sw" style="background:' + RED + '"></span>' + w.cost + '</span><span><span class="sw faded" style="background:' + GREEN + '"></span>plan</span>';
  host.append(lg);
  const figs = personal
    ? [["income", p.rev * 12, "g", money(p.rev) + " a month"], ["spending", p.costs * 12, "r", money(p.costs) + " a month"], ["saved / invested", p.keep * 12, p.keep < 0 ? "r" : "g", p.rev > 0 ? pct(p.keep / p.rev) + " of income" : ""]]
    : [["revenue", p.rev * 12, "g", money(p.rev) + " a month"], ["costs", p.costs * 12, "r", money(p.costs) + " a month"], ["profit before tax", p.pbt * 12, p.pbt < 0 ? "r" : "g", p.rev > 0 ? pct(p.pbt / p.rev) + " of revenue" : ""], ["corporation tax", p.tax * 12, "r", money(p.tax) + " a month"], ["profit after tax", p.keep * 12, p.keep < 0 ? "r" : "g", money(p.keep) + " a month"]];
  $("#fcFigs").replaceChildren(...figs.map(([l, v, c, n]) => { const d = el("div", "fig"); d.append(el("i", null, l), el("span", c, money(v)), el("span", null, n)); return d; }));

}
/* the plan next to what actually happened, line by line, for a month, the last 3 months or the year so far */
const PT_MAP = { rent: ["rent"], bills: ["bills"], groceries: ["groceries"], "eating out": ["eating out"], transport: ["transport"], travel: ["travel", "travel & meals"] };
function planRange() {
  const thisMonth = new Date(iso(new Date()).slice(0, 7) + "-01T00:00:00");
  if (fc.period === "3m") { const a = addMonths(thisMonth, -3); return { from: iso(a), to: iso(monthEnd(addMonths(a, 2))), n: 3, label: "last 3 months" }; }
  if (fc.period === "year") { const a = new Date(thisMonth.getFullYear(), 0, 1); return { from: iso(a), to: iso(monthEnd(thisMonth)), n: thisMonth.getMonth() + 1, label: "this year" }; }
  const m = new Date((fc.month || iso(thisMonth).slice(0, 7)) + "-01T00:00:00");
  return { from: iso(m), to: iso(monthEnd(m)), n: 1, label: MONTHS[m.getMonth()] + " " + m.getFullYear() };
}
function renderPlanTable(conf, inp, p, t) {
  const personal = dash.mode === "personal", rg = planRange(), n = rg.n, today = iso(new Date());
  // period controls
  const pp = $("#fcPeriod"); pp.innerHTML = "";
  const cur = iso(new Date()).slice(0, 7), mm = fc.month || cur;
  const step = d => { const m = addMonths(new Date(mm + "-01T00:00:00"), d); if (iso(m).slice(0, 7) <= cur) { fc.month = iso(m).slice(0, 7); fc.period = "month"; renderForecast(); } };
  const prev = el("button", "prev", "‹"), lab = el("button", null, MONTHS[+mm.slice(5) - 1] + " " + mm.slice(0, 4)), next = el("button", "next", "›");
  [prev, lab, next].forEach(b => (b.type = "button"));
  prev.onclick = () => step(-1); next.onclick = () => step(1); next.disabled = mm >= cur; lab.onclick = () => { fc.period = "month"; renderForecast(); };
  lab.setAttribute("aria-pressed", (fc.period || "month") === "month");
  pp.append(prev, lab, next);
  [["3m", "last 3 months"], ["year", "this year"]].forEach(([k, l]) => { const b = el("button", null, l); b.type = "button"; b.setAttribute("aria-pressed", fc.period === k); b.onclick = () => { fc.period = k; renderForecast(); }; pp.append(b); });

  const ents = personal ? ["personal"] : ["ie ltd", "uk ltd"], rows = sel(rg, null, ents);
  const sumCat = cats => -total(rows.filter(r => cats.includes(r.category) && (isCost(r) || r.category === "director pay")));
  const sumInc = fn => total(rows.filter(r => isIncome(r) && fn(r)));
  const g = k => (inp[k] || {}).v || 0;
  const lines = [];  // [kind, label, plan, actual, good: "up"|"down", inputKey, inputKind]
  if (personal) {
    lines.push(["head", "income"]);
    lines.push(["line", "salary", g("salary") * n, sumInc(r => r.category === "salary"), "up", "salary"]);
    lines.push(["line", "dividends", g("dividends") * n, sumInc(r => r.category === "dividends"), "up", "dividends"]);
    lines.push(["line", "other income", g("other income") * n, sumInc(r => r.category !== "salary" && r.category !== "dividends"), "up", "other income"]);
    const ti = lines.slice(1).reduce((a, l) => a + l[2], 0), ta = lines.slice(1).reduce((a, l) => a + l[3], 0);
    lines.push(["total", "total income", ti, ta, "up"]);
    lines.push(["head", "spending"]);
    const spendCats = [...new Set(rows.filter(isCost).map(r => r.category))], mapped = Object.values(PT_MAP).flat();
    let tp = 0, tsp = 0;
    FC.personal.inputs.filter(x => x[0] === "spending").forEach(([, key, label]) => {
      const act = key === "everything else" ? sumCat(spendCats.filter(c => !mapped.includes(c))) : sumCat(PT_MAP[key] || [key]);
      lines.push(["line", label, g(key) * n, act, "down", key]); tp += g(key) * n; tsp += act;
    });
    lines.push(["total", "total spending", tp, tsp, "down"]);
    lines.push(["total", "balance", ti - tp, ta - tsp, "up"]);
    const iv = data.investments;
    if (iv) lines.push(["line", "invested", iv.monthly * n, iv.holdings.filter(h => h.date >= rg.from && h.date <= rg.to).reduce((a, h) => a + h.paid, 0), "up"]);
  } else {
    const ms = streamMargins(rg), sm = k => ms.find(x => x.label === k) || { v: 0, margin: 0 };
    lines.push(["head", "revenue"]);
    lines.push(["line", "retainers", g("retainer income") * n, sm("retainers").v, "up", "retainer income"]);
    lines.push(["line", "program", g("program price") * g("program sales") * n, sm("program").v, "up"]);
    lines.push(["note", "program price", g("program price"), null, "", "program price"]);
    lines.push(["note", "program sales a month", g("program sales"), null, "", "program sales", "count"]);
    lines.push(["line", "other revenue", 0, ms.filter(x => x.label !== "retainers" && x.label !== "program").reduce((a, x) => a + x.v, 0), "up"]);
    const rp = (g("retainer income") + g("program price") * g("program sales")) * n, ra = ms.reduce((a, x) => a + x.v, 0);
    lines.push(["total", "total revenue", rp, ra, "up"]);
    lines.push(["head", "costs"]);
    const salary = (fcInputs(FC.personal) || {}).salary;
    const fees = ["payment fees", "bank fees", "transfer fees"], named = ["team", "ads & marketing", "software", "director pay", ...fees];
    const costCats = [...new Set(rows.filter(r => isCost(r)).map(r => r.category))];
    const cl = [["team", g("team") * n, sumCat(["team"]), "team"], ["ads", g("ad spend") * n, sumCat(["ads & marketing"]), "ad spend"], ["software", g("software") * n, sumCat(["software"]), "software"],
      ["director pay", (salary ? salary.v : 0) * n, sumCat(["director pay"])], ["payment fees", rp * g("payment fees"), sumCat(fees)], ["other costs", g("other costs") * n, sumCat(costCats.filter(c => !named.includes(c))), "other costs"]];
    cl.forEach(([l, pl, ac, key]) => { lines.push(["line", l, pl, ac, "down", key]); if (l === "payment fees") lines.push(["note", "payment fees, share of revenue", g("payment fees"), null, "", "payment fees", "pct"]); });
    const cp = cl.reduce((a, x) => a + x[1], 0), ca = cl.reduce((a, x) => a + x[2], 0);
    lines.push(["total", "total costs", cp, ca, "down"]);
    const pbtP = rp - cp, pbtA = ra - ca, rate = g("corporation tax"), taxP = Math.max(0, pbtP) * rate, taxA = Math.max(0, pbtA) * rate;
    lines.push(["total", "profit before tax", pbtP, pbtA, "up"]);
    lines.push(["line", "corporation tax", taxP, taxA, "down"]);
    lines.push(["note", "corporation tax rate", rate, null, "", "corporation tax", "pct"]);
    lines.push(["total", "profit after tax", pbtP - taxP, pbtA - taxA, "up"]);
  }
  const tb = el("table", "plan"), th = el("tr"), w = personal ? ["", "budget", "actual", "left"] : ["", "plan", "actual", "difference"];
  w.forEach((x, k) => th.append(el("th", k ? "num" : null, x))); tb.append(el("thead")); tb.firstChild.append(th);
  const body = el("tbody");
  const fmtIn = (x, kind) => kind === "pct" ? (Math.round(x * 1000) / 10) + "%" : kind === "count" ? String(Math.round(x * 100) / 100) : money(x);
  lines.forEach(([kind, label, plan, act, good, key, ikind]) => {
    const tr = el("tr", kind);
    if (kind === "head") { const td = el("td", null, label); td.colSpan = 4; tr.append(td); return body.append(tr); }
    // each value sits in a span over a dotted line, so the eye can run from the label across to its figures
    const sp = (cls, txt) => { const td = el("td", cls); td.append(el("span", null, txt)); return td; };
    tr.append(sp(null, label));
    const pc = sp("num", kind === "note" ? fmtIn(plan, ikind) : money(plan));
    const cell = key && inp[key];
    if (cell) {
      pc.classList.add("editable");
      pc.onclick = () => {
        if (pc.querySelector("input")) return;
        const input = el("input", "inline"); input.value = ikind === "pct" ? String(Math.round(cell.v * 1000) / 10) : String(cell.v); pc.replaceChildren(input); input.focus(); input.select();
        let done = false; const finish = ok => { if (done) return; done = true; const v = parseFloat(input.value.replace(/[^0-9.\-]/g, "")); if (ok && isFinite(v)) saveInput(t, cell, ikind === "pct" ? v / 100 : v, conf.col); else renderForecast(); };
        input.onkeydown = e => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); }; input.onblur = () => finish(true);
      };
    }
    tr.append(pc);
    if (act == null) { tr.append(sp("num", ""), sp("num", "")); return body.append(tr); }
    tr.append(sp("num", money(act)));
    const diff = good === "down" ? plan - act : act - plan;
    tr.append(sp("num " + (Math.abs(diff) < 0.5 ? "" : diff < 0 ? "r" : "g"), Math.abs(diff) < 0.5 ? "–" : (diff < 0 ? "−" : "+") + money(Math.abs(diff)).replace(/^−/, "")));
    body.append(tr);
  });
  tb.append(body);
  $("#fcTable").replaceChildren(tb);
}
async function saveInput(tab, cell, value, col = 1) {
  if (!cell) return;
  await writeCell(tab, cell.i, col + 1, value);
  if (TEST) { const r = tab.display[cell.i]; r[col + 1] = typeof value === "number" && value < 1 && value > 0 ? (value * 100) + "%" : String(value); }
  buildModel(); renderForecast();
}

/* ---------- investments (personal): what you've put in, what it's worth now, and the monthly goal ---------- */
function investedBy(to) { const iv = data.investments; return iv ? iv.holdings.filter(h => h.date <= to).reduce((a, h) => a + h.paid, 0) : 0; }
function investValue() { const iv = data.investments; return iv ? iv.holdings.reduce((a, h) => a + h.value, 0) : 0; }
function renderInvestments() {
  const sec = $("#investSec"), iv = data.investments, show = dash.mode === "personal" && !!iv;
  sec.hidden = !show; if (!show) return;
  const list = $("#investList"), detail = $("#investDetail"), today = iso(new Date());
  const byT = new Map(); iv.holdings.forEach(h => { const x = byT.get(h.ticker) || { paid: 0, value: 0 }; x.paid += h.paid; x.value += h.value; byT.set(h.ticker, x); });
  const paid = [...byT.values()].reduce((a, x) => a + x.paid, 0), value = investValue();
  const growth = (v, p) => { const g = v - p; return [el("span", g < 0 ? "r" : "g", money(v)), document.createTextNode(p > 0 ? " (" + (g < 0 ? "" : "+") + pct(g / p) + ")" : "")]; };
  list.replaceChildren(el("i", "mt", "holding"));
  if (!byT.size) list.append(el("p", "empty", "nothing invested yet"));
  else {
    list.append(lead("all holdings", growth(value, paid), { sel: true }));
    [...byT.entries()].sort((a, b) => b[1].value - a[1].value).forEach(([t, x]) => list.append(lead(t.replace(/^[A-Z]+:/, "").toLowerCase(), growth(x.value, x.paid))));
    list.append(lead("put in", money(paid), { italic: true, cls: "total" }));
  }
  // the goal: so much a month from the start month, for so many years
  const start = iv.starts || today, months = start > today ? 0 : Math.max(1, Math.floor((new Date(today + "T00:00:00") - new Date(start + "T00:00:00")) / (864e5 * 30.44)) + 1);
  const pace = months * iv.monthly, target = iv.monthly * 12 * iv.years, diff = paid - pace;
  const s0 = new Date(start + "T00:00:00"), end = addMonths(s0, iv.years * 12 - 1);
  const goal = el("div");
  goal.append(el("i", "mt", "goal"), lead("each month", money(iv.monthly)), lead("by " + MONTHS[end.getMonth()] + " " + end.getFullYear(), money(target)),
    lead("so far", months ? [el("span", diff < -0.5 ? "r" : "g", money(paid)), document.createTextNode(" of " + money(pace) + (diff < -0.5 ? " (" + money(-diff) + " behind)" : diff > 0.5 ? " (" + money(diff) + " ahead)" : ""))] : "starts " + longDate(start)));
  const bar = el("div", "chart");
  goal.append(bar);
  setTimeout(() => svgBox(bar, 20, W2 => { const w = Math.min(1, paid / (target || 1)) * W2; return '<rect x="0" y="4" width="' + W2 + '" height="12" style="fill:var(--soft)"/><rect x="0" y="4" width="' + w + '" height="12" fill="' + GREEN + '"/>'; }), 0);
  const watch = el("div");
  watch.append(el("i", "mt group", "highlighted"));
  iv.watch.forEach(w => watch.append(lead(w.name, w.priv ? [el("i", null, "private")] : [el("span", null, money(w.price).replace(/(\.\d+)?$/, "") ), document.createTextNode(" "), el("span", w.today < 0 ? "r" : "g", w.today == null ? "" : (w.today < 0 ? "" : "+") + (Math.round(w.today * 1000) / 10) + "% today")])));
  detail.replaceChildren(goal, watch);
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
  const noReceipt = sel(rg, r => isCost(r) && !r.receipt, cos).length;
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
    b.append(el("span", i.urgent ? "hl" : null, String(i.n)), document.createTextNode(" " + i.text));
    b.onclick = i.go; box.append(b);
  });
}
// tasks: a plain text box, one task per line. it saves to the tasks tab when you click away
function renderTasks() {
  const box = $("#tasksBox"), t = data.tasks;
  box.hidden = !t; if (!t) return;
  const ta = el("textarea", "tasks-text"); ta.value = openTasks().map(x => x.text).join("\n\n"); ta.spellcheck = true; ta.setAttribute("aria-label", "tasks");
  const fit = () => { ta.style.height = "auto"; ta.style.height = (ta.scrollHeight + 2) + "px"; };
  ta.oninput = fit;
  ta.onblur = () => saveTasks(ta.value.split("\n").map(x => x.trim()).filter(Boolean));
  box.replaceChildren(el("b", "hd", "tasks"), ta);
  setTimeout(fit, 0);
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
    && (f.only !== "wrong" || WRONG_ACCOUNT.includes(r.category)) && (f.only !== "receipt" || (r.group === "cost" && !r.receipt))
    && (!q || (r.merchant + " " + lc((tab.display[r.i] || [])[c.reference]) + " " + r.category + " " + r.date).includes(q))).reverse();
}
/* the transactions behind anything you click on the dashboard, in a pop-up you can edit and copy from */
let txmDirty = false;
function openTx(f, title) {
  const rg = range(), ents = scopeEntities(), tab = tabByName("transactions");
  const filt = Object.assign({}, TX_CLEAR, { entity: ents.length === 1 ? ents[0] : "", entities: ents.length > 1 ? ents : null, from: rg.from, to: rg.to }, f);
  const list = txMatches(filt, tab), c = data.cols;
  const cats = [...new Set(data.cats.concat(data.rows.map(r => r.category)))].filter(Boolean).sort();
  $("#txmTitle").textContent = title;
  $("#txmCount").textContent = list.length.toLocaleString("en-GB") + (list.length === 1 ? " transaction" : " transactions") + (filt.from ? ", " + longDate(filt.from) + " – " + longDate(filt.to) : "");
  const grid = $("#txmGrid"); grid.innerHTML = "";
  const thead = el("thead"), hr = el("tr");
  [["date"], ["account"], ["merchant"], ["reference"], ["amount", "num"], ["category"]].forEach(([t, k]) => hr.append(el("th", k || null, t))); thead.append(hr);
  const body = el("tbody");
  list.slice(0, 500).forEach(r => {
    const tr = el("tr"), d = tab.display[r.i] || [];
    tr.append(el("td", null, r.date), el("td", null, r.account), el("td", null, d[c.merchant] || ""), el("td", null, d[c.reference] || ""), el("td", "num " + (r.amount < 0 ? "neg" : "pos"), (d[c.amount] || "") + " " + r.cur.toLowerCase()));
    const td = el("td"), sl = el("select", "cat"); cats.forEach(v => sl.append(new Option(catName(v), v))); sl.value = r.category;
    sl.onchange = () => { txmDirty = true; writeCell(tab, r.i, c.category, sl.value).then(() => buildModel()); };
    td.append(sl); tr.append(td); body.append(tr);
  });
  grid.append(thead, body);
  $("#txmCopy").onclick = () => {
    const rows = [["row", "date", "account", "entity", "merchant", "reference", "amount", "currency", "category"].join("\t")].concat(list.map(r => { const d = tab.display[r.i] || []; return [r.i + 1, r.date, r.account, r.entity, d[c.merchant] || "", d[c.reference] || "", d[c.amount] || "", r.cur, r.category].join("\t"); }));
    const txt = title + "\n" + rows.join("\n");
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => { $("#txmCopy").textContent = "copied"; setTimeout(() => ($("#txmCopy").textContent = "copy"), 1500); }, () => {});
  };
  $("#txModal").hidden = false;
}
function closeTx() { $("#txModal").hidden = true; if (txmDirty) { txmDirty = false; buildModel(); if (view === "dashboard") renderDashboard(); } }
function showView(name) {
  view = name;
  [...$("#tabs").children].forEach(b => b.setAttribute("aria-selected", b.dataset.view === name));
  const isFc = name.toLowerCase() === "forecast" && !fc.sheet && fcInputs();
  if (name.toLowerCase() === "forecast" && !fc.sheet && !isFc) fc.sheet = true;
  $("#viewDashboard").hidden = name !== "dashboard";
  $("#viewForecast").hidden = !isFc;
  $("#viewSheet").hidden = name === "dashboard" || !!isFc;
  if (name === "dashboard") renderDashboard();
  else if (isFc) renderForecast();
  else {
    renderSheet(tabByName(name.toLowerCase()) || book.tabs.find(t => t.name === name));
    if (name.toLowerCase() === "forecast") { const b = el("button", "box", "back to the forecast"); b.type = "button"; b.onclick = () => { fc.sheet = false; showView("forecast"); }; $("#sheetHead").append(b); }
  }
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
  const size = usedSize(tab), c0 = firstUsedCol(tab);
  if (tab.name.toLowerCase() === "transactions" && data.head >= 0) return renderTransactions(tab, c0, size.cols);
  grid.className = "grid sheet";
  const body = el("tbody");
  for (let i = 0; i <= size.rows; i++) {
    const tr = el("tr"), kind = rowKind(tab, i, c0, size.cols);
    if (kind) tr.className = kind;
    for (let j = c0; j < size.cols; j++) tr.append(cell(tab, i, j, { kind }));
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
  td.textContent = disp == null ? "" : disp;
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
  grid.className = "grid tx";

  const search = el("input", "box"); search.type = "search"; search.placeholder = "search"; search.value = txFilter.text;
  const mk = (label, values, key) => { const s = el("select", "box"); s.append(new Option(label, "")); values.forEach(v => s.append(new Option(v, v))); s.value = txFilter[key] || ""; s.onchange = () => { txFilter[key] = s.value; if (key === "entity") txFilter.entities = null; draw(); }; return s; };
  const real = data.rows.filter(r => !r.synthetic), entities = [...new Set(real.map(r => r.entity))].sort(), accounts = [...new Set(real.map(r => r.account))].sort();
  const cats = [...new Set(data.cats.concat(data.rows.map(r => r.category)))].filter(Boolean).sort();
  const count = el("span", "count");
  head.append(search, mk("all entities", entities, "entity"), mk("all accounts", accounts, "account"), mk("all categories", cats, "category"));
  if (txFilter.only) { const b = el("button", "box chip", txFilter.only === "wrong" ? "paid from the wrong account" : "no receipt"); b.type = "button"; b.onclick = () => { txFilter.only = null; renderSheet(tab); }; head.append(b); }
  if (txFilter.group) { const b = el("button", "box chip", "all " + txFilter.group + "s"); b.type = "button"; b.onclick = () => { txFilter.group = ""; renderSheet(tab); }; head.append(b); }
  if (txFilter.from) { const b = el("button", "box chip", longDate(txFilter.from) + " – " + longDate(txFilter.to)); b.type = "button"; b.onclick = () => { txFilter.from = txFilter.to = ""; renderSheet(tab); }; head.append(b); }
  head.append(count);
  let t; search.oninput = () => { clearTimeout(t); t = setTimeout(() => { txFilter.text = search.value; draw(); }, 150); };

  // what each column is, in the order shown. stream, group and the book-currency amount stay in the sheet but not here.
  // the amount carries its own currency symbol; usd is that amount converted; balance runs across what's in scope
  const colsShown = [["date", c.date], ["account", c.account, "pick"], ["entity", c.entity, "pick"], ["merchant", c.merchant], ["reference", c.reference], ["amount", c.amount, "amt"], ["usd", -1, "num"], ["balance", -2, "num"], ["category", c.category, "cat"], ["receipt", c.receipt, "receipt"]];
  const fmt2 = v => (v < 0 ? "-" : "") + Math.abs(v).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function draw() {
    const keepTop = $("#sheetScroll").scrollTop;
    grid.innerHTML = ""; $("#more").innerHTML = ""; if (more) more.disconnect();
    const thead = el("thead"), tr = el("tr");
    colsShown.forEach(([name, , kind]) => {
      const th = el("th", (kind === "num" || kind === "amt" ? "num " : "") + "fold" + (txFolded.has(name) ? " x" : ""), txFolded.has(name) && FOLD_HEAD[name] ? FOLD_HEAD[name] : name); th.title = name;
      th.onclick = () => { txFolded.has(name) ? txFolded.delete(name) : txFolded.add(name); try { localStorage.setItem(FOLD_KEY, JSON.stringify([...txFolded])); } catch {} draw(); $("#sheetScroll").scrollTop = keepTop; };
      tr.append(th);
    });
    thead.append(tr); grid.append(thead);
    const list = txMatches(txFilter, tab);
    count.textContent = list.length.toLocaleString("en-GB") + (list.length === 1 ? " transaction" : " transactions");
    const bal = runningBalance(txFilter);
    const body = el("tbody"); grid.append(body);
    let shown = 0, lastY = "", lastM = "";
    const iUsd = colsShown.findIndex(x => x[0] === "usd");
    // a year or month row: its name, income and costs of the rows shown, the balance it started on; net under usd, closing balance under balance
    const sumOf = key => { const rs = list.filter(r => r.date.startsWith(key)), inc = total(rs.filter(isIncome)), cost = total(rs.filter(isCost));
      const asc = rs.slice().sort((p, q) => p.date < q.date || (p.date === q.date && p.i < q.i) ? -1 : 1);
      const first = asc[0], last = asc[asc.length - 1];
      return { inc, cost, net: total(rs), start: first && bal.has(first.i) ? bal.get(first.i) - first.v : null, end: last && bal.has(last.i) ? bal.get(last.i) : null }; };
    const sepRow = (cls, label, key) => {
      const t = sumOf(key), h = el("tr", "sep " + cls), lab = el("td"); lab.colSpan = iUsd;
      const name = cls === "year" ? el("b", null, label) : el("i", null, label);
      const part = (l, v, c) => { const sp = el("span", "part"); sp.append(el("i", null, l), " ", el("span", c, v)); return sp; };
      lab.append(name, part("income", money(t.inc), t.inc ? "g" : null), part("costs", money(t.cost), t.cost ? "r" : null));
      if (t.start != null) lab.append(part("started on", money(t.start)));
      const net = el("td", "num " + (t.net < 0 ? "neg" : "pos"), fmt2(t.net)), end = el("td", "num", t.end == null ? "" : fmt2(t.end)), rest = el("td"); rest.colSpan = colsShown.length - iUsd - 2;
      h.append(lab, net, end, rest); return h;
    };
    const page = () => {
      const frag = document.createDocumentFragment();
      list.slice(shown, shown + 300).forEach(r => {
        const y = r.date.slice(0, 4), m = r.date.slice(0, 7);
        if (y !== lastY) { frag.append(sepRow("year", y, y)); lastY = y; }
        if (m !== lastM) { frag.append(sepRow("month", MONTHS[+m.slice(5) - 1], m)); lastM = m; }
        frag.append(txRow(tab, r, colsShown, cats, entities, accounts, bal));
      });
      body.append(frag); shown += 300;
      if (shown >= list.length && more) more.disconnect();
    };
    page();
    const yr = body.querySelector("tr.sep.year");
    grid.style.setProperty("--th-h", thead.offsetHeight + "px"); grid.style.setProperty("--yr-h", (yr ? yr.offsetHeight : 0) + "px");
    const sentinel = el("div"); sentinel.style.height = "1px"; $("#more").append(sentinel);
    more = new IntersectionObserver(es => { if (es[0].isIntersecting && shown < list.length) page(); }, { root: $("#sheetScroll"), rootMargin: "400px" });
    more.observe(sentinel);
  }
  draw();
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
const FOLD_SHORT = { account: r => r.account.split(" ")[0], entity: r => r.entity === "personal" ? "me" : r.entity.split(" ")[0], reference: () => "", amount: r => SYMBOL[r.cur] || r.cur };
const FOLD_HEAD = { account: "acct", entity: "ent", reference: "ref", amount: "amt" };
function txRow(tab, r, colsShown, cats, entities, accounts, bal) {
  const row = el("tr"), d = tab.display[r.i] || [], raw = tab.raw[r.i] || [];
  const fmt2 = v => (v < 0 ? "-" : "") + Math.abs(v).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  colsShown.forEach(([name, j, kind]) => {
    let td = el("td");
    // a folded column keeps a short form: the bank's first word, ie or uk, the currency symbol, nothing for the reference
    if (txFolded.has(name) && FOLD_SHORT[name]) {
      td.className = "x"; td.textContent = FOLD_SHORT[name](r, d[j]); td.title = name === "amount" ? (r.amount < 0 ? "-" : "") + (SYMBOL[r.cur] || r.cur + " ") + Math.abs(r.amount).toLocaleString("en-GB", { minimumFractionDigits: 2 }) : d[j] || "";
      return row.append(td);
    }
    if (kind === "pick" || kind === "cat") {
      const opts = kind === "cat" ? cats : name === "entity" ? entities : accounts, sl = el("select", kind === "cat" ? "cat tag" : "cat");
      opts.forEach(v => sl.append(new Option(kind === "cat" ? catName(v) : v, v))); sl.value = kind === "cat" ? r.category : name === "entity" ? r.entity : r.account;
      if (kind === "cat") sl.style.setProperty("--h", CAT_HUE[r.category] != null ? CAT_HUE[r.category] : 40);
      sl.onchange = () => { writeCell(tab, r.i, j, sl.value).then(() => { buildModel(); if (kind === "cat") sl.style.setProperty("--h", CAT_HUE[sl.value] != null ? CAT_HUE[sl.value] : 40); }); };
      td.append(sl);
    } else if (name === "usd") {
      td.className = "num " + (r.v < 0 ? "neg" : "pos"); td.textContent = fmt2(r.v);
    } else if (name === "balance") {
      td.className = "num"; td.textContent = bal && bal.has(r.i) ? fmt2(bal.get(r.i)) : "";
    } else if (kind === "amt") {
      const sym = SYMBOL[r.cur] || (r.cur ? r.cur + " " : "");
      td.className = "num edit " + (r.amount < 0 ? "neg" : "pos"); td.textContent = (r.amount < 0 ? "-" : "") + sym + Math.abs(r.amount).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      td.title = td.textContent; td.onclick = () => edit(td, tab, r.i, j);
    } else if (kind === "receipt") {
      const link = receiptLink(raw[j], d[j]);
      td.className = "receipt";
      if (link) { const a = el("a", null, link.label); a.href = link.url; a.target = "_blank"; a.rel = "noopener"; td.append(a); }
      else { td.textContent = d[j] || ""; td.classList.add("edit"); if (!d[j] && receiptExpected(r)) td.classList.add("need"); td.onclick = () => edit(td, tab, r.i, j); }
    } else { td = cell(tab, r.i, j, { right: kind === "num", colour: true, kind: "data" }); if (name === "merchant" || name === "reference" || name === "account" || name === "entity") { td.classList.add("clip"); td.title = td.textContent; } }
    if (txFolded.has(name)) td.classList.add("x");
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
  ["dashboard"].concat(book.tabs.map(t => t.name).filter(n => !HIDE_TABS.includes(n.toLowerCase()))).forEach(n => {
    const b = el("button", null, n); b.type = "button"; b.setAttribute("role", "tab"); b.dataset.view = n;
    b.onclick = () => { if (n.toLowerCase() === "transactions") Object.assign(txFilter, TX_CLEAR, modeFilter()); if (n.toLowerCase() === "forecast") fc.sheet = false; showView(n); };
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
document.addEventListener("mousemove", e => {
  const tip = $("#tip"), t = e.target.closest && e.target.closest("[data-tip]");
  if (!t) { tip.hidden = true; return; }
  tip.innerHTML = t.dataset.tip.split("|").map(esc).join("<br>"); tip.hidden = false;
  tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px"; tip.style.top = (e.clientY + 14) + "px";
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && book && !TEST && !signedIn()) status("signed out. sign out from the menu, then sign in again."); });

if (TEST) { book = TEST; start(); }
else {
  loadScript("https://accounts.google.com/gsi/client").catch(() => gateError("google sign-in couldn't load. check your connection."));
  loadPass();
  const f = lastFile(); if (signedIn() && f) { $("#gate").hidden = true; loadBook(f.id); }
}
