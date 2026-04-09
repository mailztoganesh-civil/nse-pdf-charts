import { Router, type IRouter, type Request, type Response } from "express";
import { spawn } from "child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import multer from "multer";
import {
  GenerateAllNseBody,
  GenerateFromCsvBody,
  GetJobParams,
  ListJobsResponse,
  GetJobResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// In dev, cwd is artifacts/api-server/ so we go up two levels.
// In production, cwd is already the workspace root (pnpm-workspace.yaml is present).
const WORKSPACE_ROOT = existsSync(resolve(process.cwd(), "pnpm-workspace.yaml"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");
const OUTPUT_DIR = resolve(WORKSPACE_ROOT, "output");
const SCRIPTS_DIR = resolve(WORKSPACE_ROOT, "python_scripts");
const UPLOADS_DIR = resolve(WORKSPACE_ROOT, "tmp_uploads");

mkdirSync(OUTPUT_DIR, { recursive: true });
mkdirSync(UPLOADS_DIR, { recursive: true });

const CSV_MIMES = new Set([
  "text/csv",
  "application/csv",
  "text/comma-separated-values",
  "application/vnd.ms-excel",
  "text/plain",
  "application/octet-stream",
]);

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isCsvName = file.originalname.toLowerCase().endsWith(".csv");
    const isCsvMime = CSV_MIMES.has(file.mimetype);
    if (isCsvName || isCsvMime) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are allowed"));
    }
  },
});

interface Job {
  jobId: string;
  type: "all-nse" | "csv";
  status: "pending" | "running" | "completed" | "failed";
  progress: number;
  total: number;
  message: string;
  createdAt: string;
  completedAt: string | null;
  stockCount: number | null;
  outputFile?: string;
}

const jobs = new Map<string, Job>();

function makeJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function spawnPythonJob(job: Job, args: string[]): void {
  const pythonBin = "python3";
  const script = join(SCRIPTS_DIR, "nse_chart_generator.py");

  logger.info({ jobId: job.jobId, args }, "Spawning Python chart generator");

  const proc = spawn(pythonBin, [script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env },
  });

  job.status = "running";

  proc.stdout.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "progress") {
          job.progress = msg.done ?? job.progress;
          job.total = msg.total ?? job.total;
          job.message = msg.message ?? job.message;
        } else if (msg.type === "building_pdf") {
          job.message = msg.message ?? "Building PDF...";
        } else if (msg.type === "complete") {
          job.status = "completed";
          job.progress = msg.charted ?? job.total;
          job.stockCount = msg.charted ?? null;
          job.completedAt = new Date().toISOString();
          job.outputFile = msg.output;
          job.message = `PDF ready — ${msg.charted} charts`;
          logger.info({ jobId: job.jobId, output: msg.output }, "Job completed");
        } else if (msg.type === "error") {
          job.status = "failed";
          job.completedAt = new Date().toISOString();
          job.message = msg.message ?? "Unknown error";
          logger.error({ jobId: job.jobId, message: msg.message }, "Job failed");
        }
      } catch {
        // Not JSON — ignore
      }
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    logger.debug({ jobId: job.jobId, stderr: chunk.toString() }, "Python stderr");
  });

  proc.on("close", (code) => {
    if (job.status === "running") {
      if (code === 0) {
        job.status = "completed";
        job.completedAt = new Date().toISOString();
        job.message = "Completed";
      } else {
        job.status = "failed";
        job.completedAt = new Date().toISOString();
        job.message = `Process exited with code ${code}`;
      }
    }
    logger.info({ jobId: job.jobId, code, status: job.status }, "Python process closed");
  });

  proc.on("error", (err) => {
    job.status = "failed";
    job.completedAt = new Date().toISOString();
    job.message = `Failed to start: ${err.message}`;
    logger.error({ jobId: job.jobId, err }, "Python spawn error");
  });
}

