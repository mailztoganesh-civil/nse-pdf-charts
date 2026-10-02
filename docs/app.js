/* NSE PDF Charts — app.js
 * Static, browser-only version of the Replit "NSE PDF Chart Generator".
 * Data: self-hosted Cloudflare Worker (nse-charts-proxy) → Yahoo Finance.
 * Charts: canvas (chart.js). PDF: jsPDF. No backend needed — runs on GitHub Pages.
 */
const OHLC_API_BASE = "https://nse-charts-proxy.mailztoganesh.workers.dev";
const CONCURRENCY = 4;
const PART_SIZE = 200;            // charts per PDF file (keeps memory safe on phones/tablets)
const FETCH_RANGE = "2y";         // extra history so MA50 and 52W lines are complete

const NAME_BY_SYMBOL = new Map(NSE_SYMBOLS.map(([s, n]) => [s, n]));
const SYMBOL_COLS = ["symbol", "ticker", "stock", "nse_symbol", "nsecode", "nse code", "scrip", "nse", "stock name"];
const DATE_COLS = ["date", "screener date", "screenerdate", "screener_date", "signal date", "signal_date",
  "entry date", "entry_date", "trade date", "trade_date", "alert date", "alert_date", "scan date", "scan_date"];
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

const state = {
  symbols: [],                // ordered, unique
  screener: new Map(),        // SYMBOL -> Set(dateKey)
  months: 6,
  busy: false,
  links: [],
};

const $ = id => document.getElementById(id);
const els = {
  input: $("symInput"), suggest: $("suggest"), chips: $("chips"), count: $("symCount"),
  clear: $("clearBtn"), letters: $("letters"), addLetters: $("addLetters"),
  csv: $("csvFile"), csvNote: $("csvNote"), months: $("months"), title: $("pdfTitle"),
  go: $("generate"), progress: $("progress"), bar: $("bar"), status: $("statusText"),
  failed: $("failed"), preview: $("preview"), downloads: $("downloads"),
};

/* ───────────── Symbol handling ───────────── */
function normSymbol(s) {
  return String(s || "").trim().toUpperCase().replace(/^NSE:/, "").replace(/\.NS$/, "").replace(/\s+/g, "");
}

function addSymbols(list) {
  let added = 0;
  for (const raw of list) {
    const s = normSymbol(raw);
    if (s && !state.symbols.includes(s)) { state.symbols.push(s); added++; }
  }
  renderChips();
  return added;
}

function renderChips() {
  els.chips.innerHTML = "";
  const show = state.symbols.slice(0, 300);
  for (const s of show) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = s;
    if (state.screener.has(s)) chip.classList.add("has-dates");
    const x = document.createElement("button");
    x.type = "button"; x.setAttribute("aria-label", `Remove ${s}`); x.textContent = "\u00D7";
    x.onclick = () => { state.symbols = state.symbols.filter(v => v !== s); renderChips(); };
    chip.appendChild(x);
    els.chips.appendChild(chip);
  }
  if (state.symbols.length > show.length) {
    const more = document.createElement("span");
    more.className = "more";
    more.textContent = `+${state.symbols.length - show.length} more`;
    els.chips.appendChild(more);
  }
  const n = state.symbols.length;
  els.count.textContent = n ? `${n} stock${n > 1 ? "s" : ""}` : "No stocks added";
  els.clear.hidden = !n;
  els.go.disabled = !n || state.busy;
}

let activeIdx = -1;
function showSuggestions() {
  const q = els.input.value.trim().toUpperCase();
  els.suggest.innerHTML = "";
  activeIdx = -1;
  if (!q || /[,\s]/.test(q)) { els.suggest.hidden = true; return; }
  const starts = [], contains = [];
  for (const [s, n] of NSE_SYMBOLS) {
    if (s.startsWith(q)) starts.push([s, n]);
    else if (n.toUpperCase().includes(q)) contains.push([s, n]);
    if (starts.length >= 8) break;
  }
  const items = starts.concat(contains).slice(0, 8);
  if (!items.length) { els.suggest.hidden = true; return; }
  for (const [s, n] of items) {
    const li = document.createElement("li");
    li.innerHTML = `<b></b><span></span>`;
    li.querySelector("b").textContent = s;
    li.querySelector("span").textContent = n !== s ? n : "";
    li.onmousedown = e => { e.preventDefault(); pick(s); };
    els.suggest.appendChild(li);
  }
  els.suggest.hidden = false;
}

