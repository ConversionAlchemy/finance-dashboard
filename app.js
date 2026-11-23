"use strict";

/* ---------- settings ---------- */
const CLIENT_ID = "889111204943-edo28tmkq0e2224mg86prldvujm907cd.apps.googleusercontent.com";
const APP_ID = "889111204943";            // google cloud project number
const PICKER_API_KEY = "";                // google cloud > credentials > api key (restricted to the picker api)
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets/";
const FILE_KEY = "ca-finance-file";
const VIEW_KEY = "ca-finance-view";
const SKIP_TABS = ["dashboard"];          // the sheet's own dashboard tab; this app's dashboard replaces it
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
const dash = { scope: null, cur: "USD", fy: null, q: 0, month: null };
const SCOPES = [["all", "everything"], ["companies", "both companies"], ["ie ltd", "irish company"], ["uk ltd", "uk company"], ["personal", "personal"]];
const FX_FALLBACK = { GBPEUR: 1.17, USDEUR: 0.92, EURGBP: 0.855, USDGBP: 0.78 };
const txFilter = { text: "", entity: "", entities: null, category: "", account: "", only: null, from: "", to: "" };

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

/* ---------- currency ---------- */
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
function fyStartFor(dateStr, ye) {
  const d = new Date(dateStr + "T00:00:00"); const startMonth = ye % 12; // 0-based month after year end
  let y = d.getFullYear(); if (d.getMonth() < startMonth) y--;
  return new Date(y, startMonth, 1);
}
function fyLabel(start, ye) { return ye === 12 ? "fy " + start.getFullYear() : "fy " + start.getFullYear() + "–" + String(start.getFullYear() + 1).slice(2); }
function scopeYe() { return dash.scope === "uk ltd" ? data.ent["uk ltd"].ye : 12; }
function fyList() {
  const ye = scopeYe(); const ents = scopeEntities(); const rs = data.rows.filter(r => ents.includes(r.entity));
  if (!rs.length) return [];
  const first = fyStartFor(rs[0].date, ye), last = fyStartFor(iso(new Date()) > rs[rs.length - 1].date ? iso(new Date()) : rs[rs.length - 1].date, ye);
  const out = []; for (let d = first; d <= last; d = addMonths(d, 12)) out.push({ start: iso(d), label: fyLabel(d, ye) });
  return out.reverse();
}
function range() {
  const s = new Date(dash.fy + "T00:00:00");
  if (dash.month) { const m = new Date(dash.month + "-01T00:00:00"); return { from: iso(m), to: iso(monthEnd(m)), months: 1 }; }
  if (dash.q) { const a = addMonths(s, (dash.q - 1) * 3); return { from: iso(a), to: iso(monthEnd(addMonths(a, 2))), months: 3 }; }
  return { from: iso(s), to: iso(monthEnd(addMonths(s, 11))), months: 12 };
}
function prevRange(r) {
  const a = addMonths(new Date(r.from + "T00:00:00"), -r.months);
  return { from: iso(a), to: iso(monthEnd(addMonths(a, r.months - 1))), months: r.months };
}

