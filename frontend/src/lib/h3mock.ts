/**
 * Mock H3 cells so the map has something to draw before the engine exists.
 *
 * The real values will arrive from `GET /api/projects/{id}/hexes` as
 * `HexCell[]` — the exact shape this produces — so the map layer does not
 * change when the backend lands. Only this generator gets deleted.
 */

import { cellToLocalIj, gridDisk, latLngToCell } from 'h3-js';
import type { HexCell } from '../types';
import { clamp01 } from './ramp';

/**
 * The smooth spatial field the mockup used, carried over so the generated map
 * has the same character as the design: broad bands rather than noise.
 */
function field(seed: number, q: number, r: number): number {
  const x = q * 0.29 + seed;
  const y = r * 0.4 + seed * 1.7;
  const v =
    Math.sin(x) * 0.5 +
    Math.cos(y * 0.9) * 0.34 +
    Math.sin((x + y) * 0.52) * 0.3 +
    Math.cos((x - y) * 0.21 + seed) * 0.24;
  return clamp01((v + 1.18) / 2.36);
}

/**
 * A wobbly boundary, so the grid reads as a study area with a coastline-ish
 * outline instead of a perfect disc.
 */
function insideBoundary(i: number, j: number, k: number): boolean {
  const radius = Math.sqrt(i * i + j * j) / k;
  const angle = Math.atan2(j, i);
  const edge =
    0.86 +
    0.15 * Math.sin(angle * 3.1) +
    0.11 * Math.cos(angle * 1.7 + 0.6) +
    0.07 * Math.sin(angle * 5.3 + 1.9);
  return radius <= edge;
}

export interface MockGridOptions {
  centre: [number, number];
  resolution: number;
  /** Ring size around the origin cell. 44 lands near 4,800 cells after carving. */
  k?: number;
}

/**
 * Build the set of cells for a study area. Shared by every variable in a
 * project so they all cover exactly the same hexagons.
 */
export function mockGrid({ centre, resolution, k = 44 }: MockGridOptions): string[] {
  const origin = latLngToCell(centre[0], centre[1], resolution);
  return gridDisk(origin, k).filter((cell) => {
    try {
      const { i, j } = cellToLocalIj(origin, cell);
      const oi = cellToLocalIj(origin, origin);
      return insideBoundary(i - oi.i, j - oi.j, k);
    } catch {
      // cellToLocalIj fails across icosahedron edges; drop those cells.
      return false;
    }
  });
}

/**
 * Give every cell in the grid a value for one variable, scaled into the
 * variable's own [min, max] range.
 */
export function mockValues(
  cells: string[],
  origin: string,
  seed: number,
  min: number,
  max: number,
): HexCell[] {
  const oi = cellToLocalIj(origin, origin);
  return cells.map((cell) => {
    let t = 0.5;
    try {
      const { i, j } = cellToLocalIj(origin, cell);
      t = field(seed, i - oi.i, j - oi.j);
    } catch {
      // Keep the cell rather than dropping it; a mid-ramp value is fine here.
    }
    return { h3: cell, value: min + (max - min) * t };
  });
}

export const originCell = (centre: [number, number], resolution: number) =>
  latLngToCell(centre[0], centre[1], resolution);
