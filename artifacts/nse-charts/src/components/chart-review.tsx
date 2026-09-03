import { useEffect, useMemo, useState } from "react";
import { useListJobCharts, getListJobChartsQueryKey } from "@workspace/api-client-react";
import type { ChartSummary } from "@workspace/api-client-react";
import { AlertTriangle, BarChart3, ChevronRight, RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";

function money(value: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value);
}

function percent(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function SummaryCell({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-0 border-l border-border/70 pl-3 first:border-l-0 first:pl-0">
      <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
      <div className={`mt-1 truncate font-mono text-sm font-bold ${accent ? "text-primary" : "text-foreground"}`}>{value}</div>
    </div>
  );
}

function ChartPlaceholder({ message }: { message: string }) {
  return (
    <div className="flex min-h-[280px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-background/30 p-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <BarChart3 className="h-5 w-5" />
      </div>
      <p className="max-w-xs font-mono text-xs leading-relaxed text-muted-foreground">{message}</p>
    </div>
  );
}

function ChartImage({ jobId, symbol }: { jobId: string; symbol: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const chartUrl = `/api/jobs/${encodeURIComponent(jobId)}/charts/${encodeURIComponent(symbol)}`;

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [jobId, symbol]);

  if (failed) {
    return <ChartPlaceholder message="This chart could not be loaded. Try refreshing the chart or reopen the job." />;
  }

  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-background/30">
      {!loaded && (
        <div className="absolute inset-0 z-10 min-h-[280px] animate-pulse bg-[linear-gradient(100deg,hsl(var(--muted)/.35),hsl(var(--muted)/.12),hsl(var(--muted)/.35))] bg-[length:200%_100%]" />
      )}
      <img
        key={chartUrl}
        src={chartUrl}
        alt={`${symbol} candlestick chart`}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={`block max-h-[620px] min-h-[280px] w-full object-contain transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
        data-testid={`img-chart-${symbol}`}
      />
    </div>
  );
}

export function ChartReview({ jobId, stockCount }: { jobId: string; stockCount: number }) {
  const { data: charts, isLoading, isError, refetch, isFetching } = useListJobCharts(jobId, {
    query: {
      queryKey: getListJobChartsQueryKey(jobId),
      enabled: Boolean(jobId),
    },
  });
  const [selectedSymbol, setSelectedSymbol] = useState("");
  const [filter, setFilter] = useState("");

  const visibleCharts = useMemo(() => {
    if (!charts) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return charts;
    return charts.filter((chart) => `${chart.symbol} ${chart.name}`.toLowerCase().includes(needle));
  }, [charts, filter]);

  const selected = useMemo(() => {
    if (!charts?.length) return undefined;
    return charts.find((chart) => chart.symbol === selectedSymbol) ?? charts[0];
  }, [charts, selectedSymbol]);

  useEffect(() => {
    if (charts?.length && !charts.some((chart) => chart.symbol === selectedSymbol)) {
      setSelectedSymbol(charts[0].symbol);
    }
  }, [charts, selectedSymbol]);

  if (isLoading) {
    return (
      <section className="mt-8 space-y-4 border-t border-border/80 pt-8" aria-label="Loading generated charts">
        <div className="flex items-end justify-between gap-4">
          <div className="space-y-2">
            <div className="h-3 w-28 animate-pulse rounded bg-muted" />
            <div className="h-7 w-52 animate-pulse rounded bg-muted" />
          </div>
          <div className="h-8 w-28 animate-pulse rounded bg-muted" />
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(190px,0.3fr)_minmax(0,1fr)]">
          <div className="h-[420px] animate-pulse rounded-lg bg-muted/50" />
          <div className="min-h-[420px] animate-pulse rounded-lg bg-muted/50" />
        </div>
      </section>
    );
  }

  if (isError) {
    return (
      <section className="mt-8 border-t border-border/80 pt-8" data-testid="state-charts-error">
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-8 text-center">
          <AlertTriangle className="mx-auto h-7 w-7 text-destructive" />
          <h4 className="mt-3 font-mono text-sm font-bold text-foreground">Chart list unavailable</h4>
          <p className="mx-auto mt-2 max-w-md font-mono text-xs leading-relaxed text-muted-foreground">
            The PDF is ready, but the visual review could not be loaded. Your generation is safe.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-5 font-mono text-xs"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-retry-charts"
          >
            <RefreshCw className={`mr-2 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
            TRY AGAIN
          </Button>
        </div>
      </section>
    );
  }

  if (!charts?.length) {
    return (
      <section className="mt-8 border-t border-border/80 pt-8" data-testid="state-charts-empty">
        <ChartPlaceholder message={`No chart images were returned for this job yet. Download the PDF or try again shortly.`} />
      </section>
    );
  }

  const changeIsPositive = (selected?.chgPct ?? 0) >= 0;

  return (
    <section className="mt-8 border-t border-border/80 pt-8 tape-in" data-testid="section-chart-review">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-primary">Visual review / NSE</div>
          <h3 className="mt-1 font-mono text-xl font-bold tracking-tight">Inspect the book</h3>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {charts.length} charts ready{stockCount > charts.length ? ` · ${stockCount - charts.length} still processing` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="chart-filter" className="sr-only">Filter charts</label>
          <input
            id="chart-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter symbol"
            className="h-8 w-full rounded-md border border-border bg-background/50 px-3 font-mono text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 sm:w-36"
            data-testid="input-chart-filter"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 px-2.5 font-mono text-[10px]"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label="Refresh chart list"
            data-testid="button-refresh-charts"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(210px,0.31fr)_minmax(0,1fr)]">
        <div className="min-w-0 rounded-lg border border-border bg-card/60">
          <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.17em] text-muted-foreground">Stocks</span>
            <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-primary">{visibleCharts.length}</span>
          </div>
          <div className="scrollbar-market flex max-h-[480px] gap-1 overflow-x-auto p-2 lg:block lg:overflow-y-auto lg:overflow-x-hidden">
            {visibleCharts.length ? visibleCharts.map((chart) => {
              const isSelected = selected?.symbol === chart.symbol;
              const positive = chart.chgPct >= 0;
              return (
                <button
                  key={chart.symbol}
                  type="button"
                  onClick={() => setSelectedSymbol(chart.symbol)}
                  className={`group min-w-[172px] rounded-md border px-3 py-2.5 text-left transition-all duration-200 lg:mb-1 lg:min-w-0 ${
                    isSelected
                      ? "border-primary/70 bg-primary/10 shadow-[inset_3px_0_0_hsl(var(--primary))]"
                      : "border-transparent hover:border-border hover:bg-muted/60"
                  }`}
                  data-testid={`button-stock-${chart.symbol}`}
                  aria-pressed={isSelected}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`font-mono text-xs font-bold ${isSelected ? "text-primary" : "text-foreground"}`}>{chart.symbol}</span>
                    <ChevronRight className={`h-3 w-3 transition-transform ${isSelected ? "translate-x-0.5 text-primary" : "text-muted-foreground/50 group-hover:translate-x-0.5"}`} />
                  </div>
                  <div className="mt-1 truncate text-[11px] text-muted-foreground">{chart.name}</div>
                  <div className={`mt-2 font-mono text-[10px] font-bold ${positive ? "text-[hsl(var(--accent))]" : "text-destructive"}`}>
                    {percent(chart.chgPct)}
                  </div>
                </button>
              );
            }) : (
              <div className="p-5 text-center font-mono text-xs text-muted-foreground">No symbols match “{filter}”.</div>
            )}
          </div>
        </div>

        {selected && (
          <div className="chart-frame min-w-0 rounded-lg border border-border p-3 sm:p-4">
            <div className="mb-3 flex flex-col gap-3 border-b border-border/80 pb-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xl font-bold tracking-tight text-primary" data-testid={`text-selected-symbol-${selected.symbol}`}>{selected.symbol}</span>
                  <span className="rounded-sm border border-border bg-background/50 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">NSE</span>
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground" data-testid={`text-selected-name-${selected.symbol}`}>{selected.name}</div>
              </div>
              <div className={`flex items-center gap-1 self-start rounded-md px-2 py-1 font-mono text-xs font-bold ${changeIsPositive ? "bg-[hsl(var(--accent)/.13)] text-[hsl(var(--accent))]" : "bg-destructive/10 text-destructive"}`} data-testid={`text-selected-change-${selected.symbol}`}>
                {changeIsPositive ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                {percent(selected.chgPct)}
              </div>
            </div>

            <div className="mb-4 grid grid-cols-2 gap-3 rounded-md border border-border/70 bg-background/30 px-3 py-2.5 sm:grid-cols-4">
              <SummaryCell label="Last close" value={money(selected.lastClose)} accent />
              <SummaryCell label="Change" value={percent(selected.chgPct)} />
              <SummaryCell label="52W high" value={money(selected.high52w)} />
              <SummaryCell label="52W low" value={money(selected.low52w)} />
            </div>
            <ChartImage jobId={jobId} symbol={selected.symbol} />
          </div>
        )}
      </div>
    </section>
  );
}