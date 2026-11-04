/**
 * site server actions (site spec section 4). A barrel created by site-P1: each area file in
 * `actions/` is owned by one package ("use server" there), so packages never share a file.
 * This barrel carries no directive; it only re-exports.
 */
export * from "./actions/pages";
export * from "./actions/nav";
export * from "./actions/redirects";
export * from "./actions/media";
export * from "./actions/proposals";
export * from "./actions/wordpress";
export * from "./actions/portal";
export * from "./actions/partner";
