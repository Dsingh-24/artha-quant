import type { Config } from "@netlify/functions";
import { PaperServiceError, runGlobalDailyPaperRefresh } from "../lib/paper-pg-service.mts";

const RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

export default async (req: Request): Promise<Response> => {
  let nextRun = "";
  try {
    const payload = (await req.json()) as { next_run?: string };
    if (payload && typeof payload.next_run === "string") {
      nextRun = payload.next_run;
    }
  } catch {
    // Manual invocation via `netlify functions:invoke` may omit JSON body
  }

  try {
    const summary = await runGlobalDailyPaperRefresh();
    console.log(
      `[daily-paper-refresh] Completed as_of=${summary.as_of_date}: quotes=${summary.quotes_updated}, filled=${summary.orders_filled}, portfolios=${summary.portfolios_snapshotted}, next_run=${nextRun || "n/a"}`,
    );
    return Response.json(
      {
        status: "ok",
        next_run: nextRun || null,
        ...summary,
      },
      { status: 200, headers: RESPONSE_HEADERS },
    );
  } catch (err) {
    if (err instanceof PaperServiceError && err.status === 503) {
      console.warn("[daily-paper-refresh] Skipped because database is not provisioned yet.");
      return Response.json(
        { status: "skipped", detail: err.message },
        { status: 503, headers: RESPONSE_HEADERS },
      );
    }
    const msg = err instanceof Error ? err.message.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted]") : "Unknown error";
    console.error("[daily-paper-refresh] Refresh error:", msg);
    return Response.json(
      { status: "error", detail: "Scheduled daily paper refresh failed." },
      { status: 500, headers: RESPONSE_HEADERS },
    );
  }
};

// 21:30 UTC Mon-Fri = 4:30 PM EST / 5:30 PM EDT (after US market close) and 3:00 AM IST (after NSE close).
export const config: Config = {
  schedule: "30 21 * * 1-5",
};
