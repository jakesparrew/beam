// Linted as apps/web/modules/site/ai.ts: the Anthropic SDK outside packages/integrations/src/anthropic/ (PL-51).
import Anthropic from "@anthropic-ai/sdk";

export const client = new Anthropic();
