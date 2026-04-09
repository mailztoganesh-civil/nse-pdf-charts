"""
NSE EOD Chart PDF Generator — Core Engine
Generates candlestick charts for NSE stocks and assembles them into a PDF.
Used by the web app backend (called via CLI with progress JSON on stdout).
"""

import os, sys, json, time, random, logging, requests, zipfile, argparse
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import yfinance as yf

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
    "chart_dpi"       : 120,
}

CLAUDE = {
    "bg"        : "#F4F3EE",
    "white"     : "#FFFFFF",
    "orange"    : "#C15F3C",
    "cloudy"    : "#B1ADA1",
    "text"      : "#1A1A18",
    "text_sec"  : "#6B6860",
    "text_faint": "#A09C92",
    "border"    : "#E5E3DC",
    "chart_bg"  : "#FAFAF7",
    "up"        : "#1E8449",
    "up_alpha"  : "#1E8449",
    "down"      : "#C0392B",
    "down_alpha": "#C0392B",
    "ma20"      : "#D4600A",
    "ma50"      : "#7B70C7",
    "vol_ma"    : "#4A9ECA",
    "rsi_line"  : "#C15F3C",
    "grid"      : "#E5E3DC",
    "grid_month": "#D0CCC4",
    "52wh"      : "#1E8449",
    "52wl"      : "#C0392B",
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
    end   = datetime.today()
    start = end - timedelta(days=months * 31)
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
                    if isinstance(raw.columns, pd.MultiIndex):
                        raw.columns = raw.columns.get_level_values(1)
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


def compute_ma(arr, window):
    result = np.full(len(arr), np.nan)
    for i in range(window - 1, len(arr)):
        result[i] = np.mean(arr[i - window + 1:i + 1])
    return result


def compute_rsi(closes, period=14):
    deltas = np.diff(closes)
    gains  = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)
    rsi    = np.full(len(closes), np.nan)
    if len(gains) < period:
        return rsi
    avg_gain = np.mean(gains[:period])
    avg_loss = np.mean(losses[:period])
    for i in range(period, len(closes)):
        avg_gain = (avg_gain * (period - 1) + gains[i - 1]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i - 1]) / period
        rs = avg_gain / avg_loss if avg_loss != 0 else 1e9
        rsi[i] = 100 - (100 / (1 + rs))
    return rsi