router.get("/jobs", async (_req, res): Promise<void> => {
  const list = Array.from(jobs.values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map(({ outputFile: _of, ...rest }) => rest);
  res.json(ListJobsResponse.parse(list));
});

router.post("/jobs/generate-all", async (req, res): Promise<void> => {
  const parsed = GenerateAllNseBody.safeParse(req.body ?? {});
  const historyMonths = parsed.success ? (parsed.data.historyMonths ?? 6) : 6;
  const letterFilter: string = (parsed.success ? (parsed.data.letterFilter ?? "ALL") : "ALL").toUpperCase();

  const jobId = makeJobId();
  const today = new Date().toISOString().slice(0, 10);
  const safeFilter = letterFilter.replace(/[^A-Z\-]/g, "") || "ALL";
  const outFile = join(OUTPUT_DIR, `NSE_${safeFilter}_${today}_${jobId}.pdf`);
  const label = letterFilter === "ALL" ? "NSE All Stocks — EOD Charts" : `NSE Stocks ${letterFilter} — EOD Charts`;

  const job: Job = {
    jobId,
    type: "all-nse",
    status: "pending",
    progress: 0,
    total: 0,
    message: "Fetching NSE symbol list...",
    createdAt: new Date().toISOString(),
    completedAt: null,
    stockCount: null,
    outputFile: outFile,
  };

  jobs.set(jobId, job);
  req.log.info({ jobId, historyMonths, letterFilter }, "Starting all-NSE generation job");

  const args = [
    "--mode", "all",
    "--output", outFile,
    "--history-months", String(historyMonths),
    "--label", label,
  ];
  if (letterFilter !== "ALL") args.push("--letters", letterFilter);

  spawnPythonJob(job, args);

  res.status(202).json(GetJobResponse.parse({ ...job, outputFile: undefined }));
});

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if ((ch === "," || ch === ";") && !inQuotes) { result.push(current.trim()); current = ""; }
    else { current += ch; }
  }
  result.push(current.trim());
  return result;
}

const SYMBOL_COLS = ["symbol","ticker","stock","nse_symbol","nsecode","nse code","scrip","nse","name"];
const DATE_COLS   = ["date","screener date","screenerdate","signal date","signal_date","entry date",
                     "entry_date","trade date","trade_date","alert date","alert_date","scan date","scan_date"];

function detectColIdx(headers: string[], candidates: string[]): number {
  const lh = headers.map(h => h.toLowerCase().replace(/[^a-z0-9 _]/g, "").trim());
  for (const c of candidates) {
    const idx = lh.findIndex(h => h === c);
    if (idx >= 0) return idx;
  }
  return -1;
}

router.post("/jobs/parse-csv", upload.single("file"), async (req, res): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  const filePath = req.file.path;
  req.log.info({ file: req.file.originalname }, "Parsing CSV");

  try {
    const raw = readFileSync(filePath, "utf-8");
    try { unlinkSync(filePath); } catch { /* ignore */ }

    const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) {
      res.status(400).json({ error: "CSV is empty or has no data rows" });
      return;
    }

    const headers = parseCsvLine(lines[0]);
    let symIdx = detectColIdx(headers, SYMBOL_COLS);
    let dateIdx = detectColIdx(headers, DATE_COLS);

    // Heuristic: first col with short all-caps values
    if (symIdx < 0) {
      const sample = lines.slice(1, Math.min(11, lines.length)).map(l => parseCsvLine(l));
      for (let ci = 0; ci < headers.length; ci++) {
        const vals = sample.map(r => (r[ci] ?? "").trim());
        if (vals.every(v => v.length > 0 && v.length <= 20 && /^[A-Z0-9&.\-]+$/.test(v))) {
          symIdx = ci; break;
        }
      }
    }

    if (symIdx < 0) {
      res.status(400).json({ error: "Could not find a stock symbol column. Expected SYMBOL, Ticker, Stock, etc." });
      return;
    }

    const stocksByDate: Record<string, Set<string>> = {};
    const allStocks = new Set<string>();

    function parseIsoDate(rawDate: string): string | null {
      if (!rawDate) return null;
      const dmyMatch = rawDate.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
      if (dmyMatch) {
        const [, dd, mm, yyyy] = dmyMatch;
        const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
        if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      }
      const d = new Date(rawDate);
      return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    }

    for (const line of lines.slice(1)) {
      const cells = parseCsvLine(line);
      const sym = (cells[symIdx] ?? "").trim().toUpperCase().replace(/[^A-Z0-9&.\-]/g, "");
      if (sym.length < 1 || sym.length > 20) continue;
      allStocks.add(sym);

      if (dateIdx >= 0) {
        const iso = parseIsoDate((cells[dateIdx] ?? "").trim());
        if (iso) {
          if (!stocksByDate[iso]) stocksByDate[iso] = new Set();
          stocksByDate[iso].add(sym);
        }
      }
    }

    const sortedStocks = [...allStocks].sort();
    const sortedDates  = Object.keys(stocksByDate).sort();
    const stocksByDateArr: Record<string, string[]> = {};
    for (const [date, syms] of Object.entries(stocksByDate)) {
      stocksByDateArr[date] = [...syms].sort();
    }

    res.json({
      stocks: sortedStocks,
      stocksByDate: stocksByDateArr,
      dates: sortedDates,
      minDate: sortedDates[0] ?? "",
      maxDate: sortedDates[sortedDates.length - 1] ?? "",
      totalRows: lines.length - 1,
    });
  } catch (err: any) {
    logger.error({ err }, "CSV parse failed");
    res.status(500).json({ error: "Failed to read the uploaded file" });
  }
});

