"""
scheduler.py — Runs nse_chart_generator.py every weekday at 4:30 PM IST.

Setup:
    python scheduler.py   (keep running with Replit Always On)
"""

import schedule, time, logging, subprocess, os
from datetime import datetime

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'output')


def job():
    if datetime.today().weekday() >= 5:
        log.info("Weekend — skipping.")
        return
    today = datetime.today().strftime('%Y-%m-%d')
    out = os.path.join(OUTPUT_DIR, f"NSE_Charts_{today}.pdf")
    log.info(f"Starting NSE chart generator -> {out}")
    script = os.path.join(os.path.dirname(__file__), 'nse_chart_generator.py')
    try:
        result = subprocess.run(
            ['python3', script, '--mode', 'all', '--output', out, '--history-months', '6'],
            capture_output=False, text=True)
        if result.returncode == 0:
            log.info(f"Done. PDF saved to {out}")
        else:
            log.error(f"Generator failed with code {result.returncode}")
    except Exception as e:
        log.error(f"Error: {e}")


# 4:30 PM IST = 11:00 UTC
schedule.every().day.at("11:00").do(job)

log.info("Scheduler running — weekdays at 4:30 PM IST.")
log.info(f"Next run: {schedule.next_run()}")

while True:
    schedule.run_pending()
    time.sleep(30)
