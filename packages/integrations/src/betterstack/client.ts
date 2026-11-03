/**
 * Better Stack (PL-32, PL-89): the monthly SLA read for the report, and the heartbeat ping
 * the tick sends (2 s timeout; a failure is logged and ignored by the caller).
 */
import { z } from "zod";
import { digestRequest } from "../_shared/digest";
import { errorFromStatus, IntegrationError } from "../_shared/errors";
import { trackCall, withTimeout } from "../_shared/timeout";
import { noopOnCall, type FetchLike, type OnCall } from "../_shared/types";

export type MonitorSla = { availabilityPct: number; downtimeSeconds: number; incidents?: number };

export interface BetterstackClient {
  /** `GET /api/v2/monitors/<id>/sla?from=YYYY-MM-DD&to=YYYY-MM-DD`. */
  getMonitorSla(input: { monitorId: string; from: Date | string; to: Date | string }): Promise<MonitorSla>;
  /** `GET <heartbeat url>`, 2 s timeout. Returns false instead of throwing. */
  pingHeartbeat(url: string): Promise<boolean>;
}

export type BetterstackClientOptions = { apiToken: string; onCall?: OnCall; fetch?: FetchLike; baseUrl?: string };

const SlaResponse = z.object({
  data: z.object({
    attributes: z.object({
      availability: z.number(),
      total_downtime: z.number().nonnegative(),
      number_of_incidents: z.number().int().nonnegative().optional(),
    }),
  }),
});

const day = (value: Date | string): string => (typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10));

export function createBetterstackClient(options: BetterstackClientOptions): BetterstackClient {
  const onCall = options.onCall ?? noopOnCall;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const base = (options.baseUrl ?? "https://uptime.betterstack.com").replace(/\/$/, "");
  return {
    getMonitorSla({ monitorId, from, to }) {
      const operation = "monitors.sla";
      const path = `/api/v2/monitors/${encodeURIComponent(monitorId)}/sla`;
      const params = { from: day(from), to: day(to) };
      return trackCall(onCall, { provider: "betterstack", operation, requestDigest: digestRequest({ method: "GET", path, params }) }, () =>
        withTimeout(
          async (signal) => {
            const res = await doFetch(`${base}${path}?${new URLSearchParams(params).toString()}`, {
              headers: { authorization: `Bearer ${options.apiToken}`, accept: "application/json" },
              signal,
            });
            if (!res.ok) throw errorFromStatus("betterstack", operation, res.status);
            const parsed = SlaResponse.safeParse(await res.json().catch(() => null));
            if (!parsed.success) {
              throw new IntegrationError({ provider: "betterstack", operation, retryable: false, statusCode: res.status, code: "invalid_response", message: "betterstack monitors.sla: unexpected response" });
            }
            const a = parsed.data.data.attributes;
            const value: MonitorSla = { availabilityPct: a.availability, downtimeSeconds: Math.round(a.total_downtime) };
            if (a.number_of_incidents !== undefined) value.incidents = a.number_of_incidents;
            return { value, statusCode: res.status };
          },
          10_000,
          { provider: "betterstack", operation },
        ),
      );
    },
    async pingHeartbeat(url) {
      try {
        return await trackCall(onCall, { provider: "betterstack", operation: "heartbeat.ping", requestDigest: digestRequest({ method: "GET", path: "/heartbeat" }) }, () =>
          withTimeout(
            async (signal) => {
              const res = await doFetch(url, { method: "GET", signal });
              if (!res.ok) throw errorFromStatus("betterstack", "heartbeat.ping", res.status);
              return { value: true, statusCode: res.status };
            },
            2_000,
            { provider: "betterstack", operation: "heartbeat.ping" },
          ),
        );
      } catch {
        return false;
      }
    },
  };
}