def draw_chart(symbol, name, df):
    """Returns candlestick chart as PNG BytesIO."""
    dates  = df.index.to_pydatetime()
    opens  = df['Open'].values.astype(float)
    highs  = df['High'].values.astype(float)
    lows   = df['Low'].values.astype(float)
    closes = df['Close'].values.astype(float)
    vols   = df['Volume'].values.astype(float)
    n      = len(dates)

    ma20 = compute_ma(closes, 20)
    ma50 = compute_ma(closes, 50)
    rsi  = compute_rsi(closes, 14)
    vol_ma20 = compute_ma(vols, 20)

    p_min  = lows.min();  p_max = highs.max()
    price_range = p_max - p_min
    pad    = price_range * 0.06
    y_min  = p_min - pad
    y_max  = p_max + pad * 2.5

    high_52w = highs.max()
    low_52w  = lows.min()

    # Candle width scales with bar count: tighter when more bars
    w = max(0.35, min(0.65, 60 / max(n, 1)))

    # Month boundary indices for vertical gridlines
    month_boundaries = []
    prev_month = None
    for i, d in enumerate(dates):
        if d.month != prev_month:
            if i > 0:
                month_boundaries.append(i - 0.5)
            prev_month = d.month

    fig = plt.figure(figsize=(20, 10), dpi=CONFIG["chart_dpi"], facecolor=CLAUDE["bg"])

    # 3-panel layout: price (60%), RSI (18%), volume (22%)
    gs = fig.add_gridspec(
        5, 1, hspace=0.0,
        left=0.055, right=0.935, top=0.895, bottom=0.065,
        height_ratios=[3, 0.01, 1, 0.01, 1.15]
    )
    ax1  = fig.add_subplot(gs[0, 0])          # price
    ax_r = fig.add_subplot(gs[2, 0], sharex=ax1)  # RSI
    ax2  = fig.add_subplot(gs[4, 0], sharex=ax1)  # volume

    for ax in (ax1, ax_r, ax2):
        ax.set_facecolor(CLAUDE["chart_bg"])

    # ── Vertical month separators ──────────────────────────────────────────
    for ax in (ax1, ax_r, ax2):
        for mb in month_boundaries:
            ax.axvline(mb, color=CLAUDE["grid_month"], linewidth=0.7,
                       linestyle='--', alpha=0.7, zorder=0)

    # ── 52W H/L reference lines ────────────────────────────────────────────
    if high_52w > y_min:
        ax1.axhline(high_52w, color=CLAUDE["52wh"], linewidth=0.8,
                    linestyle=':', alpha=0.55, zorder=1)
        ax1.text(n + 0.6, high_52w, f'52W H', color=CLAUDE["52wh"],
                 fontsize=7.5, va='center', fontweight='bold')
    if low_52w < y_max:
        ax1.axhline(low_52w, color=CLAUDE["52wl"], linewidth=0.8,
                    linestyle=':', alpha=0.55, zorder=1)
        ax1.text(n + 0.6, low_52w, f'52W L', color=CLAUDE["52wl"],
                 fontsize=7.5, va='center', fontweight='bold')

    # ── Candlestick bodies & wicks ─────────────────────────────────────────
    wick_lw = max(0.6, min(1.1, 45 / max(n, 1)))
    for i in range(n):
        is_up = closes[i] >= opens[i]
        col   = CLAUDE["up"] if is_up else CLAUDE["down"]
        # Wick
        ax1.plot([i, i], [lows[i], highs[i]], color=col,
                 linewidth=wick_lw, zorder=2, solid_capstyle='round')
        # Body
        bh = max(abs(closes[i] - opens[i]), price_range * 0.0015)
        by = min(opens[i], closes[i])
        if is_up:
            ax1.add_patch(mpatches.Rectangle(
                (i - w/2, by), w, bh,
                facecolor=col, edgecolor=col, linewidth=0.3, zorder=3, alpha=0.90))
        else:
            ax1.add_patch(mpatches.Rectangle(
                (i - w/2, by), w, bh,
                facecolor=col, edgecolor=col, linewidth=0.3, zorder=3, alpha=0.85))

    # ── Moving averages ────────────────────────────────────────────────────
    valid20 = ~np.isnan(ma20)
    valid50 = ~np.isnan(ma50)
    xs = np.arange(n)
    if valid20.any():
        ax1.plot(xs[valid20], ma20[valid20], color=CLAUDE["ma20"],
                 linewidth=1.7, label='MA 20', zorder=4, alpha=0.92)
    if valid50.any():
        ax1.plot(xs[valid50], ma50[valid50], color=CLAUDE["ma50"],
                 linewidth=1.5, label='MA 50', zorder=4, alpha=0.85, linestyle='--')

    # ── Last price tag ─────────────────────────────────────────────────────
    lp = closes[-1]
    ax1.axhline(lp, color=CLAUDE["orange"], linewidth=0.75, linestyle=':', alpha=0.5, zorder=1)
    ax1.text(n + 0.5, lp, f'{RUPEE}{lp:,.2f}',
             color=CLAUDE["white"], fontsize=8.5, va='center', fontweight='bold',
             bbox=dict(facecolor=CLAUDE["orange"], edgecolor='none',
                       boxstyle='round,pad=0.32'))

    # ── Price change annotation ────────────────────────────────────────────
    chg     = closes[-1] - closes[0]
    chg_pct = (chg / closes[0]) * 100
    arrow   = UP_ARROW if chg >= 0 else DOWN_ARROW
    chg_col = CLAUDE["up"] if chg >= 0 else CLAUDE["down"]
    info = (f"O {RUPEE}{opens[-1]:,.2f}   {DOT}   H {RUPEE}{highs.max():,.2f}   {DOT}   "
            f"L {RUPEE}{lows.min():,.2f}   {DOT}   C {RUPEE}{closes[-1]:,.2f}")
    ax1.text(0.005, 0.978, info, transform=ax1.transAxes,
             color=CLAUDE["text_sec"], fontsize=8, va='top',
             fontfamily='monospace')
    ax1.text(0.60, 0.978, f"{arrow} {RUPEE}{abs(chg):,.2f}  ({abs(chg_pct):.2f}%)",
             transform=ax1.transAxes, color=chg_col,
             fontsize=8.5, va='top', fontweight='bold')

    # ── Price axis styling ─────────────────────────────────────────────────
    ax1.yaxis.grid(True, color=CLAUDE["grid"], linewidth=0.5, linestyle='-', zorder=0)
    ax1.xaxis.grid(False)
    ax1.set_axisbelow(True)
    for spine in ax1.spines.values():
        spine.set_color(CLAUDE["border"]); spine.set_linewidth(0.7)
    ax1.tick_params(axis='y', colors=CLAUDE["text_sec"], labelsize=8.5,
                    right=True, labelright=True, labelleft=False,
                    length=3, width=0.5, pad=3)
    ax1.yaxis.set_major_formatter(plt.FuncFormatter(
        lambda x, _: f'{RUPEE}{x:,.0f}' if x >= 100 else f'{RUPEE}{x:,.2f}'))
    ax1.tick_params(axis='x', bottom=False, labelbottom=False, length=0)
    ax1.set_ylim(y_min, y_max)
    ax1.set_xlim(-1, n + 5.5)
    ax1.legend(facecolor=CLAUDE["white"], edgecolor=CLAUDE["border"],
               labelcolor=CLAUDE["text_sec"], fontsize=8.5,
               loc='upper left', bbox_to_anchor=(0.005, 0.91),
               framealpha=0.95, borderpad=0.5, handlelength=1.8)

    # ── RSI panel ──────────────────────────────────────────────────────────
    valid_rsi = ~np.isnan(rsi)
    if valid_rsi.any():
        ax_r.plot(xs[valid_rsi], rsi[valid_rsi], color=CLAUDE["rsi_line"],
                  linewidth=1.3, zorder=3, alpha=0.9)
        ax_r.axhline(70, color=CLAUDE["down"], linewidth=0.7, linestyle='--', alpha=0.5)
        ax_r.axhline(30, color=CLAUDE["up"],   linewidth=0.7, linestyle='--', alpha=0.5)
        ax_r.axhline(50, color=CLAUDE["text_faint"], linewidth=0.5, linestyle=':', alpha=0.4)
        ax_r.fill_between(xs[valid_rsi], rsi[valid_rsi], 70,
                           where=(rsi[valid_rsi] >= 70),
                           color=CLAUDE["down"], alpha=0.12, zorder=1)
        ax_r.fill_between(xs[valid_rsi], rsi[valid_rsi], 30,
                           where=(rsi[valid_rsi] <= 30),
                           color=CLAUDE["up"], alpha=0.12, zorder=1)
        last_rsi = rsi[valid_rsi][-1]
        ax_r.text(n + 0.5, last_rsi, f'{last_rsi:.0f}',
                  color=CLAUDE["rsi_line"], fontsize=7.5, va='center', fontweight='bold')
    ax_r.set_ylim(10, 90)
    ax_r.set_yticks([30, 50, 70])
    ax_r.tick_params(axis='y', colors=CLAUDE["text_sec"], labelsize=7.5,
                     right=True, labelright=True, labelleft=False, length=2, width=0.5)
    ax_r.yaxis.grid(True, color=CLAUDE["grid"], linewidth=0.4, zorder=0)
    ax_r.set_axisbelow(True)
    for spine in ax_r.spines.values():
        spine.set_color(CLAUDE["border"]); spine.set_linewidth(0.5)
    ax_r.tick_params(axis='x', bottom=False, labelbottom=False, length=0)
    ax_r.text(-0.5, 50, 'RSI 14', color=CLAUDE["text_sec"],
              fontsize=7, ha='right', va='center')

    # ── Volume panel ───────────────────────────────────────────────────────
    for i in range(n):
        vc = CLAUDE["up"] if closes[i] >= opens[i] else CLAUDE["down"]
        ax2.bar(i, vols[i], color=vc, width=w * 1.15, alpha=0.4, zorder=2)
    valid_vma = ~np.isnan(vol_ma20)
    if valid_vma.any():
        ax2.plot(xs[valid_vma], vol_ma20[valid_vma], color=CLAUDE["vol_ma"],
                 linewidth=1.3, zorder=3, alpha=0.85, label='Vol MA20')
    ax2.yaxis.grid(True, color=CLAUDE["grid"], linewidth=0.4, zorder=0)
    ax2.set_axisbelow(True)
    for spine in ax2.spines.values():
        spine.set_color(CLAUDE["border"]); spine.set_linewidth(0.5)
    ax2.tick_params(axis='y', colors=CLAUDE["text_sec"], labelsize=7.5,
                    right=True, labelright=True, labelleft=False, length=2, width=0.5)
    vol_max = vols.max()
    ax2.yaxis.set_major_formatter(plt.FuncFormatter(
        lambda x, _: f'{x/1e7:.1f}Cr' if vol_max > 5e6 else f'{x/1e5:.0f}L'))
    ax2.set_ylim(0, vol_max * 1.6)
    ax2.text(-0.5, vol_max * 0.5, 'VOL', color=CLAUDE["text_sec"],
             fontsize=7, ha='right', va='center')

    # ── X-axis date ticks (bottom of volume panel) ─────────────────────────
    tick_pos = [i for i in range(n) if dates[i].day <= 5]
    tick_lbl = [dates[i].strftime('%b %y') for i in tick_pos]
    ax2.set_xticks(tick_pos)
    ax2.set_xticklabels(tick_lbl, color=CLAUDE["text_sec"], fontsize=8)
    ax2.tick_params(axis='x', length=3, width=0.5, color=CLAUDE["border"])
    ax2.set_xlim(-1, n + 5.5)

    # ── Figure header ──────────────────────────────────────────────────────
    period = f"{dates[0].strftime('%d %b %Y')} {ENDASH} {dates[-1].strftime('%d %b %Y')}"
    fig.text(0.055, 0.957, symbol,
             color=CLAUDE["text"], fontsize=16, fontweight='bold', fontfamily='serif')
    name_x = 0.055 + len(symbol) * 0.0115
    fig.text(name_x, 0.958, f'  {DOT}  {name}',
             color=CLAUDE["text_sec"], fontsize=10.5, fontfamily='serif', va='bottom')
    fig.text(0.935, 0.957, period,
             color=CLAUDE["text_sec"], fontsize=8.5, ha='right', fontfamily='serif')

    buf = BytesIO()
    plt.savefig(buf, format='png', dpi=CONFIG["chart_dpi"],
                bbox_inches='tight', facecolor=CLAUDE["bg"])
    plt.close()
    buf.seek(0)
    return buf


