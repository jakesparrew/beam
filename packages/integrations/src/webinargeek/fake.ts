/** The WebinarGeek fake: records subscriptions per broadcast; one per email, like WebinarGeek. */
import { digestRequest } from "../_shared/digest";
import { errorFromStatus } from "../_shared/errors";
import { trackCall } from "../_shared/timeout";
import { noopOnCall, type OnCall } from "../_shared/types";
import type { WebinarGeekClient, WebinarGeekSubscriber, WebinarGeekSubscription } from "./client";

export type WebinarGeekFake = WebinarGeekClient & {
  readonly subscriptions: Array<WebinarGeekSubscriber & { broadcastId: string } & WebinarGeekSubscription>;
  failNext(status?: number): void;
  reset(): void;
};

export function createWebinarGeekFake(options: { onCall?: OnCall } = {}): WebinarGeekFake {
  const onCall = options.onCall ?? noopOnCall;
  const subscriptions: WebinarGeekFake["subscriptions"] = [];
  const failures: number[] = [];
  return {
    subscriptions,
    subscribe(broadcastId, subscriber) {
      const path = `/broadcasts/${broadcastId}/subscriptions`;
      return trackCall(onCall, { provider: "webinargeek", operation: "subscriptions.create", requestDigest: digestRequest({ method: "POST", path }) }, () => {
        const status = failures.shift();
        if (status !== undefined) throw errorFromStatus("webinargeek", "subscriptions.create", status);
        const email = subscriber.email.toLowerCase();
        let found = subscriptions.find((s) => s.broadcastId === broadcastId && s.email.toLowerCase() === email);
        if (!found) {
          const id = String(subscriptions.length + 1);
          found = { ...subscriber, broadcastId, id, watchUrl: `https://fake.webinargeek.com/watch/${broadcastId}/${id}` };
          subscriptions.push(found);
        }
        return { value: { id: found.id, watchUrl: found.watchUrl }, statusCode: 201 };
      });
    },
    failNext(status = 500) {
      failures.push(status);
    },
    reset() {
      subscriptions.length = 0;
      failures.length = 0;
    },
  };
}
