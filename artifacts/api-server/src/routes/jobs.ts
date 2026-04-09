import { Router, type IRouter, type Request, type Response } from "express";
import { spawn } from "child_process";
import { createReadStream, existsSync, mkdirSync } from "fs";
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

const WORKSPACE_ROOT = resolve(process.cwd(), "..", "..");
const OUTPUT_DIR = resolve(WORKSPACE_ROOT, "output");
const SCRIPTS_DIR = resolve(WORKSPACE_ROOT, "python_scripts");
const UPLOADS_DIR = resolve(WORKSPACE_ROOT, "tmp_uploads");

mkdirSync(OUTPUT_DIR, { recursive: true });
mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "text/csv" || file.originalname.endsWith(".csv")) {
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

  const jobId = makeJobId();
  const today = new Date().toISOString().slice(0, 10);
  const outFile = join(OUTPUT_DIR, `NSE_All_${today}_${jobId}.pdf`);

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
  req.log.info({ jobId, historyMonths }, "Starting all-NSE generation job");

  spawnPythonJob(job, [
    "--mode", "all",
    "--output", outFile,
    "--history-months", String(historyMonths),
    "--label", "NSE All Stocks — EOD Charts",
  ]);

  res.status(202).json(GetJobResponse.parse({ ...job, outputFile: undefined }));
});

router.post("/jobs/parse-csv", upload.single("file"), async (req, res): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  const filePath = req.file.path;
  req.log.info({ file: req.file.originalname }, "Parsing CSV");

  const { execFile } = await import("child_process");
  const script = join(SCRIPTS_DIR, "parse_csv.py");

  execFile("python3", [script, filePath], { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      logger.error({ err, stderr }, "CSV parse failed");
      res.status(400).json({ error: `CSV parse failed: ${err.message}` });
      return;
    }
    try {
      const result = JSON.parse(stdout);
      if (result.error) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch {
      res.status(500).json({ error: "Invalid response from parser" });
    }
  });
});

router.post("/jobs/generate-csv", async (req, res): Promise<void> => {
  const parsed = GenerateFromCsvBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { stocks, startDate, endDate, historyMonths = 6 } = parsed.data;

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

  spawnPythonJob(job, [
    "--mode", "filtered",
    "--output", outFile,
    "--symbols", stocks.join(","),
    "--history-months", String(historyMonths),
    "--label", `NSE Screener Charts — ${startDate} to ${endDate}`,
  ]);

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
