/**
 * The embed script served by `GET /api/public/forms/embed.js` (forms spec section 5 "Embed
 * script"): under 4 KB, no dependencies. It finds `<div data-beam-form="<slug>"
 * data-locale="nl|fr|en">` (optional `data-title`), creates a lazy iframe to
 * `/<locale>/f/<slug>?embed=1&embedHost=<location.host>&ref=<origin+path>` plus the parent page's
 * `utm_*`, `l` and `src` query values, resizes it on `beam-form:height` messages and re-dispatches
 * `beam-form:completed` as `CustomEvent('beam-form:completed', { detail })` on the host window.
 * Messages are accepted from the BEAM origin only; `detail` keeps only
 * `{ slug, kind, locale, endingKind }`.
 */

/** The query keys of the host page that the iframe receives (attribution, rule A1). */
export const EMBED_FORWARDED_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "l", "src"] as const;

/** The script text for a BEAM origin (`https://beam.example.com`, no trailing slash). */
export function embedScript(origin: string): string {
  const o = JSON.stringify(origin.replace(/\/+$/, ""));
  const q = JSON.stringify(EMBED_FORWARDED_PARAMS);
  return `(function(){"use strict";
var O=${o},Q=${q},S={nl:"nl",fr:"fr",en:"en"},F=[];
function init(){var p=new URLSearchParams(location.search),els=document.querySelectorAll("div[data-beam-form]");
for(var i=0;i<els.length;i++){var el=els[i];if(el.getAttribute("data-beam-ready"))continue;
var slug=el.getAttribute("data-beam-form")||"";if(!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug))continue;
el.setAttribute("data-beam-ready","1");var loc=S[el.getAttribute("data-locale")]||"nl";
var u=new URL(O+"/"+loc+"/f/"+slug);u.searchParams.set("embed","1");u.searchParams.set("embedHost",location.host);
u.searchParams.set("ref",location.origin+location.pathname);
for(var j=0;j<Q.length;j++){var v=p.get(Q[j]);if(v)u.searchParams.set(Q[j],v.slice(0,200));}
var f=document.createElement("iframe");f.src=u.toString();f.setAttribute("loading","lazy");
f.title=el.getAttribute("data-title")||slug;f.style.cssText="width:100%;border:0;min-height:320px;display:block";
f.setAttribute("data-beam-frame",slug);el.appendChild(f);F.push(f);}}
function frameOf(src){for(var i=0;i<F.length;i++)if(F[i].contentWindow===src)return F[i];return F.length===1?F[0]:null;}
window.addEventListener("message",function(e){if(e.origin!==O)return;var d=e.data;if(!d||typeof d!=="object")return;
if(d.type==="beam-form:height"&&typeof d.h==="number"&&isFinite(d.h)){var f=frameOf(e.source);if(f)f.style.height=Math.max(100,Math.min(20000,Math.round(d.h)))+"px";return;}
if(d.type==="beam-form:completed"){window.dispatchEvent(new CustomEvent("beam-form:completed",{detail:{slug:String(d.slug),kind:String(d.kind),locale:String(d.locale),endingKind:String(d.endingKind)}}));}});
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();})();
`;
}
