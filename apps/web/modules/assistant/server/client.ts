/**
 * The assistant's chat client: the real Vercel AI Gateway when `AI_GATEWAY_API_KEY` is set (always
 * in staging and production), else the scripted fake. `INTEGRATIONS=fake` forces the fake like
 * every other provider, unless `INTEGRATIONS_REAL` lists `gateway` (a local demo against the real
 * models while payments and email stay fake).
 */
import "server-only";
import { createGatewayClient, createGatewayFake, type ChatClient } from "@beam/integrations/anthropic";
import { appEnv, type Env } from "@/lib/integrations";

export function gatewayMode(env: Env = process.env): "real" | "fake" {
  const mode = appEnv(env);
  if (mode === "production" || mode === "staging") return "real";
  const forcedReal = (env.INTEGRATIONS_REAL ?? "").split(",").map((s) => s.trim()).includes("gateway");
  if (env.INTEGRATIONS === "fake" && !forcedReal) return "fake";
  return env.AI_GATEWAY_API_KEY ? "real" : "fake";
}

const cache = globalThis as unknown as { __beamChatClient?: ChatClient };

export function chatClient(): ChatClient {
  if (cache.__beamChatClient) return cache.__beamChatClient;
  const key = process.env.AI_GATEWAY_API_KEY;
  cache.__beamChatClient = gatewayMode() === "real" && key ? createGatewayClient({ apiKey: key }) : createGatewayFake();
  return cache.__beamChatClient;
}

/** Tests install a fake (or a scripted one); `undefined` resets to the environment's choice. */
export function setChatClient(client: ChatClient | undefined): void {
  cache.__beamChatClient = client;
}
