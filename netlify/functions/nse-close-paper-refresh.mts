import type { Config } from "@netlify/functions";
import { PaperServiceError, runGlobalDailyPaperRefresh } from "../lib/paper-pg-service.mts";

// Response headers are set in code on the returned Response (`[[headers]]` in netlify.toml applies only to static CDN responses).
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
    const summary = await runGlobalDailyPaperRefresh(undefined, "IN");
    console.log(
      `[nse-close-paper-refresh] Completed scope=${summary.market_scope} as_of=${summary.as_of_date}: quotes=${summary.quotes_updated}, filled=${summary.orders_filled}, portfolios=${summary.portfolios_snapshotted}, idle=${Boolean(summary.skipped_idle)}, next_run=${nextRun || "n/a"}`,
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
      console.warn("[nse-close-paper-refresh] Skipped because database is not provisioned yet.");
      return Response.json(
        { status: "skipped", detail: err.message },
        { status: 503, headers: RESPONSE_HEADERS },
      );
    }
    const msg =
      err instanceof Error
        ? err.message.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted]")
        : "Unknown error";
    console.error("[nse-close-paper-refresh] Refresh error:", msg);
    return Response.json(
      { status: "error", detail: "Scheduled NSE close paper refresh failed." },
      { status: 500, headers: RESPONSE_HEADERS },
    );
  }
};

// 10:15 UTC Mon-Fri = 3:45 PM IST (15 mins after NSE 3:30 PM IST close; India does not observe DST).
export const config: Config = {
  schedule: "15 10 * * 1-5",
};
