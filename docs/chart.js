/* NSE PDF Charts — chart.js
 * Draws one stock chart onto a 2D canvas context. Port of draw_chart() from
 * python_scripts/nse_chart_generator.py (TradingView light theme).
 */
const MS = {
  bg: "#FFFFFF", text: "#131722", textSec: "#787B86", textFaint: "#C0C3CC",
  border: "#E0E3EB", grid: "#F0F3FA", gridWeek: "#E0E3EB",
  up: "#2962FF", down: "#EF5350",
  ma10: "#FF9800", ma21: "#F23645", ma50: "#089981",
  rs: "#9C27B0", volMa: "#FF9800", volUp: "#26A69A", volDown: "#EF5350",
  h52: "#26A69A", l52: "#EF5350", arrow: "#FF6D00",
};
const CHART_W = 1740, CHART_H = 1000;
const MONO = "Menlo, Consolas, 'DejaVu Sans Mono', monospace";
const SANS = "Helvetica, Arial, 'DejaVu Sans', sans-serif";
const RUPEE = "\u20B9";
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function sma(arr, w) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= w) sum -= arr[i - w];
    if (i >= w - 1) out[i] = sum / w;
  }
  return out;
}

function niceTicks(min, max, count) {
  const span = max - min;
  if (!(span > 0)) return [min];
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(v);
  return ticks;
}

function fmtPrice(v) {
  return v >= 100
    ? RUPEE + Math.round(v).toLocaleString("en-IN")
    : RUPEE + v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  return String(d.getDate()).padStart(2, "0") + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
}

function dateKey(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function pill(ctx, x, y, text, bg, size) {
  ctx.font = `bold ${size}px ${MONO}`;
  const tw = ctx.measureText(text).width;
  const ph = size + 8, pw = tw + 12;
  ctx.fillStyle = bg;
  roundRect(ctx, x, y - ph / 2, pw, ph, 4);
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 6, y + 1);
}

/**
 * candles: [{date: Date, open, high, low, close, volume}] — full history (used for MAs / 52W)
 * opts: { symbol, name, displayFrom: Date, nifty: Map(dateKey -> close) | null, screenerDates: Set(dateKey) | null }
 * Returns summary stats for the PDF header.
 */
