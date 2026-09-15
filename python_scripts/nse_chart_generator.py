"""
NSE EOD Chart PDF Generator — Core Engine
Generates candlestick charts for NSE stocks and assembles them into a PDF.
Used by the web app backend (called via CLI with progress JSON on stdout).
"""

# Startup heartbeat — emitted before any heavy imports so we know Python launched
import sys as _sys, json as _json
_sys.stdout.write(_json.dumps({"type":"startup","message":"Python interpreter started"}) + "\n")
_sys.stdout.flush()

import os, sys, json, time, random, logging, requests, zipfile, argparse
import threading
_sys.stdout.write(_json.dumps({"type":"startup","message":"stdlib imported"}) + "\n")
_sys.stdout.flush()

import numpy as np
import pandas as pd
_sys.stdout.write(_json.dumps({"type":"startup","message":"numpy/pandas imported"}) + "\n")
_sys.stdout.flush()

import matplotlib
matplotlib.use('Agg')
# Pre-create config dir so matplotlib never hangs trying to write to a restricted path
import os as _os
_mpl_dir = _os.environ.get("MPLCONFIGDIR", "/tmp/.matplotlib")
_os.makedirs(_mpl_dir, exist_ok=True)
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
_sys.stdout.write(_json.dumps({"type":"startup","message":"matplotlib imported"}) + "\n")
_sys.stdout.flush()

import yfinance as yf
_sys.stdout.write(_json.dumps({"type":"startup","message":"yfinance imported"}) + "\n")
_sys.stdout.flush()

from datetime import datetime, timedelta
from io import BytesIO
from reportlab.lib.pagesizes import A4, landscape
from reportlab.platypus import (SimpleDocTemplate, Image, Paragraph, Spacer, PageBreak)
from reportlab.platypus import HRFlowable
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.units import cm

logging.basicConfig(level=logging.WARNING)

RUPEE = '\u20b9'
DOT   = '\u00b7'
ENDASH = '\u2013'
EMDASH = '\u2014'
UP_ARROW   = '\u25b2'
DOWN_ARROW = '\u25bc'

CONFIG = {
    "batch_size"      : 100,
    "batch_delay_sec" : 1,
    "retry_attempts"  : 2,
    "retry_delay_sec" : 5,
    "chart_dpi"       : 100,
    "render_workers"  : 6,   # parallel chart renders
}

# Lock for matplotlib pyplot global state (figure creation/closing)
_plt_lock = threading.Lock()

MS = {
    # ── TradingView Light Theme (matches user's screenshot) ─────────────────
    "bg"           : "#FFFFFF",   # outer figure background
    "chart_bg"     : "#FFFFFF",   # plot area background
    "text"         : "#131722",   # primary labels / symbol name
    "text_sec"     : "#787B86",   # secondary / axis tick labels
    "text_faint"   : "#C0C3CC",   # very faint (VOL label)
    "border"       : "#E0E3EB",   # spine / separator lines
    "grid"         : "#F0F3FA",   # horizontal grid lines (very subtle)
    "grid_week"    : "#E0E3EB",   # vertical week-separator lines
    # ── Candles — blue up, red down (user's TradingView setting) ────────────
    "up"           : "#2962FF",   # TradingView blue (up candle)
    "down"         : "#EF5350",   # TradingView red  (down candle)
    # ── Moving Averages ──────────────────────────────────────────────────────
    "ma10"         : "#FF9800",   # orange (MA 10 — kept for reference)
    "ma21"         : "#F23645",   # red    (EMA 21 — matches screenshot)
    "ma50"         : "#089981",   # teal   (EMA 50 — matches screenshot)
    # ── Overlays ─────────────────────────────────────────────────────────────
    "rs_line"      : "#9C27B0",   # purple (RS vs NIFTY — distinct)
    "vol_ma"       : "#FF9800",   # amber
    "price_tag_bg" : "#2962FF",   # last-price pill (blue by default; overridden per candle)
    "price_tag_fg" : "#FFFFFF",
    "52wh"         : "#26A69A",
    "52wl"         : "#EF5350",
}


def emit(msg: dict):
    """Write a progress/status JSON line to stdout (read by Node backend)."""
    print(json.dumps(msg), flush=True)