/* ---------- maths ---------- */
const inRange = (r, rg) => r.date >= rg.from && r.date <= rg.to;
const sel = (rg, fn, ents = scopeEntities()) => data.rows.filter(r => ents.includes(r.entity) && inRange(r, rg) && !internal(r) && (!fn || fn(r)));
const total = (rows, f = "v") => rows.reduce((a, r) => a + r[f], 0);
function ukTax(p) { if (p <= 0) return 0; if (p <= 50000) return p * 0.19; if (p >= 250000) return p * 0.25; return p * 0.25 - 0.015 * (250000 - p); }
function figures(rg) {
  const rows = sel(rg);
  const income = total(rows.filter(r => r.group === "income"));
  const costs = total(rows.filter(r => r.group === "cost"));
  const pay = dash.scope === "all" ? 0 : total(rows.filter(r => r.category === "director pay"));
  const profit = income + costs + pay;
  let tax = 0;
  scopeEntities().filter(e => e !== "personal").forEach(e => {
    const rs = sel(rg, null, [e]); const ent = data.ent[e] || {};
    const p = total(rs.filter(r => r.group === "income" || r.group === "cost" || r.category === "director pay"), "rep");
    const t = ent.rate == null ? ukTax(p) : Math.max(0, p) * (ent.rate || 0);
    tax += t * rate(rg.to.slice(0, 7), e === "uk ltd" ? "GBP" : "EUR", dash.cur);
  });
  const fees = total(rows.filter(r => FEE_CATS.includes(r.category)));
  const ents = scopeEntities();
  const cash = total(data.rows.filter(r => ents.includes(r.entity) && r.date <= rg.to));
  return { income, costs, pay, profit, tax, fees, cash, taxPaid: total(rows.filter(r => r.group === "tax")) };
}
function monthly(fromMonth, n, fn) {
  const out = []; let m = new Date(fromMonth + "-01T00:00:00");
  for (let k = 0; k < n; k++, m = addMonths(m, 1)) out.push({ m: iso(m).slice(0, 7), v: fn({ from: iso(m), to: iso(monthEnd(m)), months: 1 }) });
  return out;
}
function money(v, sym) {
  const s = sym == null ? SYMBOL[dash.cur] : sym;
  const n = Math.round(Math.abs(v)).toLocaleString("en-GB");
  return (v < -0.5 ? "-" : "") + s + n;
}
const pct = v => { if (!isFinite(v)) return "0%"; const p = v * 100; return (Math.abs(p - Math.round(p)) > 0.05 && Math.abs(p) < 100 ? p.toFixed(1) : Math.round(p)) + "%"; };

/* ---------- dashboard ---------- */
function renderDashboard() {
  if (!SCOPES.some(([k]) => k === dash.scope)) dash.scope = "all";
  if (!SYMBOL[dash.cur]) dash.cur = "USD";
  const fys = fyList();
  if (!fys.find(f => f.start === dash.fy)) { const cur = fyStartFor(iso(new Date()), scopeYe()); dash.fy = (fys.find(f => f.start === iso(cur)) || fys[0] || {}).start; dash.q = 0; dash.month = null; }
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(dash)); } catch {}

  const sp = $("#scopePick"); sp.innerHTML = "";
  SCOPES.forEach(([k, label]) => { const o = el("option", null, label); o.value = k; o.selected = k === dash.scope; sp.append(o); });
  sp.onchange = () => { dash.scope = sp.value; dash.fy = null; renderDashboard(); };
  const cp = $("#currencyPick"); cp.innerHTML = "";
  ["USD", "EUR", "GBP"].forEach(c => { const b = el("button", null, SYMBOL[c]); b.type = "button"; b.setAttribute("aria-pressed", c === dash.cur); b.setAttribute("aria-label", c.toLowerCase()); b.onclick = () => { dash.cur = c; applyCurrency(); renderDashboard(); }; cp.append(b); });
  const yp = $("#yearPick"); yp.innerHTML = "";
  fys.forEach(f => { const o = el("option", null, f.label); o.value = f.start; o.selected = f.start === dash.fy; yp.append(o); });
  yp.onchange = () => { dash.fy = yp.value; dash.q = 0; dash.month = null; renderDashboard(); };
  const qp = $("#quarterPick"); qp.innerHTML = "";
  ["year", "q1", "q2", "q3", "q4"].forEach((t, k) => { const b = el("button", null, t); b.type = "button"; b.setAttribute("aria-pressed", dash.q === k && !dash.month); b.onclick = () => { dash.q = k; dash.month = null; renderDashboard(); }; qp.append(b); });
  const chip = $("#monthChip");
  chip.hidden = !dash.month; if (dash.month) { const m = new Date(dash.month + "-01T00:00:00"); chip.textContent = MONTHS[m.getMonth()] + " " + m.getFullYear(); chip.onclick = () => { dash.month = null; renderDashboard(); }; }

  const rg = range(), pv = prevRange(rg), f = figures(rg), p = figures(pv);
  $("#rangeLabel").textContent = rg.from + " to " + rg.to;
  const endMonth = rg.to.slice(0, 7); const sparkFrom = iso(addMonths(new Date(endMonth + "-01T00:00:00"), -11)).slice(0, 7);
  const personal = dash.scope === "personal";
  const tiles = [
    ["income", f.income, p.income, x => figures(x).income],
    ["costs", f.costs, p.costs, x => figures(x).costs],
    [personal ? "net" : "profit before tax", f.profit, p.profit, x => figures(x).profit],
    ["fees", f.fees, p.fees, x => figures(x).fees],
    personal ? ["director pay received", total(sel(rg, r => r.category === "income")), total(sel(pv, r => r.category === "income")), x => total(sel(x, r => r.category === "income"))]
             : ["tax due (estimate)", -f.tax, -p.tax, x => -figures(x).tax],
    ["cash", f.cash, p.cash, x => figures(x).cash]
  ];
  const tl = $("#tiles"); tl.innerHTML = "";
  tiles.forEach(([label, v, prev, fn]) => {
    const t = el("div", "tile");
    t.append(el("p", "tile-label", label), el("p", "tile-value num", money(v)));
    const ch = prev ? (v - prev) / Math.abs(prev) : null;
    t.append(el("p", "tile-change", ch == null ? "no previous period" : (ch >= 0 ? "▲ " : "▼ ") + pct(Math.abs(ch)) + " vs previous"));
    t.insertAdjacentHTML("beforeend", spark(monthly(sparkFrom, 12, fn)));
    tl.append(t);
  });

  renderMonthChart(rg);
  renderCosts(rg);
  renderFees(rg, f);
  $("#marginPanelWrap").hidden = personal; if (!personal) renderMargin(rg);
  renderRecurring(rg);
  renderCash(rg);
  $("#taxPanelWrap").hidden = personal; if (!personal) renderTax(rg, f);
  renderAttention(rg);
}