function drawChart(ctx, candles, opts) {
  const W = CHART_W, H = CHART_H;
  const closesAll = candles.map(c => c.close);
  const volsAll = candles.map(c => c.volume);
  const ma10All = sma(closesAll, 10), ma21All = sma(closesAll, 21), ma50All = sma(closesAll, 50);
  const vma20All = sma(volsAll, 20);

  // 52-week high/low from the last 365 days of full history
  const lastDate = candles[candles.length - 1].date;
  const yearAgo = new Date(lastDate.getTime() - 365 * 864e5);
  let h52 = -Infinity, l52 = Infinity;
  for (const c of candles) if (c.date >= yearAgo) { h52 = Math.max(h52, c.high); l52 = Math.min(l52, c.low); }

  let start = candles.findIndex(c => c.date >= opts.displayFrom);
  if (start < 0) start = 0;
  const cs = candles.slice(start);
  const n = cs.length;
  const opens = cs.map(c => c.open), highs = cs.map(c => c.high), lows = cs.map(c => c.low);
  const closes = cs.map(c => c.close), vols = cs.map(c => c.volume), dates = cs.map(c => c.date);
  const ma10 = ma10All.slice(start), ma21 = ma21All.slice(start), ma50 = ma50All.slice(start);
  const vma20 = vma20All.slice(start);

  // RS line vs NIFTY, normalised to 100 at display start
  let rs = null;
  if (opts.nifty && opts.nifty.size) {
    const niftyKeys = [...opts.nifty.keys()].sort();
    let last = null, k = 0;
    const aligned = dates.map(d => {
      const key = dateKey(d);
      while (k < niftyKeys.length && niftyKeys[k] <= key) { last = opts.nifty.get(niftyKeys[k]); k++; }
      return last;
    });
    const firstValid = aligned.find(v => v != null);
    if (firstValid) {
      const filled = aligned.map(v => (v == null ? firstValid : v));
      const ratio = closes.map((c, i) => c / filled[i]);
      rs = ratio.map(r => (r / ratio[0]) * 100);
    }
  }

  const pMin = Math.min(...lows), pMax = Math.max(...highs);
  const range = pMax - pMin || pMax * 0.01 || 1;
  const pad = range * 0.06;
  const sdSet = opts.screenerDates;
  const hasArrows = sdSet && dates.some(d => sdSet.has(dateKey(d)));
  const yMin = pMin - pad - (hasArrows ? range * 0.055 : 0);
  const yMax = pMax + pad * 2.2;

  // ── Layout ──
  const L = 18, R = W - 150, top = 92, bottom = H - 48;
  const priceH = (bottom - top) * 3.5 / 4.5;
  const pTop = top, pBot = top + priceH, vTop = pBot, vBot = bottom;
  const plotW = R - L;
  const X = i => L + ((i + 1) / (n + 6.5)) * plotW;
  const Y = v => pTop + ((yMax - v) / (yMax - yMin)) * priceH;
  const barPx = plotW / (n + 6.5);
  const cw = Math.max(0.60, Math.min(0.88, 90 / Math.max(n, 1))) * barPx;
  const wickW = Math.max(1.0, Math.min(1.8, 75 / Math.max(n, 1)));

  ctx.save();
  ctx.fillStyle = MS.bg;
  ctx.fillRect(0, 0, W, H);

  // ── Week separators ──
  ctx.strokeStyle = MS.gridWeek;
  ctx.lineWidth = 0.8;
  for (let i = 5; i < n; i += 5) {
    const x = Math.round(X(i - 0.5)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, pTop); ctx.lineTo(x, vBot); ctx.stroke();
  }

  // ── Price grid + right axis ticks ──
  ctx.font = `12px ${SANS}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const t of niceTicks(yMin, yMax, 7)) {
    const y = Math.round(Y(t)) + 0.5;
    ctx.strokeStyle = MS.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke();
    ctx.strokeStyle = MS.border;
    ctx.beginPath(); ctx.moveTo(R, y); ctx.lineTo(R + 5, y); ctx.stroke();
    ctx.fillStyle = MS.textSec;
    ctx.fillText(fmtPrice(t), R + 9, y);
  }

  // ── Clip to price panel ──
  ctx.save();
  ctx.beginPath(); ctx.rect(L, pTop, plotW, priceH); ctx.clip();

  // 52W lines
  ctx.setLineDash([8, 5]);
  ctx.lineWidth = 1.1;
  ctx.globalAlpha = 0.45;
  for (const [v, col] of [[h52, MS.h52], [l52, MS.l52]]) {
    ctx.strokeStyle = col;
    ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(R, Y(v)); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);

  // RS line (own scale)
  if (rs) {
    const rMin = Math.min(...rs), rMax = Math.max(...rs), rr = (rMax - rMin) || 1;
    const lo = rMin - rr * 0.5, hi = rMax + rr * 1.2;
    const RY = v => pTop + ((hi - v) / (hi - lo)) * priceH;
    for (let i = 0; i < n - 1; i++) {
      ctx.fillStyle = (rs[i] + rs[i + 1]) / 2 >= 100 ? MS.rs : MS.down;
      ctx.globalAlpha = 0.08;
      ctx.beginPath();
      ctx.moveTo(X(i), RY(rs[i])); ctx.lineTo(X(i + 1), RY(rs[i + 1]));
      ctx.lineTo(X(i + 1), RY(100)); ctx.lineTo(X(i), RY(100)); ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = MS.rs; ctx.lineWidth = 2; ctx.lineJoin = "round";
    ctx.beginPath();
    rs.forEach((v, i) => (i ? ctx.lineTo(X(i), RY(v)) : ctx.moveTo(X(i), RY(v))));
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Candles
  for (let i = 0; i < n; i++) {
    const col = closes[i] >= opens[i] ? MS.up : MS.down;
    const x = X(i);
    ctx.strokeStyle = col; ctx.lineWidth = wickW * 1.4;
    ctx.beginPath(); ctx.moveTo(x, Y(highs[i])); ctx.lineTo(x, Y(lows[i])); ctx.stroke();
    const bTop = Y(Math.max(opens[i], closes[i]));
    const bH = Math.max(Math.abs(Y(opens[i]) - Y(closes[i])), (range * 0.002 / (yMax - yMin)) * priceH, 1);
    ctx.fillStyle = col;
    ctx.fillRect(x - cw / 2, bTop, cw, bH);
  }

  // Screener arrows
  if (hasArrows) {
    ctx.fillStyle = MS.arrow;
    ctx.font = `bold 40px ${SANS}`;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    dates.forEach((d, i) => {
      if (sdSet.has(dateKey(d))) ctx.fillText("\u25B2", X(i), Y(lows[i] - range * 0.032));
    });
  }

  // Moving averages
  const maEnds = [];
  for (const [arr, col, lw] of [[ma10, MS.ma10, 2.2], [ma21, MS.ma21, 2.1], [ma50, MS.ma50, 2.6]]) {
    ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath();
    let started = false, lastV = NaN;
    arr.forEach((v, i) => {
      if (isNaN(v)) return;
      started ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v));
      started = true; lastV = v;
    });
    ctx.stroke();
    if (!isNaN(lastV)) maEnds.push([lastV, col]);
  }

  // Last price dotted line
  const lp = closes[n - 1];
  const lpCol = closes[n - 1] >= opens[n - 1] ? MS.up : MS.down;
  ctx.setLineDash([2, 3]); ctx.strokeStyle = lpCol; ctx.lineWidth = 1; ctx.globalAlpha = 0.55;
  ctx.beginPath(); ctx.moveTo(L, Y(lp)); ctx.lineTo(R, Y(lp)); ctx.stroke();
  ctx.setLineDash([]); ctx.globalAlpha = 1;
  ctx.restore(); // end clip

  // 52W labels, price + MA pills (right of last candle)
  const tagX = X(n - 0.5);
  ctx.font = `bold 11px ${MONO}`;
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  if (h52 <= yMax) { ctx.fillStyle = MS.h52; ctx.fillText("52W H", tagX, Y(h52)); }
  if (l52 >= yMin) { ctx.fillStyle = MS.l52; ctx.fillText("52W L", tagX, Y(l52)); }
  pill(ctx, tagX, Y(lp), fmtPrice(lp), lpCol, 13);
  const occupied = [Y(lp)];
  const GAP = 22;
  maEnds.sort((a, b) => b[0] - a[0]).forEach(([v, col]) => {
    let pos = Y(v);
    for (let pass = 0; pass < 4; pass++) {
      for (const o of occupied) {
        if (Math.abs(pos - o) < GAP) pos = pos >= o ? o + GAP : o - GAP;
      }
    }
    occupied.push(pos);
    pill(ctx, tagX, pos, fmtPrice(v), col, 11);
  });

  // OHLC + change line
  const chg = closes[n - 1] - closes[0];
  const chgPct = (chg / closes[0]) * 100;
  ctx.font = `13px ${MONO}`;
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillStyle = MS.textSec;
  ctx.fillText(`O ${fmtPrice(opens[n - 1])}   H ${fmtPrice(pMax)}   L ${fmtPrice(pMin)}   C ${fmtPrice(lp)}`, L + 8, pTop + 6);
  ctx.font = `bold 14px ${MONO}`;
  ctx.fillStyle = chg >= 0 ? MS.up : MS.down;
  ctx.fillText(`${chg >= 0 ? "\u25B2" : "\u25BC"} ${fmtPrice(Math.abs(chg))}  (${Math.abs(chgPct).toFixed(2)}%)`, L + plotW * 0.60, pTop + 6);

  // MA legend (top-left box)
  const legend = [["MA 10", MS.ma10], ["MA 21", MS.ma21], ["MA 50", MS.ma50]];
  ctx.font = `12px ${MONO}`;
  const lgX = L + 8, lgY = pTop + 30, itemW = 96;
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.strokeStyle = MS.border; ctx.lineWidth = 1;
  roundRect(ctx, lgX, lgY, itemW * 3 + 8, 26, 3); ctx.fill(); ctx.stroke();
  legend.forEach(([lbl, col], k) => {
    const x0 = lgX + 8 + k * itemW;
    ctx.strokeStyle = col; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.moveTo(x0, lgY + 13); ctx.lineTo(x0 + 24, lgY + 13); ctx.stroke();
    ctx.fillStyle = MS.textSec; ctx.textBaseline = "middle";
    ctx.fillText(lbl, x0 + 30, lgY + 14);
  });
  if (rs) {
    ctx.font = `bold 12px ${MONO}`;
    ctx.fillStyle = MS.rs; ctx.textAlign = "right"; ctx.textBaseline = "bottom";
    ctx.fillText(`RS ${rs[n - 1].toFixed(0)}`, R - 6, pBot - 4);
  }

  // ── Volume panel ──
  const vMax = Math.max(...vols);
  const sorted = [...vols].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * (sorted.length - 1)))];
  const vLim = Math.max(p95 * 3.5, vMax * 0.25) || 1;
  const VY = v => vBot - (v / vLim) * (vBot - vTop);
  ctx.font = `11px ${SANS}`;
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const volFmt = v => (vMax > 5e6 ? (v / 1e7).toFixed(1) + "Cr" : Math.round(v / 1e5) + "L");
  for (const t of niceTicks(0, vLim, 3)) {
    const y = Math.round(VY(t)) + 0.5;
    if (y < vTop + 6) continue;
    ctx.strokeStyle = MS.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke();
    ctx.fillStyle = MS.textSec; ctx.fillText(volFmt(t), R + 9, y);
  }
  ctx.globalAlpha = 0.6;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = closes[i] >= opens[i] ? MS.volUp : MS.volDown;
    const v = Math.min(vols[i], vLim * 0.98);
    ctx.fillRect(X(i) - (cw * 1.05) / 2, VY(v), cw * 1.05, vBot - VY(v));
  }
  ctx.globalAlpha = 0.95;
  ctx.strokeStyle = MS.volMa; ctx.lineWidth = 2;
  ctx.beginPath();
  let vs = false;
  vma20.forEach((v, i) => { if (isNaN(v)) return; vs ? ctx.lineTo(X(i), VY(v)) : ctx.moveTo(X(i), VY(v)); vs = true; });
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = MS.textFaint; ctx.font = `11px ${SANS}`;
  ctx.textBaseline = "top"; ctx.fillText("VOLUME", L + 8, vTop + 8);

  // Panel borders (bottom + right only)
  ctx.strokeStyle = MS.border; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(L, Math.round(pBot) + 0.5); ctx.lineTo(R, Math.round(pBot) + 0.5);
  ctx.moveTo(L, Math.round(vBot) + 0.5); ctx.lineTo(R, Math.round(vBot) + 0.5);
  ctx.moveTo(Math.round(R) + 0.5, pTop); ctx.lineTo(Math.round(R) + 0.5, vBot);
  ctx.stroke();

  // Month labels
  ctx.font = `13px ${SANS}`;
  ctx.fillStyle = MS.textSec; ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let i = 1; i < n; i++) {
    if (dates[i].getMonth() !== dates[i - 1].getMonth()) {
      const x = Math.round(X(i)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, vBot); ctx.lineTo(x, vBot + 5); ctx.stroke();
      ctx.fillText(`${MONTHS[dates[i].getMonth()]} '${String(dates[i].getFullYear()).slice(2)}`, x, vBot + 9);
    }
  }

  // Header: symbol · name ... period
  ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  ctx.font = `bold 56px ${MONO}`;
  ctx.fillStyle = MS.text;
  ctx.fillText(opts.symbol, L, 66);
  const sw = ctx.measureText(opts.symbol).width;
  if (opts.name && opts.name !== opts.symbol) {
    ctx.font = `30px ${SANS}`;
    ctx.fillStyle = MS.textSec;
    let name = opts.name;
    const maxW = R - L - sw - 300;
    while (ctx.measureText("  \u00B7  " + name).width > maxW && name.length > 4) name = name.slice(0, -2);
    if (name !== opts.name) name = name.trimEnd() + "\u2026";
    ctx.fillText("  \u00B7  " + name, L + sw, 60);
  }
  ctx.font = `13px ${SANS}`;
  ctx.fillStyle = MS.textSec; ctx.textAlign = "right";
  ctx.fillText(`${fmtDate(dates[0])} \u2013 ${fmtDate(dates[n - 1])}`, R, 60);
  ctx.restore();

  return { lastClose: lp, chgPct, high52: h52, low52: l52, bars: n };
}

if (typeof module !== "undefined") module.exports = { drawChart, CHART_W, CHART_H, dateKey };
