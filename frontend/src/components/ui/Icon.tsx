/**
 * The Lucide icons the design uses, inlined.
 *
 * The design system asks for stroke-width 2.75 throughout for a rounder,
 * heavier look, so that is the default here. Paths are copied verbatim from
 * lucide.dev so swapping in the real package later is a drop-in.
 */

export type IconName =
  | 'hexagon'
  | 'chevronRight'
  | 'plus'
  | 'minus'
  | 'sliders'
  | 'upload'
  | 'folder'
  | 'check'
  | 'close'
  | 'spinner'
  | 'fit'
  | 'file'
  | 'book'
  | 'copy';

interface Glyph {
  d: string[];
  circles?: { cx: number; cy: number; r: number }[];
  rects?: { x: number; y: number; width: number; height: number; rx: number }[];
  linecap?: 'round' | 'butt';
  linejoin?: 'round' | 'miter';
}

const GLYPHS: Record<IconName, Glyph> = {
  hexagon: { d: ['M12 2.6 20 7.3v9.4L12 21.4 4 16.7V7.3Z'], linejoin: 'round' },
  chevronRight: { d: ['m9 18 6-6-6-6'], linecap: 'round' },
  plus: { d: ['M5 12h14', 'M12 5v14'], linecap: 'round' },
  minus: { d: ['M5 12h14'], linecap: 'round' },
  sliders: {
    d: ['M20 7h-9', 'M14 17H5'],
    circles: [
      { cx: 17, cy: 17, r: 3 },
      { cx: 7, cy: 7, r: 3 },
    ],
    linecap: 'round',
  },
  upload: {
    d: ['M12 13v8', 'm8 17 4-4 4 4', 'M20 16.7A5 5 0 0 0 18 7h-1.3A8 8 0 1 0 4 15.9'],
    linecap: 'round',
    linejoin: 'round',
  },
  folder: {
    d: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'],
    linecap: 'round',
    linejoin: 'round',
  },
  check: { d: ['M20 6 9 17l-5-5'], linecap: 'round', linejoin: 'round' },
  close: { d: ['M18 6 6 18', 'm6 6 12 12'], linecap: 'round' },
  spinner: { d: ['M21 12a9 9 0 1 1-6.2-8.6'], linecap: 'round' },
  fit: {
    d: [
      'M8 3H5a2 2 0 0 0-2 2v3',
      'M21 8V5a2 2 0 0 0-2-2h-3',
      'M3 16v3a2 2 0 0 0 2 2h3',
      'M16 21h3a2 2 0 0 0 2-2v-3',
    ],
    linecap: 'round',
    linejoin: 'round',
  },
  file: {
    d: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z', 'M14 2v6h6'],
    linecap: 'round',
    linejoin: 'round',
  },
  book: {
    d: ['M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2Z', 'M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7Z'],
    linecap: 'round',
    linejoin: 'round',
  },
  copy: {
    d: ['M16 4h2a2 2 0 0 1 2 2v2M4 16v2a2 2 0 0 0 2 2h2', 'M4 12V6a2 2 0 0 1 2-2h6'],
    rects: [{ x: 8, y: 8, width: 14, height: 14, rx: 2 }],
    linecap: 'round',
    linejoin: 'round',
  },
};

interface IconProps {
  name: IconName;
  size?: number;
  /** Any CSS colour; defaults to inheriting the text colour. */
  color?: string;
  strokeWidth?: number;
  className?: string;
}

export function Icon({ name, size = 16, color = 'currentColor', strokeWidth = 2.75, className }: IconProps) {
  const glyph = GLYPHS[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap={glyph.linecap}
      strokeLinejoin={glyph.linejoin}
      className={className}
      aria-hidden="true"
    >
      {glyph.d.map((d) => (
        <path key={d} d={d} />
      ))}
      {glyph.circles?.map((c) => (
        <circle key={`${c.cx}-${c.cy}`} cx={c.cx} cy={c.cy} r={c.r} />
      ))}
      {glyph.rects?.map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.width} height={r.height} rx={r.rx} />
      ))}
    </svg>
  );
}