function pick(s) {
  addSymbols([s]);
  els.input.value = "";
  els.suggest.hidden = true;
  els.input.focus();
}

els.input.addEventListener("input", showSuggestions);
els.input.addEventListener("blur", () => setTimeout(() => (els.suggest.hidden = true), 150));
els.input.addEventListener("keydown", e => {
  const items = [...els.suggest.children];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!items.length) return;
    e.preventDefault();
    activeIdx = (activeIdx + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items.forEach((li, i) => li.classList.toggle("active", i === activeIdx));
  } else if (e.key === "Enter") {
    e.preventDefault();
    const v = els.input.value;
    if (activeIdx >= 0 && items[activeIdx]) pick(items[activeIdx].querySelector("b").textContent);
    else if (/[,\s]/.test(v.trim())) { addSymbols(v.split(/[,\s]+/)); els.input.value = ""; els.suggest.hidden = true; }
    else if (v.trim()) {
      // Exact symbol typed → use it; otherwise take the top suggestion; otherwise add as typed
      const typed = normSymbol(v);
      const exact = NAME_BY_SYMBOL.has(typed);
      pick(exact || !items.length ? typed : items[0].querySelector("b").textContent);
    }
  }
});
els.input.addEventListener("paste", e => {
  const text = (e.clipboardData || window.clipboardData).getData("text");
  if (/[,\s]/.test(text.trim())) {
    e.preventDefault();
    addSymbols(text.split(/[,\s]+/));
    els.input.value = "";
    els.suggest.hidden = true;
  }
});

els.clear.onclick = () => { state.symbols = []; state.screener.clear(); els.csvNote.textContent = ""; renderChips(); };

els.addLetters.onclick = () => {
  const letters = els.letters.value.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (!letters.length) return;
  const list = NSE_SYMBOLS.map(([s]) => s).filter(s => letters.some(l => s.startsWith(l)));
  const added = addSymbols(list);
  els.letters.value = "";
  flash(`Added ${added} stock${added === 1 ? "" : "s"} starting with ${letters.join(", ")}`);
};

/* ───────────── CSV import (screener files) ───────────── */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(v => v.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v.trim())) rows.push(row);
  return rows;
}

function parseDateFlexible(s) {
  s = String(s || "").trim().replace(/\s.*$/, "");
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return new Date(+m[1], +m[2] - 1, +m[3]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) return new Date(+m[3], +m[2] - 1, +m[1]); // DD-MM-YYYY (India)
  if ((m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{2,4})$/))) {
    const mon = MON[m[2].toUpperCase()];
    if (mon === undefined) return null;
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return new Date(y, mon, +m[1]);
  }
  return null;
}

els.csv.onchange = async () => {
  const file = els.csv.files[0];
  if (!file) return;
  const rows = parseCSV(await file.text());
  els.csv.value = "";
  if (rows.length < 2) { els.csvNote.textContent = "That CSV has no data rows."; return; }
  const head = rows[0].map(h => h.trim().toLowerCase());
  const sIdx = head.findIndex(h => SYMBOL_COLS.includes(h));
  const dIdx = head.findIndex(h => DATE_COLS.includes(h));
  if (sIdx < 0) {
    els.csvNote.textContent = `No symbol column found. Name one of the columns "Symbol" (found: ${rows[0].join(", ")}).`;
    return;
  }
  const list = [];
  let dated = 0;
  for (const r of rows.slice(1)) {
    const s = normSymbol(r[sIdx]);
    if (!s) continue;
    list.push(s);
    if (dIdx >= 0) {
      const d = parseDateFlexible(r[dIdx]);
      if (d) {
        if (!state.screener.has(s)) state.screener.set(s, new Set());
        state.screener.get(s).add(dateKey(d));
        dated++;
      }
    }
  }
  const added = addSymbols(list);
  els.csvNote.textContent = `${file.name}: added ${added} stocks` +
    (dIdx >= 0 ? `, ${dated} screener dates will show as \u25B2 markers.` : ". No date column, so no \u25B2 markers.");
};

