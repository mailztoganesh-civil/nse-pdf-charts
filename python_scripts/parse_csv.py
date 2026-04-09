"""
CSV Parser for NSE Stock Screener files.
Reads a CSV, detects stock symbol and date columns,
and outputs a JSON summary to stdout.

Usage:
    python parse_csv.py <csv_file_path>
"""

import sys, json
import pandas as pd


SYMBOL_COLS = ['SYMBOL', 'Symbol', 'symbol', 'Ticker', 'TICKER', 'ticker',
               'Stock', 'STOCK', 'stock', 'NSE_SYMBOL', 'NSECode', 'NSE Code',
               'SCRIP', 'Scrip', 'scrip', 'NSE', 'nse']

DATE_COLS = ['DATE', 'Date', 'date', 'Screener Date', 'ScreenerDate',
             'SCREENER_DATE', 'Signal Date', 'SIGNAL_DATE', 'Entry Date',
             'ENTRY_DATE', 'Trade Date', 'TRADE_DATE', 'Alert Date',
             'ALERT_DATE', 'Scan Date', 'SCAN_DATE']


def find_column(df, candidates):
    for c in candidates:
        if c in df.columns:
            return c
    for c in df.columns:
        c_lower = str(c).lower().strip()
        for cand in candidates:
            if c_lower == cand.lower():
                return c
    return None


def parse_csv(file_path):
    try:
        df = pd.read_csv(file_path)
    except Exception as e:
        return {"error": f"Could not read CSV: {e}"}

    df.columns = df.columns.str.strip()
    df = df.dropna(how='all')

    sym_col = find_column(df, SYMBOL_COLS)
    date_col = find_column(df, DATE_COLS)

    if sym_col is None:
        # Try first column that looks like stock symbols (all caps, short)
        for col in df.columns:
            sample = df[col].dropna().head(10).astype(str)
            if all(s.isupper() and len(s) <= 20 and ' ' not in s for s in sample if s.strip()):
                sym_col = col
                break

    if sym_col is None:
        return {"error": "Could not find a stock symbol column. Expected a column named SYMBOL, Ticker, Stock, etc."}

    stocks = df[sym_col].dropna().astype(str).str.strip().str.upper()
    stocks = sorted(stocks[stocks.str.len() > 0].unique().tolist())

    dates = []
    min_date = ""
    max_date = ""

    if date_col is not None:
        raw_dates = df[date_col].dropna().astype(str).str.strip()
        parsed_dates = pd.to_datetime(raw_dates, errors='coerce', dayfirst=True).dropna()
        if not parsed_dates.empty:
            sorted_dates = parsed_dates.sort_values()
            dates = sorted_dates.dt.strftime('%Y-%m-%d').unique().tolist()
            min_date = sorted_dates.min().strftime('%Y-%m-%d')
            max_date = sorted_dates.max().strftime('%Y-%m-%d')

    return {
        "stocks": stocks,
        "dates": dates,
        "minDate": min_date,
        "maxDate": max_date,
        "totalRows": len(df),
    }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No file path provided"}))
        sys.exit(1)

    result = parse_csv(sys.argv[1])
    print(json.dumps(result))
