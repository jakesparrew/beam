/**
 * WebinarGeek API v2 (owner requirement 5: BEAM hosts its webinars on WebinarGeek). One call:
 * register a person for a broadcast, `POST https://app.webinargeek.com/api/v2/broadcasts/{id}/subscriptions`
 * with the header `Api-Token` and the JSON body `{ firstname, surname, email, external_id }`
 * (`firstname` and `email` are required). The response carries the subscription `id` and the
 * personal `watch_link`. Source: WebinarGeek's API blueprint (webinargeek.docs.apiary.io).
 *
 * Only the `bookings.register_webinargeek` job calls it. 401/403 (bad token, or a plan without API
 * access) and other 4xx are permanent; 408, 425, 429 and 5xx retry. Whether BEAM's plan includes
 * API access is still open: without `WEBINARGEEK_API_TOKEN` the app runs the fake.
 */
import { digestRequest } from "../_shared/digest";
import { errorFromStatus } from "../_shared/errors";
import { trackCall, withTimeout } from "../_shared/timeout";
import { noopOnCall, type FetchLike, type OnCall } from "../_shared/types";

export const WEBINARGEEK_BASE_URL = "https://app.webinargeek.com/api/v2";

export type WebinarGeekSubscriber = {
  email: string;
  firstName: string;
  lastName?: string | null;
  /** Our booking id, so a subscription can be traced back. */
  externalId?: string;
};

export type WebinarGeekSubscription = { id: string; watchUrl: string | null };

export interface WebinarGeekClient {
  subscribe(broadcastId: string, subscriber: WebinarGeekSubscriber): Promise<WebinarGeekSubscription>;
}

export type WebinarGeekClientOptions = { apiToken: string; baseUrl?: string; onCall?: OnCall; fetch?: FetchLike; timeoutMs?: number };

export function createWebinarGeekClient(options: WebinarGeekClientOptions): WebinarGeekClient {
  const onCall = options.onCall ?? noopOnCall;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const base = (options.baseUrl ?? WEBINARGEEK_BASE_URL).replace(/\/$/, "");
  const operation = "subscriptions.create";
  return {
    subscribe(broadcastId, subscriber) {
      const path = `/broadcasts/${encodeURIComponent(broadcastId)}/subscriptions`;
      return trackCall(onCall, { provider: "webinargeek", operation, requestDigest: digestRequest({ method: "POST", path }) }, () =>
        withTimeout(
          async (signal) => {
            const res = await doFetch(`${base}${path}`, {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json", "api-token": options.apiToken },
              body: JSON.stringify({
                firstname: subscriber.firstName,
                ...(subscriber.lastName ? { surname: subscriber.lastName } : {}),
                email: subscriber.email,
                ...(subscriber.externalId ? { external_id: subscriber.externalId } : {}),
              }),
              signal,
            });
            if (!res.ok) throw errorFromStatus("webinargeek", operation, res.status, await res.text().catch(() => ""));
            const body = (await res.json()) as { id?: unknown; watch_link?: unknown };
            return {
              value: { id: typeof body.id === "number" || typeof body.id === "string" ? String(body.id) : "", watchUrl: typeof body.watch_link === "string" && body.watch_link.startsWith("https://") ? body.watch_link : null },
              statusCode: res.status,
            };
          },
          options.timeoutMs ?? 15_000,
          { provider: "webinargeek", operation },
        ),
      );
    },
  };
}