router.post("/jobs/generate-csv", async (req, res): Promise<void> => {
  const parsed = GenerateFromCsvBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { stocks, startDate, endDate, historyMonths = 6, stocksByDate } = parsed.data;

  if (!stocks.length) {
    res.status(400).json({ error: "No stocks provided" });
    return;
  }

  const jobId = makeJobId();
  const today = new Date().toISOString().slice(0, 10);
  const outFile = join(OUTPUT_DIR, `NSE_CSV_${today}_${jobId}.pdf`);

  const job: Job = {
    jobId,
    type: "csv",
    status: "pending",
    progress: 0,
    total: stocks.length,
    message: `Preparing to chart ${stocks.length} stocks...`,
    createdAt: new Date().toISOString(),
    completedAt: null,
    stockCount: null,
    outputFile: outFile,
  };

  jobs.set(jobId, job);
  req.log.info({ jobId, stockCount: stocks.length, startDate, endDate }, "Starting CSV-filtered generation job");

  // Write stocksByDate to a temp JSON file so Python can mark screener-date arrows
  const pyArgs: string[] = [
    "--mode", "filtered",
    "--output", outFile,
    "--symbols", stocks.join(","),
    "--history-months", String(historyMonths),
    "--label", `NSE Screener Charts — ${startDate} to ${endDate}`,
  ];

  if (stocksByDate && Object.keys(stocksByDate).length > 0) {
    const screenerFile = join(UPLOADS_DIR, `screener_${jobId}.json`);
    writeFileSync(screenerFile, JSON.stringify(stocksByDate), "utf-8");
    pyArgs.push("--screener-dates-file", screenerFile);
  }

  spawnPythonJob(job, pyArgs);

  res.status(202).json(GetJobResponse.parse({ ...job, outputFile: undefined }));
});

router.get("/jobs/:jobId", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params["jobId"]) ? req.params["jobId"][0] : req.params["jobId"];
  const params = GetJobParams.safeParse({ jobId: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const job = jobs.get(params.data.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const { outputFile: _of, ...rest } = job;
  res.json(GetJobResponse.parse(rest));
});

router.get("/jobs/:jobId/download", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params["jobId"]) ? req.params["jobId"][0] : req.params["jobId"];
  const job = jobs.get(raw);

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  if (job.status !== "completed" || !job.outputFile) {
    res.status(400).json({ error: "PDF not ready yet" });
    return;
  }

  if (!existsSync(job.outputFile)) {
    res.status(404).json({ error: "PDF file not found on disk" });
    return;
  }

  const filename = `NSE_Charts_${new Date(job.createdAt).toISOString().slice(0, 10)}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  createReadStream(job.outputFile).pipe(res);
});

export default router;
