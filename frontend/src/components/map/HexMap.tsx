/**
 * The hexagon map: a deck.gl `H3HexagonLayer` over a MapLibre base map.
 *
 * The layer is fed `HexCell[]` exactly as the backend will send it, so the
 * only thing that changes when the engine is wired up is where the cells come
 * from — not how they are drawn.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { WebMercatorViewport, type MapViewState, type PickingInfo } from '@deck.gl/core';
import { Map } from 'react-map-gl/maplibre';
import { cellToLatLng } from 'h3-js';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { HexCell, ValueScale, Variable } from '../../types';
import { rampGradient, rampRgb, type Ramp } from '../../lib/ramp';
import { Icon } from '../ui/Icon';

/**
 * CARTO's Positron — a quiet grey base that lets the hexagons carry the
 * colour. Override with `VITE_MAP_STYLE` to point at a self-hosted style.
 */
const MAP_STYLE =
  import.meta.env.VITE_MAP_STYLE ?? 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

/** The cream hairline between hexagons, matching the design's `--color-bg`. */
const CELL_OUTLINE: [number, number, number, number] = [245, 234, 216, 140];

const FIT_PADDING = 48;
const MIN_ZOOM = 2;
const MAX_ZOOM = 14;

interface Size {
  width: number;
  height: number;
}

interface HoverState {
  x: number;
  y: number;
  cell: HexCell;
}

interface HexMapProps {
  cells: HexCell[];
  variable: Variable;
  /** Which number on each cell to draw: its own units, or normalised 0-1. */
  scale: ValueScale;
  ramp: Ramp;
  resolution: number;
  /** Formats a value of the current scale for the legend and tooltip. */
  format: (value: number) => string;
}

/** The view that frames every cell in `cells` inside a viewport of `size`. */
function fitToCells(cells: HexCell[], size: Size): MapViewState | null {
  if (cells.length === 0 || size.width === 0 || size.height === 0) return null;

  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  for (const cell of cells) {
    const [lat, lng] = cellToLatLng(cell.h3);
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }

  const fitted = new WebMercatorViewport(size).fitBounds(
    [
      [west, south],
      [east, north],
    ],
    { padding: FIT_PADDING },
  );

  return {
    longitude: fitted.longitude,
    latitude: fitted.latitude,
    zoom: fitted.zoom,
    pitch: 0,
    bearing: 0,
  };
}

/** The number the map is currently drawing for a cell. */
const valueOf = (cell: HexCell, scale: ValueScale) =>
  scale === 'normalized' ? cell.normalized : cell.value;

export function HexMap({ cells, variable, scale, ramp, resolution, format }: HexMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  /**
   * Where the user has panned or zoomed to, tagged with the study area it
   * belongs to. Null — or a tag from a different area — falls back to the
   * framed view, which is how switching projects re-frames the map while
   * switching variables leaves the view where you put it.
   */
  const [userView, setUserView] = useState<{ gridKey: string; view: MapViewState } | null>(null);

  // Measure before paint so the first frame deck.gl draws is already framed —
  // setting the view afterwards races deck's own view-state echo and loses.
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;

    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize((current) =>
        current?.width === width && current?.height === height ? current : { width, height },
      );
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** Identifies a study area; switching variables keeps the same grid. */
  const gridKey = cells.length > 0 ? `${cells.length}:${cells[0].h3}` : '';

  // Derived rather than set from an effect: deck.gl echoes its view state back
  // on mount, which would overwrite anything an effect had just set.
  const framedView = useMemo(
    () => (size ? fitToCells(cells, size) : null),
    [cells, size],
  );

  const viewState = userView?.gridKey === gridKey ? userView.view : framedView;

  const fit = useCallback(() => setUserView(null), []);

  /**
   * The value range actually present, so the ramp spans the real data.
   * Normalised values keep a fixed 0-1 range instead: rescaling them to the
   * extremes present would defeat the point of a common scale, since two
   * variables would no longer share one legend.
   */
  const [min, max] = useMemo(() => {
    if (scale === 'normalized') return [0, 1];
    if (cells.length === 0) return [variable.min, variable.max];
    let lo = Infinity;
    let hi = -Infinity;
    for (const cell of cells) {
      if (cell.value < lo) lo = cell.value;
      if (cell.value > hi) hi = cell.value;
    }
    return [lo, hi];
  }, [cells, scale, variable.min, variable.max]);

  const onHover = useCallback((info: PickingInfo<HexCell>) => {
    setHover(info.object ? { x: info.x, y: info.y, cell: info.object } : null);
  }, []);

  const layer = useMemo(
    () =>
      new H3HexagonLayer<HexCell>({
        id: 'hexagons',
        data: cells,
        getHexagon: (d) => d.h3,
        getFillColor: (d) =>
          rampRgb(ramp, max === min ? 0.5 : (valueOf(d, scale) - min) / (max - min)),
        getLineColor: CELL_OUTLINE,
        lineWidthMinPixels: 0.7,
        stroked: true,
        filled: true,
        extruded: false,
        pickable: true,
        onHover,
        updateTriggers: {
          // Colours depend on the scale and the range, not just the cell list.
          getFillColor: [variable.id, scale, min, max, ramp],
        },
      }),
    [cells, ramp, scale, min, max, variable.id, onHover],
  );

  const zoomBy = (delta: number) => {
    if (!viewState) return;
    setUserView({
      gridKey,
      view: { ...viewState, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, viewState.zoom + delta)) },
    });
  };

  return (
    <div className="map-canvas" ref={container}>
      {viewState && (
        <DeckGL
          viewState={viewState}
          onViewStateChange={({ viewState: next }) =>
            setUserView({ gridKey, view: next as MapViewState })
          }
          controller={{ dragRotate: false }}
          layers={[layer]}
          getCursor={({ isDragging }) => (isDragging ? 'grabbing' : 'grab')}
        >
          <Map mapStyle={MAP_STYLE} attributionControl={false} />
        </DeckGL>
      )}

      <div className="map-heading">
        <div className="map-heading-title">{variable.name}</div>
        <div className="map-heading-hint muted-55">{variable.hint}</div>
      </div>

      <div className="map-controls">
        <button type="button" className="btn btn-icon map-btn" aria-label="Zoom in" onClick={() => zoomBy(0.5)}>
          <Icon name="plus" />
        </button>
        <button type="button" className="btn btn-icon map-btn" aria-label="Zoom out" onClick={() => zoomBy(-0.5)}>
          <Icon name="minus" />
        </button>
        <button type="button" className="btn btn-icon map-btn" aria-label="Fit to data" onClick={fit}>
          <Icon name="fit" />
        </button>
      </div>

      <div className="map-legend">
        <div className="map-legend-title muted-55">
          {variable.name}
          {scale === 'normalized' && ' · normalized'}
        </div>
        <div className="map-legend-bar" style={{ background: rampGradient(ramp) }} />
        <div className="map-legend-scale">
          <span>{format(min)}</span>
          <span>{format(max)}</span>
        </div>
      </div>

      <div className="map-footnote muted-45">
        H3 resolution {resolution} · {cells.length.toLocaleString()} hexagons · drag to pan
      </div>

      {hover && (
        <div
          className="map-tooltip"
          style={{
            left: Math.min(hover.x + 16, (size?.width ?? 0) - 190),
            top: hover.y + 16,
          }}
        >
          <div className="map-tooltip-id">{hover.cell.h3}</div>
          <div className="map-tooltip-value">{format(valueOf(hover.cell, scale))}</div>
          <div className="map-tooltip-var">{variable.name}</div>
        </div>
      )}
    </div>
  );
}