def get_nse_symbols():
    """Fetch all NSE EQ symbols. Returns list of (yf_symbol, nse_symbol, company_name)."""
    symbols = []

    for days_back in range(0, 7):
        dt = datetime.today() - timedelta(days=days_back)
        if dt.weekday() >= 5:
            continue
        date_str = dt.strftime("%d%b%Y").upper()
        url = (f"https://nsearchives.nseindia.com/content/historical/EQUITIES/"
               f"{dt.year}/{dt.strftime('%b').upper()}/cm{date_str}bhav.csv.zip")
        try:
            headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.nseindia.com"}
            r = requests.get(url, headers=headers, timeout=20)
            if r.status_code == 200:
                with zipfile.ZipFile(BytesIO(r.content)) as z:
                    fname = [n for n in z.namelist() if n.endswith('.csv')][0]
                    df = pd.read_csv(z.open(fname))
                df = df[df['SERIES'] == 'EQ']
                for _, row in df.iterrows():
                    sym = str(row['SYMBOL']).strip()
                    name = str(row.get('NAME OF COMPANY', sym)).strip()
                    symbols.append((f"{sym}.NS", sym, name))
                return symbols
        except Exception:
            pass

    try:
        session = requests.Session()
        session.get("https://www.nseindia.com",
                    headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
        r = session.get(
            "https://www.nseindia.com/api/market-data-pre-open?key=ALL",
            headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.nseindia.com"},
            timeout=15)
        for item in r.json().get("data", []):
            md = item.get("metadata", {})
            sym = md.get("symbol", "").strip()
            name = md.get("companyName", sym).strip()
            if sym:
                symbols.append((f"{sym}.NS", sym, name))
        if symbols:
            return symbols
    except Exception:
        pass

    nifty500 = [
        "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","HINDUNILVR","ITC",
        "SBIN","BHARTIARTL","KOTAKBANK","LT","AXISBANK","ASIANPAINT","MARUTI",
        "SUNPHARMA","TITAN","BAJFINANCE","WIPRO","ONGC","NTPC","POWERGRID",
        "ULTRACEMCO","TECHM","NESTLEIND","HCLTECH","MM","BAJAJFINSV","COALINDIA",
        "TATAMOTORS","ADANIPORTS","TATASTEEL","JSWSTEEL","HINDALCO","GRASIM",
        "DRREDDY","CIPLA","BPCL","DIVISLAB","APOLLOHOSP","EICHERMOT","HEROMOTOCO",
        "BRITANNIA","TATACONSUM","INDUSINDBK","VEDL","SBILIFE","HDFCLIFE",
        "BAJAJ-AUTO","ADANIENT","PIDILITIND","HAVELLS","BERGEPAINT","DABUR",
        "MARICO","GODREJCP","COLPAL","BOSCHLTD","SIEMENS","ABB","AMBUJACEM",
        "ACC","SHREECEM","RAMCOCEM","INDUSTOWER","DLF","OBEROIRLTY","IRCTC",
        "CONCOR","ADANIGREEN","TATAPOWER","TORNTPOWER","CESC","IGL","MGL",
        "GAIL","PETRONET","IOC","HINDPETRO","ZOMATO","NYKAA","PAYTM",
        "DELHIVERY","LATENTVIEW","DIXON","AMBER","POLYCAB","KPRMILL","PAGEIND",
        "MUTHOOTFIN","CHOLAFIN","SHRIRAMFIN","SBICARD","BANDHANBNK","FEDERALBNK",
        "IDFCFIRSTB","YESBANK","PNB","BANKBARODA","CANARABANK","UNIONBANK",
        "LICHSGFIN","RECLTD","PFC","IRFC","NHPC","SJVN","CUMMINSIND",
        "THERMAX","BEL","HAL","BHEL","RVNL","IRCON","NBCC","HUDCO","GMRINFRA",
        "DEEPAKNTR","GNFC","GSPL","GUJGASLTD","MRF","BALKRISIND","APOLLOTYRE",
        "CEATLTD","EXIDEIND","TVSMOTOR","BHARATFORG","MOTHERSON","SONACOMS",
    ]
    for sym in nifty500:
        symbols.append((f"{sym}.NS", sym, sym))
    return symbols


def fetch_batch(symbols_yf, months=6):
    """Download OHLCV for a batch. Returns {symbol: DataFrame}."""
    end   = datetime.today() + timedelta(days=1)   # exclusive — +1 to include today
    start = end - timedelta(days=months * 31 + 1)
    results = {}

    for attempt in range(CONFIG["retry_attempts"]):
        try:
            raw = yf.download(
                symbols_yf,
                start=start.strftime("%Y-%m-%d"),
                end=end.strftime("%Y-%m-%d"),
                auto_adjust=True,
                group_by="ticker",
                threads=True,
                progress=False,
                timeout=30,
            )
            if len(symbols_yf) == 1:
                sym = symbols_yf[0]
                if not raw.empty:
                    # Single-ticker: yfinance returns multi-level columns (Ticker, Price)
                    # Flatten to single-level (Open, High, Low, Close, Volume)
                    raw = flatten_yfinance_columns(raw)
                    df = raw.dropna()
                    if len(df) >= 10:
                        results[sym] = df
            else:
                for sym in symbols_yf:
                    try:
                        df = raw[sym].dropna()
                        if len(df) >= 10:
                            results[sym] = df
                    except Exception:
                        pass
            return results
        except Exception:
            time.sleep(CONFIG["retry_delay_sec"])
    return results


def flatten_yfinance_columns(df):
    """Flatten yfinance columns regardless of MultiIndex level ordering."""
    if not isinstance(df.columns, pd.MultiIndex):
        return df

    price_columns = {"Open", "High", "Low", "Close", "Volume"}
    for level in range(df.columns.nlevels):
        values = {str(value) for value in df.columns.get_level_values(level)}
        if price_columns.issubset(values):
            df.columns = df.columns.get_level_values(level)
            break
    return df


def compute_ma(arr, window):
    result = np.full(len(arr), np.nan)
    for i in range(window - 1, len(arr)):
        result[i] = np.mean(arr[i - window + 1:i + 1])
    return result


def compute_rs_line(stock_closes, stock_dates, nifty_df):
    """Relative Strength vs NIFTY 50, normalised to 100 at period start."""
    if nifty_df is None or nifty_df.empty or 'Close' not in nifty_df.columns:
        return None
    try:
        nifty_close   = nifty_df['Close'].astype(float)
        stock_idx     = pd.DatetimeIndex(stock_dates)
        nifty_aligned = nifty_close.reindex(stock_idx, method='ffill').ffill().bfill()
        nifty_arr     = nifty_aligned.values.astype(float)
        if np.isnan(nifty_arr).all() or nifty_arr[0] == 0:
            return None
        rs = stock_closes / nifty_arr
        return (rs / rs[0]) * 100
    except Exception:
        return None


def draw_chart(symbol, name, df, nifty_df=None, screener_dates=None):
    """Returns MarketSmith-style candlestick chart as PNG BytesIO."""
    dates  = df.index.to_pydatetime()
    opens  = df['Open'].values.astype(float)
    highs  = df['High'].values.astype(float)
    lows   = df['Low'].values.astype(float)
    closes = df['Close'].values.astype(float)
    vols   = df['Volume'].values.astype(float)
    n      = len(dates)

    ma10     = compute_ma(closes, 10)
    ma21     = compute_ma(closes, 21)
    ma50     = compute_ma(closes, 50)
    vol_ma20 = compute_ma(vols, 20)
    rs_vals  = compute_rs_line(closes, dates, nifty_df)

    p_min = lows.min();  p_max = highs.max()
    price_range = p_max - p_min
    pad   = price_range * 0.06
    # Extra room at bottom if screener arrows are present
    arrow_pad = price_range * 0.055 if screener_dates else 0
    y_min = p_min - pad - arrow_pad
    y_max = p_max + pad * 2.2

    # Candle width adapts to bar density — kept wide for visibility
    w       = max(0.60, min(0.88, 90 / max(n, 1)))
    wick_lw = max(1.0,  min(1.8,  75 / max(n, 1)))

    # Week boundaries (every ~5 trading days)
    week_bdry = [i - 0.5 for i in range(1, n) if i % 5 == 0]

    # Month start indices for x-axis labels
    month_ticks = [i for i in range(n)
                   if i == 0 or dates[i].month != dates[i - 1].month]

    FONT     = 'DejaVu Sans'
    FONT_MONO= 'DejaVu Sans Mono'

    # ── Figure: 2 panels, TradingView light background ─────────────────────
    with _plt_lock:
        fig = plt.figure(figsize=(18, 9), dpi=CONFIG["chart_dpi"], facecolor=MS["bg"])
    gs  = fig.add_gridspec(
        2, 1, hspace=0.0,
        left=0.01, right=0.915, top=0.905, bottom=0.065,
        height_ratios=[3.5, 1.0]
    )
    ax1 = fig.add_subplot(gs[0, 0])
    ax2 = fig.add_subplot(gs[1, 0], sharex=ax1)
    for ax in (ax1, ax2):
        ax.set_facecolor(MS["chart_bg"])

    # ── Week separators ────────────────────────────────────────────────────
    for ax in (ax1, ax2):
        for wb in week_bdry:
            ax.axvline(wb, color=MS["grid_week"], linewidth=0.6,
                       linestyle='-', alpha=0.8, zorder=0)

    # ── Horizontal grid ────────────────────────────────────────────────────
    ax1.yaxis.grid(True, color=MS["grid"], linewidth=0.6, zorder=0)
    ax2.yaxis.grid(True, color=MS["grid"], linewidth=0.5, zorder=0)
    ax1.set_axisbelow(True);  ax2.set_axisbelow(True)

    # ── Candlesticks — solid up & down (TradingView default) ───────────────
    xs = np.arange(n)
    for i in range(n):
        is_up = closes[i] >= opens[i]
        col = MS["up"] if is_up else MS["down"]
        bh  = max(abs(closes[i] - opens[i]), price_range * 0.002)
        by  = min(opens[i], closes[i])
        ax1.plot([i, i], [lows[i], highs[i]], color=col,
                 linewidth=wick_lw, zorder=2, solid_capstyle='butt')
        ax1.add_patch(mpatches.Rectangle(
            (i - w/2, by), w, bh,
            facecolor=col, edgecolor=col, linewidth=0, zorder=3))

    # ── Screener-date up arrows ─────────────────────────────────────────────
    if screener_dates:
        # Convert to set of date strings "YYYY-MM-DD" for fast lookup
        sd_set = set()
        for d in screener_dates:
            if hasattr(d, 'strftime'):
                sd_set.add(d.strftime('%Y-%m-%d'))
            else:
                sd_set.add(str(d)[:10])
        arrow_gap  = price_range * 0.032   # gap below candle low
        arrow_col  = "#FF6D00"             # bright orange — stands out on both themes
        for i, dt in enumerate(dates):
            if dt.strftime('%Y-%m-%d') in sd_set:
                y_pos = lows[i] - arrow_gap
                ax1.annotate('▲',
                             xy=(i, y_pos),
                             ha='center', va='top',
                             fontsize=40, color=arrow_col,
                             fontweight='bold', zorder=6)

    # ── Moving Averages ─────────────────────────────────────────────────────
    ma_endpoints = []   # collect (value, color) for right-axis pills
    for ma_arr, col, lbl, lw in [
        (ma10, MS["ma10"], 'MA 10', 1.7),
        (ma21, MS["ma21"], 'MA 21', 1.6),
        (ma50, MS["ma50"], 'MA 50', 2.0),
    ]:
        valid = ~np.isnan(ma_arr)
        if valid.sum() >= 2:
            ax1.plot(xs[valid], ma_arr[valid], color=col, linewidth=lw,
                     label=lbl, zorder=4, alpha=0.95, solid_capstyle='round')
            ma_endpoints.append((ma_arr[valid][-1], col))

    # ── 52W High / Low reference lines ─────────────────────────────────────
    h52 = highs.max();  l52 = lows.min()
    ax1.axhline(h52, color=MS["52wh"], linewidth=0.8, linestyle='--', alpha=0.45, zorder=1)
    ax1.axhline(l52, color=MS["52wl"], linewidth=0.8, linestyle='--', alpha=0.45, zorder=1)
    ax1.text(n + 0.5, h52, '52W H', color=MS["52wh"], fontsize=7.5, va='center',
             fontweight='bold', fontfamily=FONT_MONO)
    ax1.text(n + 0.5, l52, '52W L', color=MS["52wl"], fontsize=7.5, va='center',
             fontweight='bold', fontfamily=FONT_MONO)

    # ── RS Line vs NIFTY (secondary y-axis overlay) ─────────────────────────
    if rs_vals is not None:
        ax_rs = ax1.twinx()
        ax_rs.set_facecolor('none')
        ax_rs.plot(xs, rs_vals, color=MS["rs_line"], linewidth=1.4, alpha=0.85, zorder=5,
                   solid_capstyle='round')
        ax_rs.fill_between(xs, rs_vals, 100,
                           where=(rs_vals >= 100), color=MS["rs_line"], alpha=0.08, zorder=1)
        ax_rs.fill_between(xs, rs_vals, 100,
                           where=(rs_vals < 100),  color=MS["down"],    alpha=0.08, zorder=1)
        rs_range = rs_vals.max() - rs_vals.min()
        ax_rs.set_ylim(rs_vals.min() - rs_range * 0.5,
                       rs_vals.max() + rs_range * 1.2)
        ax_rs.axis('off')
        ax_rs.set_xlim(-1, n + 5.5)
        ax1.text(0.995, 0.012, f'RS {rs_vals[-1]:.0f}',
                 transform=ax1.transAxes, color=MS["rs_line"],
                 fontsize=8, ha='right', va='bottom', fontfamily=FONT_MONO, fontweight='bold')

    # ── Last price tag + MA endpoint pills (right axis, TradingView style) ───
    lp     = closes[-1]
    lp_col = MS["up"] if closes[-1] >= opens[-1] else MS["down"]
    ax1.axhline(lp, color=lp_col, linewidth=0.6, linestyle=':', alpha=0.55, zorder=1)
    fmt_v  = lambda v: f'{RUPEE}{v:,.2f}' if v < 100 else f'{RUPEE}{v:,.0f}'
    # Current price pill
    ax1.text(n + 0.5, lp, fmt_v(lp),
             color=MS["price_tag_fg"], fontsize=8.5, va='center', fontweight='bold',
             fontfamily=FONT_MONO,
             bbox=dict(facecolor=lp_col, edgecolor='none', boxstyle='round,pad=0.28'))
    # MA endpoint pills — stacked neatly, no overlap with price pill
    occupied = [lp]
    for ma_val, ma_col in sorted(ma_endpoints, key=lambda x: -x[0]):
        # nudge if too close to an already-placed label
        pos = ma_val
        for occ in occupied:
            if abs(pos - occ) < price_range * 0.028:
                pos = occ - price_range * 0.030 if pos < occ else occ + price_range * 0.030
        occupied.append(pos)
        ax1.plot([n - 1, n + 0.2], [ma_val, ma_val],
                 color=ma_col, linewidth=0.5, linestyle=':', alpha=0.5, zorder=1)
        ax1.text(n + 0.5, pos, fmt_v(ma_val),
                 color='white', fontsize=7.5, va='center', fontweight='bold',
                 fontfamily=FONT_MONO,
                 bbox=dict(facecolor=ma_col, edgecolor='none', boxstyle='round,pad=0.22'))

    # ── OHLC & change annotation ────────────────────────────────────────────
    chg     = closes[-1] - closes[0]
    chg_pct = (chg / closes[0]) * 100
    arrow   = UP_ARROW if chg >= 0 else DOWN_ARROW
    chg_col = MS["up"] if chg >= 0 else MS["down"]
    fmt     = lambda v: f'{RUPEE}{v:,.0f}' if v >= 100 else f'{RUPEE}{v:,.2f}'
    info    = (f"O {fmt(opens[-1])}   "
               f"H {fmt(highs.max())}   "
               f"L {fmt(lows.min())}   "
               f"C {fmt(closes[-1])}")
    ax1.text(0.005, 0.984, info, transform=ax1.transAxes,
             color=MS["text_sec"], fontsize=8.5, va='top', fontfamily=FONT_MONO)
    ax1.text(0.60, 0.984, f"{arrow} {fmt(abs(chg))}  ({abs(chg_pct):.2f}%)",
             transform=ax1.transAxes, color=chg_col,
             fontsize=9, va='top', fontweight='bold', fontfamily=FONT_MONO)

    # ── Price axis (right side only) ────────────────────────────────────────
    ax1.tick_params(axis='y', colors=MS["text_sec"], labelsize=8.5,
                    right=True, labelright=True, labelleft=False,
                    length=4, width=0.5, pad=4, direction='out')
    ax1.yaxis.set_major_formatter(plt.FuncFormatter(
        lambda x, _: f'{RUPEE}{x:,.0f}' if x >= 100 else f'{RUPEE}{x:,.2f}'))
    ax1.tick_params(axis='x', bottom=False, labelbottom=False, length=0)
    ax1.set_ylim(y_min, y_max)
    ax1.set_xlim(-1, n + 5.5)

    # Spines — only keep right border (where price labels sit)
    ax1.spines['top'].set_visible(False)
    ax1.spines['left'].set_visible(False)
    ax1.spines['bottom'].set_color(MS["border"]); ax1.spines['bottom'].set_linewidth(0.5)
    ax1.spines['right'].set_color(MS["border"]);  ax1.spines['right'].set_linewidth(0.5)

    ax1.legend(facecolor=MS["bg"], edgecolor=MS["border"],
               labelcolor=MS["text_sec"], fontsize=8.5,
               loc='upper left', bbox_to_anchor=(0.005, 0.962),
               framealpha=0.90, borderpad=0.5, handlelength=1.8, ncol=3,
               prop={'family': FONT_MONO, 'size': 8.5})

    # ── Volume panel ───────────────────────────────────────────────────────
    vol_max   = vols.max()
    vol_p95   = np.percentile(vols, 95)
    vol_ylim  = max(vol_p95 * 3.5, vol_max * 0.25)

    VOL_UP   = "#26A69A"   # teal  — TradingView volume-up colour
    VOL_DOWN = "#EF5350"   # red   — TradingView volume-down colour
    for i in range(n):
        vc = VOL_UP if closes[i] >= opens[i] else VOL_DOWN
        ax2.bar(i, min(vols[i], vol_ylim * 0.98),
                color=vc, width=w * 1.05, alpha=0.60, zorder=2)

    valid_vma = ~np.isnan(vol_ma20)
    if valid_vma.any():
        ax2.plot(xs[valid_vma], vol_ma20[valid_vma], color=MS["vol_ma"],
                 linewidth=1.5, zorder=3, alpha=0.95)

    ax2.set_ylim(0, vol_ylim)
    ax2.yaxis.grid(True, color=MS["grid"], linewidth=0.5, zorder=0)
    ax2.set_axisbelow(True)
    ax2.tick_params(axis='y', colors=MS["text_sec"], labelsize=7.5,
                    right=True, labelright=True, labelleft=False,
                    length=3, width=0.5, direction='out')
    ax2.yaxis.set_major_formatter(plt.FuncFormatter(
        lambda x, _: f'{x/1e7:.1f}Cr' if vol_max > 5e6 else f'{x/1e5:.0f}L'))

    # Spines — match price panel
    ax2.spines['top'].set_visible(False)
    ax2.spines['left'].set_visible(False)
    ax2.spines['bottom'].set_color(MS["border"]); ax2.spines['bottom'].set_linewidth(0.5)
    ax2.spines['right'].set_color(MS["border"]);  ax2.spines['right'].set_linewidth(0.5)

    ax2.text(0.005, 0.88, 'VOLUME', transform=ax2.transAxes,
             color=MS["text_faint"], fontsize=7, va='top', fontfamily=FONT)

    # ── X-axis month labels ────────────────────────────────────────────────
    ax2.set_xticks(month_ticks)
    ax2.set_xticklabels(
        [dates[i].strftime("%b '%y") for i in month_ticks],
        color=MS["text_sec"], fontsize=8.5, fontfamily=FONT)
    ax2.tick_params(axis='x', length=4, width=0.5, color=MS["border"], direction='out')
    ax2.set_xlim(-1, n + 5.5)

    # ── Figure header ──────────────────────────────────────────────────────
    period = f"{dates[0].strftime('%d %b %Y')} {ENDASH} {dates[-1].strftime('%d %b %Y')}"
    fig.text(0.015, 0.963, symbol,
             color=MS["text"], fontsize=52, fontweight='bold', fontfamily=FONT_MONO)
    sym_w = len(symbol) * 0.028
    fig.text(0.015 + sym_w, 0.963, f'  {DOT}  {name}',
             color=MS["text_sec"], fontsize=36, fontfamily=FONT, va='center')
    fig.text(0.915, 0.963, period,
             color=MS["text_sec"], fontsize=8.5, ha='right', fontfamily=FONT, va='center')

    buf = BytesIO()
    with _plt_lock:
        fig.savefig(buf, format='png', dpi=CONFIG["chart_dpi"],
                    bbox_inches='tight', facecolor=MS["bg"])
        plt.close(fig)
    buf.seek(0)
    return buf


def build_pdf(chart_data, output_path, label="NSE Stock Charts"):
    BG     = colors.HexColor(MS["bg"])
    ORANGE = colors.HexColor(MS["price_tag_bg"])
    TEXT   = colors.HexColor(MS["text"])
    TSEC   = colors.HexColor(MS["text_sec"])
    BORD   = colors.HexColor(MS["border"])

    hdr_s = ParagraphStyle('hdr', fontSize=7.5,  fontName='Courier',      textColor=TSEC, leading=11)
    ftr_s = ParagraphStyle('ftr', fontSize=6.5,  fontName='Courier',      textColor=TSEC)
    cov_t = ParagraphStyle('ct',  fontSize=28,   fontName='Courier-Bold', textColor=TEXT, spaceAfter=10, leading=34)
    cov_s = ParagraphStyle('cs',  fontSize=11,   fontName='Courier',      textColor=TSEC, spaceAfter=5, leading=16)
    cov_n = ParagraphStyle('cn',  fontSize=8.5,  fontName='Courier',      textColor=TSEC)

    def add_bg(canvas, doc):
        canvas.saveState()
        canvas.setFillColor(BG)
        canvas.rect(0, 0, *landscape(A4), fill=1, stroke=0)
        canvas.setFillColor(ORANGE)
        canvas.rect(0, 0, landscape(A4)[0], 0.28*cm, fill=1, stroke=0)
        canvas.restoreState()

    doc = SimpleDocTemplate(output_path, pagesize=landscape(A4),
                            leftMargin=0.8*cm, rightMargin=0.8*cm,
                            topMargin=0.8*cm, bottomMargin=0.8*cm)
    story = []

    story.append(Spacer(1, 4.5*cm))
    story.append(Paragraph(label, cov_t))
    story.append(HRFlowable(width="100%", thickness=1.5, color=ORANGE, spaceAfter=12))
    story.append(Paragraph(f"End-of-Day Candlestick Report {EMDASH} NSE Equity Stocks", cov_s))
    story.append(Paragraph(
        f"Generated {datetime.today().strftime('%A, %d %B %Y')}  {DOT}  {datetime.today().strftime('%H:%M IST')}", cov_s))
    story.append(Spacer(1, 0.5*cm))
    story.append(Paragraph(
        f"Stocks: {len(chart_data)}  {DOT}  Indicators: Candlestick {DOT} MA10 {DOT} MA21 {DOT} MA50 {DOT} RS vs NIFTY {DOT} Volume MA20  {DOT}  Source: Yahoo Finance",
        cov_n))
    story.append(PageBreak())

    total = len(chart_data)
    for idx, item in enumerate(chart_data, 1):
        arrow = UP_ARROW if item['chg_pct'] >= 0 else DOWN_ARROW
        story.append(Paragraph(
            f"<b>{item['symbol']}</b>  {DOT}  {item['name']}  {DOT}  "
            f"Close {RUPEE}{item['last_close']:,.2f}  {DOT}  "
            f"{arrow} {abs(item['chg_pct']):.2f}% (period)  {DOT}  "
            f"52W H {RUPEE}{item['high_52w']:,.2f}  /  L {RUPEE}{item['low_52w']:,.2f}  {DOT}  "
            f"#{idx} of {total}", hdr_s))
        story.append(Spacer(1, 0.10*cm))
        story.append(Image(item['img_buf'], width=27.5*cm, height=15.8*cm))
        story.append(Spacer(1, 0.08*cm))
        story.append(HRFlowable(width="100%", thickness=0.4, color=BORD, spaceAfter=3))
        story.append(Paragraph(
            f"Daily OHLCV  {DOT}  MA10 (orange) MA21 (green) MA50 (purple)  {DOT}  "
            f"RS Line (blue) vs NIFTY 50  {DOT}  Hollow=Up  Filled=Down  {DOT}  "
            f"Data: Yahoo Finance EOD  {DOT}  {datetime.today().strftime('%d %b %Y')}", ftr_s))
        story.append(PageBreak())

    doc.build(story, onFirstPage=add_bg, onLaterPages=add_bg)


def _render_worker(args):
    """
    Module-level worker for ProcessPoolExecutor — must be picklable.
    Receives raw data, returns (status, sym_yf, sym_nse, name, img_bytes, stats_or_None).
    """
    sym_yf, sym_nse, name, df_dict, nifty_dict, s_dates = args
    try:
        import matplotlib
        matplotlib.use('Agg')
        df      = pd.DataFrame(df_dict)
        df.index = pd.to_datetime(df.index)
        nifty_df = None
        if nifty_dict:
            nifty_df = pd.DataFrame(nifty_dict)
            nifty_df.index = pd.to_datetime(nifty_df.index)
        closes = df['Close'].values.astype(float)
        highs  = df['High'].values.astype(float)
        lows   = df['Low'].values.astype(float)
        chg_pct = ((closes[-1] - closes[0]) / closes[0]) * 100
        buf = draw_chart(sym_yf, name, df, nifty_df=nifty_df, screener_dates=s_dates)
        return ("ok", sym_yf, sym_nse, name, buf.read(), {
            "last_close": round(float(closes[-1]), 2),
            "chg_pct"   : round(chg_pct, 2),
            "high_52w"  : round(float(highs.max()), 2),
            "low_52w"   : round(float(lows.min()), 2),
        })
    except Exception as exc:
        return ("error", sym_yf, sym_nse, name, None, str(exc))


def run_generate(symbol_list, output_path, history_months=6, pdf_label="NSE Stock Charts",
                 sym_screener_dates=None, chart_dir=None):
    """
    Generate PDF for a list of (yf_symbol, nse_symbol, name) tuples.
    Emits JSON progress lines to stdout.
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    if chart_dir:
        os.makedirs(chart_dir, exist_ok=True)
    total  = len(symbol_list)
    chart_data = []
    chart_manifest = []
    failed = []
    done   = 0

    emit({"type": "progress", "done": 0, "total": total, "message": "Starting..."})

    # Fetch NIFTY 50 once upfront for the RS Line indicator
    nifty_df = None
    try:
        n_end   = datetime.today() + timedelta(days=1)   # exclusive — +1 to include today
        n_start = n_end - timedelta(days=history_months * 31 + 31)
        nraw = yf.download(
            "^NSEI",
            start=n_start.strftime("%Y-%m-%d"),
            end=n_end.strftime("%Y-%m-%d"),
            auto_adjust=True, progress=False, timeout=20)
        if not nraw.empty:
            nraw = flatten_yfinance_columns(nraw)
            nifty_df = nraw
            emit({"type": "progress", "done": 0, "total": total, "message": "NIFTY 50 loaded for RS Line"})
    except Exception:
        pass  # RS line will be skipped if NIFTY unavailable

    # ── Step 1: fetch all OHLCV data in batches ─────────────────────────────
    all_data = {}  # sym_yf -> DataFrame
    batches = [symbol_list[i:i+CONFIG["batch_size"]]
               for i in range(0, len(symbol_list), CONFIG["batch_size"])]

    emit({"type": "progress", "done": 0, "total": total, "message": "Downloading price data..."})
    for b_idx, batch in enumerate(batches):
        sym_yf_list = [s[0] for s in batch]
        data = fetch_batch(sym_yf_list, history_months)
        all_data.update(data)
        if b_idx < len(batches) - 1:
            time.sleep(CONFIG["batch_delay_sec"] + random.uniform(0, 1))

    emit({"type": "progress", "done": 0, "total": total, "message": "Rendering charts..."})

    # ── Step 2: render charts sequentially ───────────────────────────────────
    for sym_yf, sym_nse, name in symbol_list:
        done += 1
        if sym_yf not in all_data or all_data[sym_yf].empty:
            failed.append((sym_yf, sym_nse, name))
            emit({"type": "progress", "done": done, "total": total,
                  "message": f"No data: {sym_nse}", "symbol": sym_nse})
            continue
        try:
            df      = all_data[sym_yf]
            closes  = df['Close'].values.astype(float)
            highs   = df['High'].values.astype(float)
            lows    = df['Low'].values.astype(float)
            chg_pct = ((closes[-1] - closes[0]) / closes[0]) * 100
            s_dates = (sym_screener_dates or {}).get(sym_nse) or \
                      (sym_screener_dates or {}).get(sym_yf)
            img_buf = draw_chart(sym_yf, name, df, nifty_df=nifty_df,
                                 screener_dates=s_dates)
            if chart_dir:
                with open(os.path.join(chart_dir, f"{sym_nse}.png"), "wb") as chart_file:
                    chart_file.write(img_buf.getvalue())
            chart_data.append({
                "symbol"    : sym_nse,
                "name"      : name,
                "img_buf"   : img_buf,
                "last_close": round(float(closes[-1]), 2),
                "chg_pct"   : round(chg_pct, 2),
                "high_52w"  : round(float(highs.max()), 2),
                "low_52w"   : round(float(lows.min()), 2),
            })
            chart_manifest.append({
                "symbol": sym_nse,
                "name": name,
                "lastClose": round(float(closes[-1]), 2),
                "chgPct": round(chg_pct, 2),
                "high52w": round(float(highs.max()), 2),
                "low52w": round(float(lows.min()), 2),
            })
            emit({"type": "progress", "done": done, "total": total,
                  "message": f"Charted {sym_nse}", "symbol": sym_nse})
        except Exception:
            failed.append((sym_yf, sym_nse, name))
            emit({"type": "progress", "done": done, "total": total,
                  "message": f"Chart error: {sym_nse}", "symbol": sym_nse})

    if failed:
        for sym_yf, sym_nse, name in failed:
            try:
                data = fetch_batch([sym_yf], history_months)
                if sym_yf in data and not data[sym_yf].empty:
                    df      = data[sym_yf]
                    closes  = df['Close'].values.astype(float)
                    highs   = df['High'].values.astype(float)
                    lows    = df['Low'].values.astype(float)
                    chg_pct = ((closes[-1] - closes[0]) / closes[0]) * 100
                    s_dates = (sym_screener_dates or {}).get(sym_nse) or \
                              (sym_screener_dates or {}).get(sym_yf)
                    img_buf = draw_chart(sym_yf, name, df, nifty_df=nifty_df,
                                        screener_dates=s_dates)
                    if chart_dir:
                        with open(os.path.join(chart_dir, f"{sym_nse}.png"), "wb") as chart_file:
                            chart_file.write(img_buf.getvalue())
                    chart_data.append({
                        "symbol"    : sym_nse,
                        "name"      : name,
                        "img_buf"   : img_buf,
                        "last_close": round(float(closes[-1]), 2),
                        "chg_pct"   : round(chg_pct, 2),
                        "high_52w"  : round(float(highs.max()), 2),
                        "low_52w"   : round(float(lows.min()), 2),
                    })
                    chart_manifest.append({
                        "symbol": sym_nse,
                        "name": name,
                        "lastClose": round(float(closes[-1]), 2),
                        "chgPct": round(chg_pct, 2),
                        "high52w": round(float(highs.max()), 2),
                        "low52w": round(float(lows.min()), 2),
                    })
                time.sleep(3)
            except Exception:
                pass

    if chart_data:
        chart_data.sort(key=lambda x: x['symbol'])
        if chart_dir:
            chart_manifest.sort(key=lambda x: x["symbol"])
            with open(os.path.join(chart_dir, "manifest.json"), "w", encoding="utf-8") as manifest_file:
                json.dump(chart_manifest, manifest_file)
        emit({"type": "building_pdf", "done": total, "total": total,
              "message": f"Building PDF for {len(chart_data)} charts..."})
        build_pdf(chart_data, output_path, pdf_label)
        emit({"type": "complete", "output": output_path, "charted": len(chart_data),
              "failed": len(failed)})
    else:
        emit({"type": "error", "message": "No charts generated — check symbol list or network."})


def _load_screener_dates_file(path):
    """Load and invert a screener dates JSON file (date→[symbols] → symbol→[dates])."""
    sym_dates = {}
    if path and os.path.exists(path):
        try:
            date_to_syms = json.loads(open(path).read())
            for date_str, syms in date_to_syms.items():
                for sym in syms:
                    sym_dates.setdefault(sym, []).append(date_str)
            try:
                os.remove(path)
            except Exception:
                pass
        except Exception as e:
            logging.warning(f"Could not load screener dates file: {e}")
    return sym_dates


def _run_job(spec):
    """Execute one job from a spec dict. Used by both CLI and worker modes."""
    mode           = spec.get("mode", "filtered")
    output_path    = spec["output"]
    history_months = spec.get("historyMonths", 6)
    label          = spec.get("label", "NSE Stock Charts")
    screener_file  = spec.get("screenerDatesFile", "")
    chart_dir      = spec.get("chartDir", "")
    sym_screener_dates = _load_screener_dates_file(screener_file)

    if mode == "all":
        emit({"type": "progress", "done": 0, "total": 1, "message": "Fetching NSE symbol list..."})
        symbol_list = get_nse_symbols()
        symbol_list.sort(key=lambda x: x[1])
        letters = spec.get("letters", "").strip().upper()
        if letters:
            if '-' in letters and len(letters) == 3:
                start_l, end_l = letters[0], letters[2]
                allowed = set(chr(c) for c in range(ord(start_l), ord(end_l) + 1))
            else:
                allowed = set(l.strip() for l in letters.split(',') if l.strip())
            symbol_list = [s for s in symbol_list if s[1] and s[1][0].upper() in allowed]
        emit({"type": "progress", "done": 0, "total": len(symbol_list),
              "message": f"Found {len(symbol_list)} NSE symbols"})
        run_generate(symbol_list, output_path, history_months, label,
                     sym_screener_dates=sym_screener_dates or None,
                     chart_dir=chart_dir)
    else:
        syms = [s.strip().upper() for s in spec.get("symbols", "").split(',') if s.strip()]
        if not syms:
            emit({"type": "error", "message": "No symbols provided for filtered mode"})
            return
        symbol_list = [(f"{s}.NS", s, s) for s in syms]
        run_generate(symbol_list, output_path, history_months, label,
                     sym_screener_dates=sym_screener_dates or None,
                     chart_dir=chart_dir)


def worker_loop():
    """
    Persistent worker mode — imports happen once, then jobs are read from stdin.
    Each job is a single JSON line. Progress/complete are written to stdout as usual.
    """
    emit({"type": "ready", "message": "Worker ready — all imports done"})
    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        try:
            spec = json.loads(raw_line)
        except Exception as e:
            emit({"type": "error", "message": f"Invalid job JSON: {e}"})
            continue
        try:
            _run_job(spec)
        except Exception as e:
            emit({"type": "error", "message": f"Job failed: {e}"})
        # After emitting complete/error, loop back and wait for the next job


def main():
    parser = argparse.ArgumentParser(description='NSE Chart PDF Generator')
    parser.add_argument('--worker', action='store_true',
                        help='Run as persistent worker (reads jobs from stdin)')
    parser.add_argument('--mode', choices=['all', 'filtered'])
    parser.add_argument('--output', default='', help='Output PDF path')
    parser.add_argument('--symbols', default='')
    parser.add_argument('--history-months', type=int, default=6)
    parser.add_argument('--label', default='NSE Stock Charts')
    parser.add_argument('--letters', default='')
    parser.add_argument('--screener-dates-file', default='')
    args = parser.parse_args()

    if args.worker:
        worker_loop()
        return

    # Legacy single-job CLI mode
    if not args.mode:
        print("--mode is required unless --worker is specified", file=sys.stderr)
        sys.exit(1)

    spec = {
        "mode"              : args.mode,
        "output"            : args.output,
        "historyMonths"     : args.history_months,
        "label"             : args.label,
        "letters"           : args.letters,
        "symbols"           : args.symbols,
        "screenerDatesFile" : args.screener_dates_file,
        "chartDir"          : "",
    }
    _run_job(spec)


if __name__ == '__main__':
    main()
