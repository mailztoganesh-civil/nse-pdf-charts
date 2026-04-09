# NSE PDF Chart Generator

## Overview

A web application that generates candlestick chart PDFs for NSE (Indian stock exchange) stocks. Supports two modes:
1. **All NSE Stocks** — generates a PDF with charts for every NSE-listed equity stock
2. **CSV Upload** — upload a screener CSV, select a date range from detected dates, and generate charts for those stocks only

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **API codegen**: Orval (from OpenAPI spec)
- **Frontend**: React + Vite (artifacts/nse-charts)
- **Backend**: Express API (artifacts/api-server)
- **Chart generation**: Python (yfinance + matplotlib + reportlab)
- **Build**: esbuild (CJS bundle)

## Architecture

- The Express API spawns Python child processes for PDF generation
- Job status is tracked in-memory (Map) on the API server
- Clients poll `GET /api/jobs/:jobId` every 2 seconds during generation
- Generated PDFs are saved to `output/` directory
- CSV uploads go to `tmp_uploads/` (temporary)

## Python Scripts

Located in `python_scripts/`:
- `nse_chart_generator.py` — Core chart engine. Run via CLI with `--mode all|filtered --output <path>`. Emits JSON progress lines to stdout.
- `parse_csv.py` — Parses uploaded CSV files to extract stock symbols and date range.
- `scheduler.py` — Standalone scheduler that runs the generator every weekday at 4:30 PM IST (11:00 UTC). Run with `python3 python_scripts/scheduler.py`.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/nse-charts run dev` — run frontend locally
- `python3 python_scripts/nse_chart_generator.py --mode all --output output/test.pdf` — run chart generator directly
- `python3 python_scripts/scheduler.py` — run daily scheduler

## API Endpoints

- `GET /api/jobs` — list all jobs
- `POST /api/jobs/generate-all` — start all-NSE PDF generation
- `POST /api/jobs/parse-csv` — parse uploaded CSV (multipart)
- `POST /api/jobs/generate-csv` — start filtered PDF generation
- `GET /api/jobs/:jobId` — get job status and progress
- `GET /api/jobs/:jobId/download` — download completed PDF

See `.local/skills/pnpm-workspace` for workspace structure and TypeScript setup.
