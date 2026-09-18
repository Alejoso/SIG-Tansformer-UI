/**
 * The two colour ramps the map uses: warm terracotta for input variables,
 * sage for model output. Both are pulled from the Organic accent ramps so the
 * map reads as part of the same system as the rest of the interface.
 */

import type { MapMode } from '../types';

export type Rgb = [number, number, number];

export const RAMP_INPUT = ['#fff2eb', '#f6a06b', '#8c491a'] as const;
export const RAMP_MODEL = ['#f0fae1', '#8fa073', '#3d472b'] as const;

export type Ramp = readonly [string, string, string];

export const rampFor = (mode: MapMode): Ramp => (mode === 'input' ? RAMP_INPUT : RAMP_MODEL);

const hexToRgb = (hex: string): Rgb => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

export const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

/** Sample the ramp at `t` (0–1) as an RGB triple — what deck.gl wants. */
export function rampRgb(ramp: Ramp, t: number): Rgb {
  const u = clamp01(t);
  const [lo, mid, hi] = ramp;
  return u < 0.5
    ? mix(hexToRgb(lo), hexToRgb(mid), u * 2)
    : mix(hexToRgb(mid), hexToRgb(hi), (u - 0.5) * 2);
}

/** Same sample as a CSS colour — what swatches, legends and gradients want. */
export function rampCss(ramp: Ramp, t: number): string {
  const [r, g, b] = rampRgb(ramp, t);
  return `rgb(${r},${g},${b})`;
}

/** A left-to-right gradient across the whole ramp, for the map legend. */
export function rampGradient(ramp: Ramp): string {
  const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => rampCss(ramp, t));
  return `linear-gradient(90deg,${stops.join(',')})`;
}

/** The three-stop diagonal swatch beside each variable in the sidebar. */
export function rampSwatch(ramp: Ramp, index: number): string {
  const a = 0.02 + index * 0.11;
  const b = 0.55 + (index % 3) * 0.15;
  const c = 1 - index * 0.07;
  return `linear-gradient(135deg,${rampCss(ramp, a)},${rampCss(ramp, b)},${rampCss(ramp, c)})`;
}