def build_pdf(chart_data, output_path, label="NSE Stock Charts"):
    BG     = colors.HexColor(CLAUDE["bg"])
    ORANGE = colors.HexColor(CLAUDE["orange"])
    TEXT   = colors.HexColor(CLAUDE["text"])
    TSEC   = colors.HexColor(CLAUDE["text_sec"])
    BORD   = colors.HexColor(CLAUDE["border"])

    hdr_s = ParagraphStyle('hdr', fontSize=7.5, fontName='Times-Roman', textColor=TSEC, leading=11)
    ftr_s = ParagraphStyle('ftr', fontSize=6.5, fontName='Times-Italic', textColor=TSEC)
    cov_t = ParagraphStyle('ct',  fontSize=26,  fontName='Times-Bold', textColor=TEXT, spaceAfter=10, leading=32)
    cov_s = ParagraphStyle('cs',  fontSize=12,  fontName='Times-Roman', textColor=TSEC, spaceAfter=5, leading=17)
    cov_n = ParagraphStyle('cn',  fontSize=9,   fontName='Times-Italic', textColor=TSEC)

    def add_bg(canvas, doc):
        canvas.saveState()
        canvas.setFillColor(BG)
        canvas.rect(0, 0, *landscape(A4), fill=1, stroke=0)
        canvas.setFillColor(ORANGE)
        canvas.rect(0, 0, landscape(A4)[0], 0.25*cm, fill=1, stroke=0)
        canvas.restoreState()

    doc = SimpleDocTemplate(output_path, pagesize=landscape(A4),
                            leftMargin=1.2*cm, rightMargin=1.2*cm,
                            topMargin=1*cm, bottomMargin=1*cm)
    story = []

    story.append(Spacer(1, 4.5*cm))
    story.append(Paragraph(label, cov_t))
    story.append(HRFlowable(width="100%", thickness=1.2, color=ORANGE, spaceAfter=10))
    story.append(Paragraph(f"End-of-Day Candlestick Report {EMDASH} NSE Equity Stocks", cov_s))
    story.append(Paragraph(
        f"Generated {datetime.today().strftime('%A, %d %B %Y')}  {DOT}  {datetime.today().strftime('%H:%M IST')}", cov_s))
    story.append(Spacer(1, 0.5*cm))
    story.append(Paragraph(
        f"Stocks: {len(chart_data)}  {DOT}  Indicators: Candlestick {DOT} MA20 {DOT} MA50 {DOT} Volume  {DOT}  Source: Yahoo Finance (EOD)",
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
        story.append(Spacer(1, 0.12*cm))
        story.append(Image(item['img_buf'], width=26.5*cm, height=15*cm))
        story.append(Spacer(1, 0.1*cm))
        story.append(HRFlowable(width="100%", thickness=0.4, color=BORD, spaceAfter=3))
        story.append(Paragraph(
            f"Daily OHLCV Candlestick  {DOT}  MA20 (terracotta)  {DOT}  "
            f"MA50 (gray dashed)  {DOT}  Data: Yahoo Finance EOD  {DOT}  "
            f"{datetime.today().strftime('%d %b %Y')}", ftr_s))
        story.append(PageBreak())

    doc.build(story, onFirstPage=add_bg, onLaterPages=add_bg)


def run_generate(symbol_list, output_path, history_months=6, pdf_label="NSE Stock Charts"):
    """
    Generate PDF for a list of (yf_symbol, nse_symbol, name) tuples.
    Emits JSON progress lines to stdout.
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    total  = len(symbol_list)
    chart_data = []
    failed = []
    done   = 0

    emit({"type": "progress", "done": 0, "total": total, "message": "Starting..."})

    batches = [symbol_list[i:i+CONFIG["batch_size"]]
               for i in range(0, len(symbol_list), CONFIG["batch_size"])]

    for b_idx, batch in enumerate(batches):
        sym_yf_list = [s[0] for s in batch]
        sym_map     = {s[0]: (s[1], s[2]) for s in batch}

        data = fetch_batch(sym_yf_list, history_months)

        for sym_yf, (sym_nse, name) in sym_map.items():
            done += 1
            if sym_yf not in data or data[sym_yf].empty:
                failed.append((sym_yf, sym_nse, name))
                emit({"type": "progress", "done": done, "total": total,
                      "message": f"No data: {sym_nse}", "symbol": sym_nse})
                continue
            try:
                df      = data[sym_yf]
                closes  = df['Close'].values.astype(float)
                highs   = df['High'].values.astype(float)
                lows    = df['Low'].values.astype(float)
                chg_pct = ((closes[-1] - closes[0]) / closes[0]) * 100
                img_buf = draw_chart(sym_yf, name, df)
                chart_data.append({
                    "symbol"    : sym_nse,
                    "name"      : name,
                    "img_buf"   : img_buf,
                    "last_close": round(float(closes[-1]), 2),
                    "chg_pct"   : round(chg_pct, 2),
                    "high_52w"  : round(float(highs.max()), 2),
                    "low_52w"   : round(float(lows.min()), 2),
                })
                emit({"type": "progress", "done": done, "total": total,
                      "message": f"Charted {sym_nse}", "symbol": sym_nse})
            except Exception as e:
                failed.append((sym_yf, sym_nse, name))
                emit({"type": "progress", "done": done, "total": total,
                      "message": f"Chart error: {sym_nse}", "symbol": sym_nse})

        if b_idx < len(batches) - 1:
            delay = CONFIG["batch_delay_sec"] + random.uniform(0, 2)
            time.sleep(delay)

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
                    img_buf = draw_chart(sym_yf, name, df)
                    chart_data.append({
                        "symbol"    : sym_nse,
                        "name"      : name,
                        "img_buf"   : img_buf,
                        "last_close": round(float(closes[-1]), 2),
                        "chg_pct"   : round(chg_pct, 2),
                        "high_52w"  : round(float(highs.max()), 2),
                        "low_52w"   : round(float(lows.min()), 2),
                    })
                time.sleep(3)
            except Exception:
                pass

    if chart_data:
        chart_data.sort(key=lambda x: x['symbol'])
        emit({"type": "building_pdf", "done": total, "total": total,
              "message": f"Building PDF for {len(chart_data)} charts..."})
        build_pdf(chart_data, output_path, pdf_label)
        emit({"type": "complete", "output": output_path, "charted": len(chart_data),
              "failed": len(failed)})
    else:
        emit({"type": "error", "message": "No charts generated — check symbol list or network."})


def main():
    parser = argparse.ArgumentParser(description='NSE Chart PDF Generator')
    parser.add_argument('--mode', choices=['all', 'filtered'], required=True)
    parser.add_argument('--output', required=True, help='Output PDF path')
    parser.add_argument('--symbols', default='', help='Comma-separated NSE symbols (for filtered mode)')
    parser.add_argument('--history-months', type=int, default=6)
    parser.add_argument('--label', default='NSE Stock Charts')
    parser.add_argument('--letters', default='', help='Letter range filter e.g. A-D or A,B,C')
    args = parser.parse_args()

    if args.mode == 'all':
        emit({"type": "progress", "done": 0, "total": 1, "message": "Fetching NSE symbol list..."})
        symbol_list = get_nse_symbols()
        symbol_list.sort(key=lambda x: x[1])

        # Apply letter filter if specified
        if args.letters:
            letter_range = args.letters.strip().upper()
            if '-' in letter_range and len(letter_range) == 3:
                start_l, end_l = letter_range[0], letter_range[2]
                allowed = set(chr(c) for c in range(ord(start_l), ord(end_l) + 1))
            else:
                allowed = set(l.strip() for l in letter_range.split(',') if l.strip())
            symbol_list = [s for s in symbol_list if s[1] and s[1][0].upper() in allowed]

        emit({"type": "progress", "done": 0, "total": len(symbol_list),
              "message": f"Found {len(symbol_list)} NSE symbols"})
        run_generate(symbol_list, args.output, args.history_months, args.label)
    else:
        if not args.symbols:
            emit({"type": "error", "message": "No symbols provided for filtered mode"})
            sys.exit(1)
        syms = [s.strip().upper() for s in args.symbols.split(',') if s.strip()]
        symbol_list = [(f"{s}.NS", s, s) for s in syms]
        run_generate(symbol_list, args.output, args.history_months, args.label)


if __name__ == '__main__':
    main()
