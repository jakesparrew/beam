/** `@beam/integrations/ads`: the ads interfaces, the real Meta and Google clients, the selector and the fakes. */
export * from "./types";
export * from "./fake";
export * from "./client";
export { amountToCents, mapMetaInsight, metaLeads, META_GRAPH_API } from "./meta";
export { googleQuery, mapGoogleRow, microsToCents, GOOGLE_ADS_API } from "./google";