function spark(series) {
  const vs = series.map(s => s.v); const lo = Math.min(0, ...vs), hi = Math.max(0, ...vs); const span = hi - lo || 1;
  const pts = vs.map((v, k) => (k * 100 / (vs.length - 1)).toFixed(1) + "," + (28 - ((v - lo) / span) * 26 - 1).toFixed(1)).join(" ");
  const zero = (28 - ((0 - lo) / span) * 26 - 1).toFixed(1);
  return '<svg viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="100" y1="' + zero + '" y2="' + zero + '" stroke="#d9d9d9" stroke-width="1" vector-effect="non-scaling-stroke"/><polyline points="' + pts + '" fill="none" stroke="#000" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>';
}

function renderMonthChart(rg) {
  const start = dash.fy.slice(0, 7);
  const series = monthly(start, 12, x => { const rows = sel(x); return { inc: total(rows.filter(r => r.group === "income")), cost: -total(rows.filter(r => r.group === "cost")) }; });
  const W = 720, H = 240, L = 46, B = 22, T = 8, max = Math.max(1, ...series.map(s => Math.max(s.v.inc, s.v.cost)));
  const nice = niceMax(max), y = v => T + (H - T - B) * (1 - v / nice), slot = (W - L) / 12, bw = slot * 0.32;
  let svg = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="income and costs by month">';
  for (let k = 0; k <= 4; k++) { const v = nice * k / 4, yy = y(v).toFixed(1); svg += '<line x1="' + L + '" x2="' + W + '" y1="' + yy + '" y2="' + yy + '" stroke="' + (k ? "#eee" : "#000") + '"/><text x="' + (L - 6) + '" y="' + (+yy + 4) + '" font-size="11" text-anchor="end">' + esc(short(v)) + "</text>"; }
  series.forEach((s, k) => {
    const x0 = L + slot * k, active = s.m >= rg.from.slice(0, 7) && s.m <= rg.to.slice(0, 7), op = active ? 1 : 0.25;
    const m = new Date(s.m + "-01T00:00:00");
    svg += '<g opacity="' + op + '"><rect x="' + (x0 + slot * 0.16).toFixed(1) + '" y="' + y(s.v.inc).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + (y(0) - y(s.v.inc)).toFixed(1) + '" fill="#000"/>'
      + '<rect x="' + (x0 + slot * 0.16 + bw).toFixed(1) + '" y="' + y(s.v.cost).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + (y(0) - y(s.v.cost)).toFixed(1) + '" fill="#d9d9d9" stroke="#000" stroke-width="0.8"/></g>'
      + '<text x="' + (x0 + slot / 2).toFixed(1) + '" y="' + (H - 6) + '" font-size="11" text-anchor="middle">' + MONTHS[m.getMonth()] + "</text>"
      + '<rect class="bar-hit" x="' + x0.toFixed(1) + '" y="0" width="' + slot.toFixed(1) + '" height="' + (H - B) + '" fill="transparent" data-month="' + s.m + '" data-tip="' + esc(MONTHS[m.getMonth()] + " " + m.getFullYear() + "|income " + money(s.v.inc) + "|costs " + money(-s.v.cost) + "|net " + money(s.v.inc - s.v.cost)) + '"/>';
  });
  svg += "</svg>";
  const box = $("#monthChart"); box.innerHTML = svg + '<div class="legend"><span><i class="key solid"></i>income</span><span><i class="key hollow"></i>costs</span></div>';
  box.querySelectorAll(".bar-hit").forEach(b => b.addEventListener("click", () => { dash.month = dash.month === b.dataset.month ? null : b.dataset.month; renderDashboard(); }));
}
function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
function short(v) { return v >= 1e6 ? (v / 1e6).toFixed(1) + "m" : v >= 1e3 ? Math.round(v / 1e3) + "k" : String(Math.round(v)); }

