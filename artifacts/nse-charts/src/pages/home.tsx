import { useState, useEffect, useRef, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { useGenerateAllNse, useGenerateFromCsv, useGetJob, getGetJobQueryKey } from "@workspace/api-client-react";
import { UploadCloud, File, Play, Download, AlertCircle, CheckCircle2, Loader2, CalendarIcon } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { Job, CsvParseResult } from "@workspace/api-client-react/src/generated/api.schemas";

function ScreenerDatePicker({
  label,
  value,
  onChange,
  screenerDates,
  minDate,
  maxDate,
  testId,
}: {
  label: string;
  value: string;
  onChange: (val: string) => void;
  screenerDates: Date[];
  minDate: string;
  maxDate: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = value ? new Date(value + "T00:00:00") : undefined;
  const min = minDate ? new Date(minDate + "T00:00:00") : undefined;
  const max = maxDate ? new Date(maxDate + "T00:00:00") : undefined;

  return (
    <div className="space-y-2">
      <Label className="font-mono text-xs text-muted-foreground">{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            data-testid={testId}
            className="w-full justify-start font-mono text-sm h-9"
          >
            <CalendarIcon className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
            {value || <span className="text-muted-foreground">Pick a date</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <style>{`
            .rdp-day[data-screener="true"] {
              position: relative;
            }
            .rdp-day[data-screener="true"]::after {
              content: '';
              position: absolute;
              bottom: 2px;
              left: 50%;
              transform: translateX(-50%);
              width: 4px;
              height: 4px;
              border-radius: 50%;
              background: hsl(var(--primary));
            }
          `}</style>
          <Calendar
            mode="single"
            selected={selected}
            onSelect={(date) => {
              if (date) {
                const y = date.getFullYear();
                const m = String(date.getMonth() + 1).padStart(2, "0");
                const d = String(date.getDate()).padStart(2, "0");
                onChange(`${y}-${m}-${d}`);
              }
              setOpen(false);
            }}
            disabled={(date) => {
              if (min && date < min) return true;
              if (max && date > max) return true;
              return false;
            }}
            modifiers={{ screener: screenerDates }}
            modifiersStyles={{
              screener: {
                fontWeight: "700",
                color: "hsl(var(--primary))",
                textDecoration: "underline",
                textDecorationColor: "hsl(var(--primary))",
                textUnderlineOffset: "3px",
              },
            }}
            captionLayout="dropdown"
            defaultMonth={selected ?? max}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function ActiveJobView({ jobId, onReset }: { jobId: string, onReset: () => void }) {
  const queryClient = useQueryClient();
  const { data: job, isLoading } = useGetJob(jobId, {
    query: {
      queryKey: getGetJobQueryKey(jobId),
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return (status === "pending" || status === "running") ? 2000 : false;
      }
    }
  });

  if (isLoading || !job) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const isRunning = job.status === "pending" || job.status === "running";
  const isFailed = job.status === "failed";
  const isCompleted = job.status === "completed";
  const percentage = job.total > 0 ? Math.round((job.progress / job.total) * 100) : 0;

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }} 
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="flex flex-col items-center text-center space-y-4 py-8">
        {isRunning && (
          <>
            <div className="relative w-24 h-24 flex items-center justify-center rounded-full bg-primary/10 mb-4">
              <Loader2 className="w-12 h-12 animate-spin text-primary" />
              <div className="absolute inset-0 border-2 border-primary border-t-transparent rounded-full animate-[spin_3s_linear_infinite]" />
            </div>
            <h3 className="text-xl font-mono font-bold">Generating PDF</h3>
            <p className="text-muted-foreground font-mono text-sm max-w-md">
              {job.message || "Processing stocks..."}
            </p>
          </>
        )}
        
        {isCompleted && (
          <>
            <div className="w-24 h-24 flex items-center justify-center rounded-full bg-green-500/20 mb-4 text-green-500">
              <CheckCircle2 className="w-12 h-12" />
            </div>
            <h3 className="text-xl font-mono font-bold text-green-400">Generation Complete</h3>
            <p className="text-muted-foreground font-mono text-sm max-w-md">
              Processed {job.total} stocks successfully.
            </p>
            <div className="mt-8 pt-4">
              <a 
                href={`/api/jobs/${job.jobId}/download`}
                download
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-8 py-2 font-mono font-bold"
                data-testid="link-download-pdf"
              >
                <Download className="w-4 h-4" />
                DOWNLOAD PDF
              </a>
            </div>
          </>
        )}

        {isFailed && (
          <>
            <div className="w-24 h-24 flex items-center justify-center rounded-full bg-destructive/20 mb-4 text-destructive">
              <AlertCircle className="w-12 h-12" />
            </div>
            <h3 className="text-xl font-mono font-bold text-destructive">Generation Failed</h3>
            <p className="text-muted-foreground font-mono text-sm max-w-md">
              {job.message || "An unexpected error occurred during processing."}
            </p>
          </>
        )}
      </div>

      {isRunning && (
        <div className="space-y-2 max-w-2xl mx-auto">
          <div className="flex justify-between text-xs font-mono text-muted-foreground">
            <span>{job.progress} / {job.total || "?"} stocks</span>
            <span>{percentage}%</span>
          </div>
          <Progress value={percentage} className="h-2" />
        </div>
      )}

      {(isCompleted || isFailed) && (
        <div className="flex justify-center pt-8">
          <Button variant="outline" onClick={onReset} data-testid="button-reset">
            Start New Job
          </Button>
        </div>
      )}
    </motion.div>
  );
}

export default function Home() {
  const { toast } = useToast();
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  
  const generateAllMutation = useGenerateAllNse();
  const generateCsvMutation = useGenerateFromCsv();

  // All NSE state
  const [historyMonths, setHistoryMonths] = useState("6");
  const [letterFilter, setLetterFilter] = useState("ALL");

  const LETTER_RANGES = [
    { label: "All", value: "ALL", desc: "~2000+ stocks" },
    { label: "A – D", value: "A-D", desc: "~300 stocks" },
    { label: "E – H", value: "E-H", desc: "~250 stocks" },
    { label: "I – L", value: "I-L", desc: "~250 stocks" },
    { label: "M – P", value: "M-P", desc: "~350 stocks" },
    { label: "Q – T", value: "Q-T", desc: "~500 stocks" },
    { label: "U – Z", value: "U-Z", desc: "~350 stocks" },
  ];

  // CSV state
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [parseResult, setParseResult] = useState<CsvParseResult | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [useAllStocks, setUseAllStocks] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Compute stocks for the selected date range from stocksByDate map
  const filteredStocks = useMemo(() => {
    if (!parseResult?.stocksByDate || !startDate || !endDate) return parseResult?.stocks ?? [];
    const result = new Set<string>();
    for (const [date, syms] of Object.entries(parseResult.stocksByDate)) {
      if (date >= startDate && date <= endDate) {
        for (const s of syms) result.add(s);
      }
    }
    return [...result].sort();
  }, [parseResult, startDate, endDate]);

  // Convert screener dates (YYYY-MM-DD strings) to Date objects for calendar highlighting
  const screenerDates = useMemo(() => {
    if (!parseResult?.dates) return [];
    return parseResult.dates.map((d) => new Date(d + "T00:00:00"));
  }, [parseResult]);

  const handleGenerateAll = () => {
    generateAllMutation.mutate(
      { data: { historyMonths: parseInt(historyMonths, 10) || 6, letterFilter } },
      {
        onSuccess: (job) => {
          setActiveJobId(job.jobId);
        },
        onError: () => {
          toast({
            title: "Error",
            description: "Failed to start generation job.",
            variant: "destructive",
          });
        }
      }
    );
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setCsvFile(file);
    setIsParsing(true);
    setParseResult(null);
    setUseAllStocks(false);

    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('/api/jobs/parse-csv', { 
        method: 'POST', 
        body: formData 
      });
      
      if (!response.ok) throw new Error("Failed to parse CSV");
      
      const result: CsvParseResult = await response.json();
      setParseResult(result);
      // Default to latest date for both start and end
      setStartDate(result.maxDate);
      setEndDate(result.maxDate);
    } catch (error) {
      toast({
        title: "Parse Error",
        description: "Could not read the CSV file. Ensure it has a valid format.",
        variant: "destructive"
      });
      setCsvFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } finally {
      setIsParsing(false);
    }
  };

  const handleGenerateCsv = () => {
    const stocksToUse = useAllStocks ? (parseResult?.stocks ?? []) : filteredStocks;
    if (!parseResult || stocksToUse.length === 0) return;
    if (!useAllStocks && (!startDate || !endDate)) return;

    const effectiveStart = useAllStocks ? (parseResult.minDate || startDate) : startDate;
    const effectiveEnd   = useAllStocks ? (parseResult.maxDate || endDate)   : endDate;

    generateCsvMutation.mutate(
      { 
        data: { 
          stocks: stocksToUse,
          startDate: effectiveStart,
          endDate:   effectiveEnd,
          historyMonths: parseInt(historyMonths, 10) || 6,
          stocksByDate: useAllStocks
            ? parseResult.stocksByDate
            : parseResult
              ? Object.fromEntries(
                  Object.entries(parseResult.stocksByDate).filter(
                    ([date]) => date >= startDate && date <= endDate
                  )
                )
              : undefined,
        } 
      },
      {
        onSuccess: (job) => {
          setActiveJobId(job.jobId);
        },
        onError: () => {
          toast({
            title: "Error",
            description: "Failed to start CSV generation job.",
            variant: "destructive",
          });
        }
      }
    );
  };

  if (activeJobId) {
    return (
      <div className="max-w-4xl mx-auto pt-8">
        <Card className="border-primary/20 bg-card">
          <CardContent className="p-6">
            <ActiveJobView jobId={activeJobId} onReset={() => setActiveJobId(null)} />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-mono font-bold tracking-tight">Generate Chart Book</h1>
        <p className="text-muted-foreground mt-2 font-mono text-sm">Create a PDF compiled with candlestick charts for technical analysis.</p>
      </div>

      <Tabs defaultValue="all-nse" className="w-full">
        <TabsList className="grid w-full grid-cols-2 font-mono">
          <TabsTrigger value="all-nse" data-testid="tab-all-nse">All NSE Stocks</TabsTrigger>
          <TabsTrigger value="csv" data-testid="tab-csv">CSV Upload</TabsTrigger>
        </TabsList>
        
        <TabsContent value="all-nse">
          <Card className="border-border">
            <CardHeader>
              <CardTitle className="font-mono">Full Market Export</CardTitle>
              <CardDescription className="font-mono">Generate charts for all active NSE symbols.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">

              <div className="space-y-2">
                <Label className="font-mono text-xs text-muted-foreground uppercase tracking-widest">Stock Range (by first letter)</Label>
                <div className="grid grid-cols-4 gap-2">
                  {LETTER_RANGES.map(({ label, value, desc }) => (
                    <button
                      key={value}
                      onClick={() => setLetterFilter(value)}
                      className={`flex flex-col items-center justify-center rounded-md border px-2 py-3 text-center transition-colors font-mono
                        ${letterFilter === value
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-transparent text-muted-foreground hover:border-primary/50 hover:text-foreground"
                        }`}
                      data-testid={`filter-${value}`}
                    >
                      <span className="text-sm font-bold leading-none mb-1">{label}</span>
                      <span className="text-[10px] leading-none opacity-70">{desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="history-months" className="font-mono text-xs text-muted-foreground uppercase tracking-widest">History Months</Label>
                <div className="flex items-center gap-4">
                  <Input 
                    id="history-months" 
                    type="number" 
                    min="1" 
                    max="60" 
                    value={historyMonths}
                    onChange={(e) => setHistoryMonths(e.target.value)}
                    className="w-32 font-mono"
                    data-testid="input-history-months"
                  />
                  <span className="text-sm text-muted-foreground font-mono">months of data per chart</span>
                </div>
              </div>

              <Button 
                onClick={handleGenerateAll} 
                disabled={generateAllMutation.isPending}
                className="w-full font-mono font-bold h-12"
                data-testid="button-generate-all"
              >
                {generateAllMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
                {letterFilter === "ALL" ? "GENERATE ALL NSE PDF" : `GENERATE ${letterFilter} STOCKS PDF`}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="csv">
          <Card className="border-border">
            <CardHeader>
              <CardTitle className="font-mono">Custom List (CSV)</CardTitle>
              <CardDescription className="font-mono">Upload a CSV file containing a list of stock symbols.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              
              {!parseResult && (
                <div className="border-2 border-dashed border-muted rounded-lg p-12 text-center hover:bg-muted/10 transition-colors">
                  <input 
                    type="file" 
                    accept=".csv,text/csv,application/csv,text/plain,application/vnd.ms-excel" 
                    className="hidden" 
                    ref={fileInputRef}
                    onChange={handleFileUpload}
                    data-testid="input-csv-file"
                  />
                  <UploadCloud className="w-10 h-10 text-muted-foreground mx-auto mb-4" />
                  <h3 className="font-mono font-bold mb-2">Upload Stock List</h3>
                  <p className="text-sm text-muted-foreground font-mono mb-6">CSV should contain stock symbols.</p>
                  <Button 
                    variant="outline" 
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isParsing}
                    className="font-mono"
                    data-testid="button-select-csv"
                  >
                    {isParsing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : "Select File"}
                  </Button>
                </div>
              )}

              {parseResult && (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4">
                  <div className="flex items-center justify-between p-4 bg-muted/30 rounded-lg border border-border">
                    <div className="flex items-center gap-3">
                      <File className="w-8 h-8 text-primary" />
                      <div>
                        <div className="font-mono font-bold text-sm">{csvFile?.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {parseResult.stocks.length} unique symbols across {parseResult.dates.length} dates
                        </div>
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => {
                      setParseResult(null);
                      setCsvFile(null);
                    }} className="font-mono text-xs h-8">
                      Change File
                    </Button>
                  </div>

                  {/* Toggle: all stocks vs date range */}
                  <div className="flex items-center justify-between rounded-lg border border-border px-4 py-3 bg-muted/20">
                    <div>
                      <div className="font-mono text-sm font-bold">All stocks in CSV</div>
                      <div className="font-mono text-xs text-muted-foreground mt-0.5">
                        {useAllStocks
                          ? `Chart all ${parseResult.stocks.length} symbols regardless of date`
                          : "Chart only stocks in selected date range"}
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={useAllStocks}
                      onClick={() => setUseAllStocks(v => !v)}
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none
                        ${useAllStocks ? "bg-primary" : "bg-input"}`}
                    >
                      <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform
                        ${useAllStocks ? "translate-x-5" : "translate-x-0"}`} />
                    </button>
                  </div>

                  {/* Date range — only shown when not using all stocks */}
                  {!useAllStocks && (
                    <div className="grid grid-cols-2 gap-4">
                      <ScreenerDatePicker
                        label="Start Date"
                        value={startDate}
                        onChange={setStartDate}
                        screenerDates={screenerDates}
                        minDate={parseResult.minDate}
                        maxDate={parseResult.maxDate}
                        testId="input-start-date"
                      />
                      <ScreenerDatePicker
                        label="End Date"
                        value={endDate}
                        onChange={setEndDate}
                        screenerDates={screenerDates}
                        minDate={parseResult.minDate}
                        maxDate={parseResult.maxDate}
                        testId="input-end-date"
                      />
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="csv-history-months" className="font-mono text-xs text-muted-foreground uppercase tracking-widest">Chart History</Label>
                    <div className="flex items-center gap-4">
                      <Input
                        id="csv-history-months"
                        type="number"
                        min="1"
                        max="60"
                        value={historyMonths}
                        onChange={(e) => setHistoryMonths(e.target.value)}
                        className="w-32 font-mono"
                        data-testid="input-csv-history-months"
                      />
                      <span className="text-sm text-muted-foreground font-mono">months of price history per chart</span>
                    </div>
                  </div>

                  <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 font-mono text-sm text-center">
                    {useAllStocks ? (
                      <>
                        <span className="text-primary font-bold text-lg">{parseResult.stocks.length}</span>
                        <span className="text-muted-foreground ml-2">total stocks in CSV</span>
                      </>
                    ) : (
                      <>
                        <span className="text-primary font-bold text-lg">{filteredStocks.length}</span>
                        <span className="text-muted-foreground ml-2">stocks in selected date range</span>
                      </>
                    )}
                  </div>

                  <Button
                    onClick={handleGenerateCsv}
                    disabled={
                      generateCsvMutation.isPending ||
                      (useAllStocks ? parseResult.stocks.length === 0 : (!startDate || !endDate || filteredStocks.length === 0))
                    }
                    className="w-full font-mono font-bold h-12"
                    data-testid="button-generate-csv"
                  >
                    {generateCsvMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
                    {useAllStocks
                      ? `GENERATE PDF (ALL ${parseResult.stocks.length} STOCKS)`
                      : `GENERATE PDF (${filteredStocks.length} STOCKS)`}
                  </Button>
                </div>
              )}

            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
