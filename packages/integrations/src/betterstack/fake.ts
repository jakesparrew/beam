/**
 * The Better Stack fake (runbook section 1.5): the heartbeat is skipped, the SLA returns
 * 99.95 % availability and 0 incidents unless a test sets other figures or a failure.
 */
import { digestRequest } from "../_shared/digest";
import { errorFromStatus } from "../_shared/errors";
import { trackCall } from "../_shared/timeout";
import { noopOnCall, type FakeCall, type OnCall } from "../_shared/types";
import type { BetterstackClient, MonitorSla } from "./client";

export const FAKE_AVAILABILITY_PCT = 99.95;

export type BetterstackFake = BetterstackClient & {
  readonly calls: FakeCall<{ monitorId: string; from: string; to: string }>[];
  /** Number of heartbeat pings received (they are skipped, only counted). */
  readonly heartbeats: number;
  setSla(sla: { availabilityPct: number; incidents?: number; downtimeSeconds?: number }): void;
  failNext(status?: number): void;
  reset(): void;
};

const day = (value: Date | string): string => (typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10));

/** Seconds from the start of `from` to the end of `to` (both `YYYY-MM-DD`, inclusive). */
function periodSeconds(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`) + 86_400_000;
  return Math.max(0, (end - start) / 1000);
}

export function createBetterstackFake(options: { onCall?: OnCall; now?: () => Date } = {}): BetterstackFake {
  const onCall = options.onCall ?? noopOnCall;
  const now = options.now ?? (() => new Date());
  const calls: FakeCall<{ monitorId: string; from: string; to: string }>[] = [];
  const failures: number[] = [];
  let sla: { availabilityPct: number; incidents: number; downtimeSeconds?: number } = { availabilityPct: FAKE_AVAILABILITY_PCT, incidents: 0 };
  let heartbeats = 0;

  return {
    calls,
    get heartbeats() {
      return heartbeats;
    },
    getMonitorSla({ monitorId, from, to }) {
      const input = { monitorId, from: day(from), to: day(to) };
      calls.push({ operation: "monitors.sla", input, at: now() });
      const path = `/api/v2/monitors/${encodeURIComponent(monitorId)}/sla`;
      return trackCall(
        onCall,
        { provider: "betterstack", operation: "monitors.sla", requestDigest: digestRequest({ method: "GET", path, params: { from: input.from, to: input.to } }) },
        () => {
          const status = failures.shift();
          if (status !== undefined) throw errorFromStatus("betterstack", "monitors.sla", status);
          const downtime = sla.downtimeSeconds ?? Math.round((periodSeconds(input.from, input.to) * (100 - sla.availabilityPct)) / 100);
          const value: MonitorSla = { availabilityPct: sla.availabilityPct, downtimeSeconds: downtime, incidents: sla.incidents };
          return { value, statusCode: 200 };
        },
      );
    },
    pingHeartbeat() {
      heartbeats += 1;
      return Promise.resolve(true);
    },
    setSla(next) {
      sla = { availabilityPct: next.availabilityPct, incidents: next.incidents ?? 0, ...(next.downtimeSeconds === undefined ? {} : { downtimeSeconds: next.downtimeSeconds }) };
    },
    failNext(status = 503) {
      failures.push(status);
    },
    reset() {
      calls.length = 0;
      failures.length = 0;
      heartbeats = 0;
      sla = { availabilityPct: FAKE_AVAILABILITY_PCT, incidents: 0 };
    },
  };
}