function barRows(items, opts = {}) {
  const max = Math.max(1, ...items.map(i => Math.abs(i.v)));
  const wrap = el("div", "rows");
  if (!items.length) wrap.append(el("p", "empty", "nothing in this period"));
  items.forEach(i => {
    const r = el("div", "row" + (i.strong ? " strong" : "") + (i.onclick ? " link" : "") + (i.urgent ? " urgent" : ""));
    r.append(el("span", "label", i.label), el("span", "value", i.text != null ? i.text : money(i.v)));
    if (!opts.noBars && !i.strong) { const t = el("div", "track"), f = el("div", "fill"); f.style.width = (Math.abs(i.v) / max * 100).toFixed(1) + "%"; t.append(f); r.append(t); }
    if (i.onclick) r.onclick = i.onclick;
    wrap.append(r);
  });
  return wrap;
}
function groupSum(rows, key) {
  const m = new Map(); rows.forEach(r => m.set(r[key], (m.get(r[key]) || 0) + r.v));
  return [...m.entries()].map(([label, v]) => ({ label, v })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
}
function renderCosts(rg) {
  const items = groupSum(sel(rg, r => r.group === "cost"), "category");
  const top = items.slice(0, 10); const rest = items.slice(10).reduce((a, i) => a + i.v, 0);
  if (rest) top.push({ label: "everything else", v: rest });
  top.forEach(i => { if (i.label !== "everything else") i.onclick = () => goTransactions({ category: i.label }); });
  $("#costBars").replaceChildren(barRows(top));
}
function renderFees(rg, f) {
  const rows = sel(rg, r => FEE_CATS.includes(r.category));
  const box = $("#feesPanel"); box.innerHTML = "";
  box.append(barRows([
    { label: "total fees", v: f.fees, strong: true },
    { label: "share of income", text: f.income ? pct(-f.fees / f.income) : "–", strong: true }
  ], { noBars: true }));
  box.append(el("p", "split", "by provider"));
  const prov = new Map(); rows.forEach(r => { const k = r.account.split(" ")[0]; prov.set(k, (prov.get(k) || 0) + r.v); });
  box.append(barRows([...prov.entries()].map(([label, v]) => ({ label, v })).sort((a, b) => a.v - b.v)));
  box.append(el("p", "split", "by type"));
  box.append(barRows(groupSum(rows, "category").map(i => Object.assign(i, { onclick: () => goTransactions({ category: i.label }) }))));
}
function renderMargin(rg) {
  const box = $("#marginPanel"); box.innerHTML = "";
  [["retainers", "retainers"], ["program", "program"]].forEach(([label, stream]) => {
    const inc = total(sel(rg, r => r.stream === stream && r.group === "income")), cost = total(sel(rg, r => r.stream === stream && r.group === "cost"));
    const m = inc + cost;
    box.append(el("p", "split", label));
    box.append(barRows([{ label: "income", v: inc }, { label: "direct costs", v: cost }, { label: "margin", v: m, strong: true }, { label: "margin %", text: inc ? pct(m / inc) : "–", strong: true }], { noBars: true }));
    const t = el("div", "track"), fl = el("div", "fill"); fl.style.width = (inc > 0 ? Math.max(0, Math.min(1, m / inc)) * 100 : 0) + "%"; t.append(fl); t.style.marginTop = "6px"; box.append(t);
  });
}
function renderRecurring(rg) {
  const rows = sel(rg, r => r.category === "software" || r.category === "team");
  const m = new Map();
  rows.forEach(r => { const k = r.merchant.replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 2).join(" ") || r.merchant; m.set(k, (m.get(k) || 0) + r.v); });
  const items = [...m.entries()].map(([label, v]) => ({ label, v, text: money(v / rg.months) + " / mo" })).sort((a, b) => a.v - b.v).slice(0, 12);
  items.forEach(i => (i.onclick = () => goTransactions({ text: i.label })));
  $("#recurringPanel").replaceChildren(barRows(items));
}
function renderCash(rg) {
  const m = new Map();
  const ents = scopeEntities();
  data.rows.filter(r => ents.includes(r.entity) && r.date <= rg.to).forEach(r => { const k = r.account + "|" + r.cur; m.set(k, (m.get(k) || 0) + r.amount); });
  const items = [...m.entries()].filter(([, v]) => Math.abs(v) >= 0.5).map(([k, v]) => { const [a, c] = k.split("|"); return { label: a + " " + c.toLowerCase(), v, text: money(v, SYMBOL[c] || "") }; });
  $("#cashPanel").replaceChildren(barRows(items));
}
function renderTax(rg, f) {
  const cos = scopeEntities().filter(e => e !== "personal");
  const lines = [];
  cos.forEach(e => { const x = data.ent[e] || {}; lines.push({ label: (cos.length > 1 ? e + " " : "") + "corporation tax", text: x.rate == null ? "19–25%" : pct(x.rate || 0) }, { label: (cos.length > 1 ? e + " " : "") + "vat", text: x.vat || "–" }); });
  $("#taxPanel").replaceChildren(barRows(lines.concat([
    { label: "tax due on this period (estimate)", v: -f.tax, strong: true },
    { label: "tax paid in this period", v: f.taxPaid }
  ]), { noBars: true }));
}
function renderAttention(rg) {
  const check = sel(rg, r => r.category === "check").length;
  const wrong = sel(rg, r => WRONG_ACCOUNT.includes(r.category)).length;
  const noReceipt = sel(rg, r => r.group === "cost" && !r.receipt).length;
  const items = [
    { label: "transactions to categorise", text: String(check), urgent: check > 0, onclick: () => goTransactions({ category: "check" }) },
    { label: "costs paid from the wrong account", text: String(wrong), onclick: () => goTransactions({ only: "wrong" }) },
    { label: "costs with no receipt", text: String(noReceipt), onclick: () => goTransactions({ only: "receipt" }) }
  ];
  const t = data.tasks; if (t) {
    let open = 0; t.display.forEach((r, i) => { (r || []).forEach((v, j) => { const f = (t.fmt[i] || [])[j] || {}; if (lc(v) && !f.b && !f.s && i > 1) open++; }); });
    items.push({ label: "tasks left", text: String(open), onclick: () => showView(t.name) });
  }
  const fl = data.filings; if (fl) {
    let due = 0; fl.display.forEach(r => (r || []).forEach(v => { if (["to do", "confirm"].includes(lc(v))) due++; }));
    items.push({ label: "filings to do or confirm", text: String(due), urgent: due > 0, onclick: () => showView(fl.name) });
  }
  $("#attentionPanel").replaceChildren(barRows(items, { noBars: true }));
}