/* ───────────── Options ───────────── */
els.months.addEventListener("click", e => {
  const b = e.target.closest("button[data-m]");
  if (!b) return;
  state.months = +b.dataset.m;
  [...els.months.children].forEach(x => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
});

function flash(msg) { els.csvNote.textContent = msg; }

/* ───────────── Data ───────────── */
function toISTDate(ts) {
  const d = new Date((ts + 19800) * 1000);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

async function fetchCandles(symbol, attempt = 0) {
  const url = `${OHLC_API_BASE}?symbol=${encodeURIComponent(symbol)}&range=${FETCH_RANGE}&interval=1d`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.candles || !json.candles.length) throw new Error(json.error || `HTTP ${res.status}`);
    const candles = json.candles
      .filter(c => c.open > 0 && c.close > 0)
      .map(c => ({ date: toISTDate(c.time), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 }));
    return { candles, longName: json.longName };
  } catch (err) {
    if (attempt < 1) { await new Promise(r => setTimeout(r, 1500)); return fetchCandles(symbol, attempt + 1); }
    throw err;
  } finally { clearTimeout(timer); }
}

async function fetchNifty() {
  for (const sym of ["^NSEI", "NIFTYBEES"]) {
    try {
      const { candles } = await fetchCandles(sym, 1);
      return new Map(candles.map(c => [dateKey(c.date), c.close]));
    } catch { /* try next */ }
  }
  return null;
}

/* ───────────── PDF ───────────── */
const PDF_BLUE = [41, 98, 255], PDF_SEC = [120, 123, 134], PDF_TEXT = [19, 23, 34], PDF_BORDER = [224, 227, 235];

