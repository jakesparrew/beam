"use client";

/**
 * Charts of the person page's activity panel, drawn as plain SVG (no chart library):
 * - `StackedBars`: one bar per week or month, segments in a fixed categorical order with a 2px
 *   surface gap, a rounded top, a recessive grid on one axis, a legend with totals above, a hover
 *   column with a tooltip (also on keyboard focus), and the same numbers as a table.
 * - `WhenGrid`: weekday × part of the day, one sequential hue (light = few, dark = many visits).
 * Palette (validated for colour-vision deficiency and contrast): gold, blue, terracotta, green,
 * purple, always assigned in that order.
 */
import { useState } from "react";

export const SERIES_COLORS = ["#b58322", "#3f5bb5", "#c55a3f", "#1a9070", "#8e5cc2"] as const;

export type Series = { key: string; label: string; values: number[] };

const W = 640;
const H = 190;
const PAD = { left: 30, right: 8, top: 10, bottom: 24 };

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

/** A bar segment with only its top corners rounded (the data end); the base stays square. */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function StackedBars({ title, labels, series, emptyText, tableLabel, totalLabel }: { title: string; labels: string[]; series: Series[]; emptyText: string; tableLabel: string; totalLabel: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const totals = labels.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const slot = plotW / Math.max(1, n);
  const barW = Math.max(6, Math.min(30, slot * 0.62));
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const every = Math.max(1, Math.ceil(n / 8));
  const grand = totals.reduce((a, b) => a + b, 0);
  const seriesTotals = series.map((s) => s.values.reduce((a, b) => a + b, 0));

  return (
    <figure className="grid gap-2">
      <figcaption className="grid gap-1.5">
        <span className="text-sm font-semibold">{title}</span>
        <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {series.map((s, i) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-[3px]" style={{ background: SERIES_COLORS[i] }} aria-hidden="true" />
              {s.label} <span className="tabular-nums text-foreground">{seriesTotals[i]}</span>
            </span>
          ))}
        </span>
      </figcaption>
      {grand === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title}: ${series.map((s, i) => `${s.label} ${seriesTotals[i]}`).join(", ")}`}>
            {[0, max / 2, max].map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity={v === 0 ? 0.25 : 0.1} strokeWidth="1" />
                <text x={PAD.left - 6} y={y(v) + 3.5} fontSize="10" textAnchor="end" fill="currentColor" fillOpacity="0.55">
                  {Number.isInteger(v) ? v : v.toFixed(1)}
                </text>
              </g>
            ))}
            {labels.map((label, i) => {
              const cx = PAD.left + slot * i + slot / 2;
              let acc = 0;
              const parts = series.map((s, si) => ({ v: s.values[i] ?? 0, si })).filter((p) => p.v > 0);
              return (
                <g key={i}>
                  {hover === i ? <rect x={PAD.left + slot * i + 1} y={PAD.top} width={slot - 2} height={plotH} rx="4" fill="currentColor" fillOpacity="0.05" /> : null}
                  {parts.map((p, k) => {
                    const top = y(acc + p.v);
                    const bottom = y(acc);
                    acc += p.v;
                    const h = Math.max(0, bottom - top - (k > 0 ? 2 : 0));
                    const isTop = k === parts.length - 1;
                    const x = cx - barW / 2;
                    return isTop ? (
                      <path key={p.si} d={topRounded(x, top, barW, h, 4)} fill={SERIES_COLORS[p.si]} />
                    ) : (
                      <rect key={p.si} x={x} y={top} width={barW} height={h} fill={SERIES_COLORS[p.si]} />
                    );
                  })}
                  {i % every === 0 || i === n - 1 ? (
                    <text x={cx} y={H - 7} fontSize="10" textAnchor="middle" fill="currentColor" fillOpacity="0.55">
                      {label}
                    </text>
                  ) : null}
                  <rect
                    x={PAD.left + slot * i}
                    y={PAD.top}
                    width={slot}
                    height={plotH + PAD.bottom}
                    fill="transparent"
                    tabIndex={0}
                    aria-label={`${label}: ${series.map((s) => `${s.label} ${s.values[i] ?? 0}`).join(", ")}`}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                    className="outline-none"
                  />
                </g>
              );
            })}
          </svg>
          {hover !== null ? (
            <div
              className="pointer-events-none absolute top-1 z-10 w-60 rounded-xl border bg-popover px-3 py-2 text-xs whitespace-nowrap shadow-lg"
              style={(() => {
                // Beside the hovered bar, on the side with room, never on top of it.
                const at = ((PAD.left + slot * hover + slot / 2) / W) * 100;
                const gap = ((barW / 2 + 8) / W) * 100;
                return at > 50 ? { right: `${100 - at + gap}%` } : { left: `${at + gap}%` };
              })()}
              role="status"
            >
              <p className="mb-1 font-semibold">{labels[hover]}</p>
              {series.map((s, i) => (
                <p key={s.key} className="flex items-center justify-between gap-4">
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <span className="size-2 rounded-[2px]" style={{ background: SERIES_COLORS[i] }} aria-hidden="true" />
                    {s.label}
                  </span>
                  <span className="tabular-nums">{s.values[hover] ?? 0}</span>
                </p>
              ))}
              <p className="mt-1 flex justify-between gap-4 border-t pt-1 font-semibold">
                <span>{totalLabel}</span>
                <span className="tabular-nums">{totals[hover]}</span>
              </p>
            </div>
          ) : null}
        </div>
      )}
      {grand > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">{tableLabel}</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left tabular-nums">
              <thead>
                <tr>
                  <th className="py-1 pr-3 font-medium" />
                  {series.map((s) => (
                    <th key={s.key} className="py-1 pr-3 font-medium">
                      {s.label}
                    </th>
                  ))}
                  <th className="py-1 font-medium">{totalLabel}</th>
                </tr>
              </thead>
              <tbody>
                {labels.map((l, i) =>
                  totals[i] ? (
                    <tr key={i} className="border-t">
                      <td className="py-1 pr-3">{l}</td>
                      {series.map((s) => (
                        <td key={s.key} className="py-1 pr-3">
                          {s.values[i] ?? 0}
                        </td>
                      ))}
                      <td className="py-1">{totals[i]}</td>
                    </tr>
                  ) : null,
                )}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </figure>
  );
}

/** Light to dark in one hue (gold): 0 is the surface, the busiest cell the darkest step. */
const RAMP = ["#f7efdc", "#ecd59e", "#d9b25c", "#b58322", "#7d5810"];

export function WhenGrid({ title, heat, weekdays, dayparts, emptyText, visitsLabel }: { title: string; heat: number[][]; weekdays: string[]; dayparts: string[]; emptyText: string; visitsLabel: string }) {
  const max = Math.max(0, ...heat.flat());
  const step = (v: number) => (v === 0 || max === 0 ? -1 : Math.min(RAMP.length - 1, Math.ceil((v / max) * (RAMP.length - 1))));
  return (
    <figure className="grid gap-2">
      <figcaption className="text-sm font-semibold">{title}</figcaption>
      {max === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="grid grid-cols-[auto_repeat(7,minmax(0,1fr))] gap-1 text-xs" role="table" aria-label={title}>
          <span role="columnheader" />
          {weekdays.map((d) => (
            <span key={d} role="columnheader" className="pb-1 text-center text-muted-foreground">
              {d}
            </span>
          ))}
          {dayparts.map((part, pi) => (
            <div key={part} role="row" className="contents">
              <span role="rowheader" className="flex items-center pr-2 text-muted-foreground">
                {part}
              </span>
              {weekdays.map((d, wi) => {
                const v = heat[wi]?.[pi] ?? 0;
                const s = step(v);
                return (
                  <span
                    key={d}
                    role="cell"
                    title={`${d} ${part}: ${v} ${visitsLabel}`}
                    className={`grid h-9 place-items-center rounded-md tabular-nums ${s < 0 ? "border border-dashed text-muted-foreground/40" : ""}`}
                    style={s >= 0 ? { background: RAMP[s], color: s >= 3 ? "#fffaef" : "#4a3305" } : undefined}
                  >
                    {v || ""}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </figure>
  );
}