/* ---------- sheet tabs ---------- */
function goTransactions(f) {
  const rg = range();
  const ents = scopeEntities();
  Object.assign(txFilter, { text: "", category: "", account: "", only: null, entity: ents.length === 1 ? ents[0] : "", entities: ents.length > 1 ? ents : null, from: rg.from, to: rg.to }, f);
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
  if (txFilter.from) { const b = el("button", "chip", txFilter.from + " to " + txFilter.to); b.type = "button"; b.onclick = () => { txFilter.from = txFilter.to = ""; renderSheet(tab); }; head.append(b); }
  head.append(count);
  let t; search.oninput = () => { clearTimeout(t); t = setTimeout(() => { txFilter.text = search.value; draw(); }, 150); };

  const hdr = tab.display[data.head] || [];
  function draw() {
    grid.innerHTML = ""; $("#more").innerHTML = ""; if (more) more.disconnect();
    const thead = el("thead"), tr = el("tr"); for (let j = c0; j < cols; j++) tr.append(el("th", null, hdr[j] || "")); thead.append(tr); grid.append(thead);
    const q = lc(txFilter.text);
    const list = data.rows.filter(r => (!txFilter.from || (r.date >= txFilter.from && r.date <= txFilter.to)) && (!txFilter.entities || txFilter.entities.includes(r.entity)) && (!txFilter.entity || r.entity === txFilter.entity) && (!txFilter.account || r.account === txFilter.account)
      && (!txFilter.category || r.category === txFilter.category)
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
  $("#gate").hidden = true; $("#app").hidden = false; $("#tabbar").hidden = false;
  document.title = book.title;
  const tabs = $("#tabs"); tabs.innerHTML = "";
  ["dashboard"].concat(book.tabs.map(t => t.name)).forEach(n => {
    const b = el("button", null, n); b.type = "button"; b.setAttribute("role", "tab"); b.dataset.view = n;
    b.onclick = () => { if (n.toLowerCase() === "transactions") Object.assign(txFilter, { text: "", entity: "", entities: null, category: "", account: "", only: null, from: "", to: "" }); showView(n); };
    tabs.append(b);
  });
  $("#openInSheets").href = "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(book.id) + "/edit";
  try { Object.assign(dash, JSON.parse(localStorage.getItem(VIEW_KEY)) || {}); } catch {}
  showView(view);
}
function showGate() { $("#gate").hidden = false; $("#app").hidden = true; $("#tabbar").hidden = true; }

$("#signIn").addEventListener("click", () => {
  gateError("");
  requestToken(() => { const f = lastFile(); f ? loadBook(f.id) : openPicker(); });
});
$("#pickFile").addEventListener("click", () => { if (TEST) return; signedIn() ? openPicker() : requestToken(openPicker); });
$("#signOut").addEventListener("click", () => {
  if (auth.token && window.google && google.accounts) google.accounts.oauth2.revoke(auth.token, () => {});
  auth.token = null; book = null; data = null; setLastFile(null); showGate();
});
document.addEventListener("mousemove", e => {
  const tip = $("#tip"), t = e.target.closest && e.target.closest("[data-tip]");
  if (!t) { tip.hidden = true; return; }
  tip.innerHTML = t.dataset.tip.split("|").map(esc).join("<br>"); tip.hidden = false;
  tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px"; tip.style.top = (e.clientY + 14) + "px";
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && book && !TEST && !signedIn()) status("signed out. click sign out, then sign in again."); });

if (TEST) { book = TEST; start(); }
else loadScript("https://accounts.google.com/gsi/client").catch(() => gateError("google sign-in couldn't load. check your connection."));