function rs(v) { return "Rs." + v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function pageChrome(doc) {
  doc.setFillColor(...PDF_BLUE);
  doc.rect(0, 210 - 2.8, 297, 2.8, "F");
}

function coverPage(doc, title, count, part, parts) {
  pageChrome(doc);
  const now = new Date();
  doc.setFont("courier", "bold"); doc.setFontSize(28); doc.setTextColor(...PDF_TEXT);
  doc.text(title + (parts > 1 ? ` (part ${part} of ${parts})` : ""), 8, 60);
  doc.setDrawColor(...PDF_BLUE); doc.setLineWidth(0.5); doc.line(8, 66, 289, 66);
  doc.setFont("courier", "normal"); doc.setFontSize(11); doc.setTextColor(...PDF_SEC);
  doc.text("End-of-Day Candlestick Report - NSE Equity Stocks", 8, 75);
  doc.text(`Generated ${now.toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "long", year: "numeric" })}  ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`, 8, 81);
  doc.setFontSize(8.5);
  doc.text(`Stocks: ${count}  |  History: ${state.months} months  |  Indicators: Candlestick, MA10, MA21, MA50, RS vs NIFTY 50, Volume MA20  |  Source: Yahoo Finance`, 8, 92);
}

function chartPage(doc, item, idx, total) {
  doc.addPage();
  pageChrome(doc);
  const s = item.stats;
  const arrow = s.chgPct >= 0 ? "+" : "-";
  doc.setFont("courier", "normal"); doc.setFontSize(7.5); doc.setTextColor(...PDF_SEC);
  const name = item.name.length > 48 ? item.name.slice(0, 46) + ".." : item.name;
  doc.text(`${item.symbol}  |  ${name}  |  Close ${rs(s.lastClose)}  |  ${arrow}${Math.abs(s.chgPct).toFixed(2)}% (period)  |  52W H ${rs(s.high52)} / L ${rs(s.low52)}  |  #${idx} of ${total}`, 8, 11);
  doc.addImage(item.img, "JPEG", 8, 14, 281, 281 * CHART_H / CHART_W);
  const yLine = 14 + 281 * CHART_H / CHART_W + 2;
  doc.setDrawColor(...PDF_BORDER); doc.setLineWidth(0.15); doc.line(8, yLine, 289, yLine);
  doc.setFontSize(6.5);
  doc.text(`Daily OHLCV  |  MA10 (orange)  MA21 (red)  MA50 (teal)  |  RS line (purple) vs NIFTY 50  |  Blue = up  Red = down  |  Data: Yahoo Finance EOD  |  ${new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`, 8, yLine + 4);
}

function safeFile(s) { return s.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "NSE_Charts"; }

function saveDoc(doc, fileName) {
  const blob = doc.output("blob");
  const url = URL.createObjectURL(blob);
  state.links.push(url);
  const a = document.createElement("a");
  a.href = url; a.download = fileName; a.className = "dl";
  a.textContent = `Download ${fileName}  (${(blob.size / 1048576).toFixed(1)} MB)`;
  els.downloads.appendChild(a);
  a.click();
}

/* ───────────── Generate ───────────── */
async function generate() {
  if (state.busy || !state.symbols.length) return;
  state.busy = true;
  els.go.disabled = true;
  els.go.textContent = "Generating\u2026";
  state.links.forEach(u => URL.revokeObjectURL(u)); state.links = [];
  els.downloads.innerHTML = ""; els.failed.textContent = ""; els.failed.hidden = true;
  els.progress.hidden = false;

  const symbols = [...state.symbols];
  const title = els.title.value.trim() || "NSE Stock Charts";
  const total = symbols.length;
  const parts = Math.ceil(total / PART_SIZE);
  const failed = [];
  const setStatus = (done, msg) => {
    els.bar.style.width = `${(done / total) * 100}%`;
    els.status.textContent = msg;
  };

  setStatus(0, "Loading NIFTY 50 for the RS line\u2026");
  const nifty = await fetchNifty();

  const canvas = document.createElement("canvas");
  canvas.width = CHART_W; canvas.height = CHART_H;
  const ctx = canvas.getContext("2d");
  const pctx = els.preview.getContext("2d");
  const displayFromFor = candles => {
    const last = candles[candles.length - 1].date;
    return new Date(last.getTime() - state.months * 31 * 864e5);
  };

  let done = 0;
  for (let p = 0; p < parts; p++) {
    const chunk = symbols.slice(p * PART_SIZE, (p + 1) * PART_SIZE);
    const results = new Array(chunk.length);
    let next = 0;

    // Fetch with limited concurrency, render in completion order (canvas is shared, render is sync)
    const workers = Array.from({ length: Math.min(CONCURRENCY, chunk.length) }, async () => {
      while (next < chunk.length) {
        const i = next++;
        const sym = chunk[i];
        try {
          const { candles, longName } = await fetchCandles(sym);
          if (candles.length < 10) throw new Error("Not enough history");
          const name = (longName && longName !== sym ? longName : NAME_BY_SYMBOL.get(sym)) || sym;
          const stats = drawChart(ctx, candles, {
            symbol: sym, name, displayFrom: displayFromFor(candles),
            nifty, screenerDates: state.screener.get(sym) || null,
          });
          results[i] = { symbol: sym, name, stats, img: canvas.toDataURL("image/jpeg", 0.85) };
          pctx.drawImage(canvas, 0, 0, els.preview.width, els.preview.height);
          els.preview.hidden = false;
        } catch (err) {
          failed.push(`${sym} (${err.name === "AbortError" ? "timeout" : err.message})`);
        }
        done++;
        setStatus(done, `${done} of ${total} \u00B7 ${sym}`);
      }
    });
    await Promise.all(workers);

    const ok = results.filter(Boolean);
    if (ok.length) {
      setStatus(done, `Building PDF${parts > 1 ? ` part ${p + 1} of ${parts}` : ""}\u2026`);
      await new Promise(r => setTimeout(r, 30));
      const doc = new jspdf.jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
      coverPage(doc, title, ok.length, p + 1, parts);
      ok.forEach((item, k) => chartPage(doc, item, p * PART_SIZE + k + 1, total));
      const stamp = new Date().toISOString().slice(0, 10);
      saveDoc(doc, `${safeFile(title)}_${stamp}${parts > 1 ? `_part${p + 1}` : ""}.pdf`);
    }
  }

  const okCount = total - failed.length;
  setStatus(total, okCount
    ? `Done. ${okCount} chart${okCount === 1 ? "" : "s"} in the PDF${nifty ? "" : " (RS line skipped: NIFTY data unavailable)"}.`
    : "No charts could be generated. Check the symbols and try again.");
  if (failed.length) {
    els.failed.hidden = false;
    els.failed.textContent = `Skipped ${failed.length}: ${failed.join(", ")}`;
  }
  state.busy = false;
  els.go.textContent = "Generate PDF";
  els.go.disabled = !state.symbols.length;
}

els.go.onclick = generate;
renderChips();
