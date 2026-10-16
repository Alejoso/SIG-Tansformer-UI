/**
 * The map area: the engine's pre-rendered layer HTML in an iframe.
 *
 * Why an iframe rather than injecting the markup:
 *
 * - The generated file is a complete HTML document. It sets `body { margin:0;
 *   overflow:hidden }` and sizes its canvas with `100vw/100vh`, which would
 *   fight this app's layout if it shared the document.
 * - It loads its own deck.gl and mapbox-gl from a CDN. Two deck.gl runtimes in
 *   one document collide over globals and WebGL contexts.
 * - It is megabytes of inlined data. Pointing an iframe at a URL lets the
 *   browser stream and cache it; passing the markup through React state would
 *   not.
 *
 * The document owns its own pan, zoom, tooltip and opacity control, so this
 * component deliberately adds no map chrome of its own — anything it drew on
 * top would either duplicate or contradict what is inside.
 */

import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/Icon';

type FrameState = 'loading' | 'ready' | 'failed';

interface LayerFrameProps {
  /** URL of the generated document, from `api.getLayerUrl`. */
  url: string;
  /** The file's own name. The URL ends in `/document`, which names nothing. */
  filename?: string;
  /** Shown in the corner so it is clear which layer is on screen. */
  title: string;
  subtitle?: string;
}

export function LayerFrame({ url, filename, title, subtitle }: LayerFrameProps) {
  /**
   * Tagged with the URL it describes, so a new layer reads as `loading`
   * during the same render the prop changes — no effect needed to reset it,
   * and no frame where the old document's state describes the new one.
   */
  const [loaded, setLoaded] = useState<{ url: string; state: FrameState } | null>(null);
  const state: FrameState = loaded?.url === url ? loaded.state : 'loading';
  const frame = useRef<HTMLIFrameElement>(null);

  /**
   * `onLoad` fires for an error page too, so ask the server separately
   * whether the document actually exists.
   */
  useEffect(() => {
    let live = true;
    fetch(url, { method: 'HEAD' })
      .then((res) => {
        if (live && !res.ok) setLoaded({ url, state: 'failed' });
      })
      .catch(() => {
        if (live) setLoaded({ url, state: 'failed' });
      });
    return () => {
      live = false;
    };
  }, [url]);

  return (
    <div className="map-canvas">
      <iframe
        ref={frame}
        // Remounting on url change avoids the old document lingering while
        // the new one streams in.
        key={url}
        className="layer-frame"
        src={url}
        title={`${title} — generated map`}
        onLoad={() =>
          setLoaded((current) =>
            // A failed HEAD already settled it; onLoad fires for error pages too.
            current?.url === url && current.state === 'failed' ? current : { url, state: 'ready' },
          )
        }
        // deck.gl needs scripts, but the document has no business reaching
        // into this app. Without `allow-same-origin` it gets an opaque origin:
        // `window.parent` is unreadable and storage access throws. pydeck runs
        // fine under that — verified against the sample document.
        sandbox="allow-scripts"
        loading="eager"
      />

      {state === 'loading' && (
        <div className="layer-frame-overlay">
          <Icon name="spinner" size={22} color="var(--color-accent)" className="spin" />
          <div className="layer-frame-overlay-text">Loading the generated map…</div>
          <div className="muted-55" style={{ fontSize: 12 }}>
            These documents are large — the first paint can take a moment.
          </div>
        </div>
      )}

      {state === 'failed' && (
        <div className="layer-frame-overlay">
          <div className="layer-frame-overlay-text">No generated map for this layer yet</div>
          <div className="muted-55" style={{ fontSize: 12, maxWidth: 380, textAlign: 'center' }}>
            The pipeline has not produced{' '}
            <code className="mono">{filename ?? 'this layer'}</code> yet. Run it for this project,
            or pick a layer that already has output.
          </div>
        </div>
      )}

      {state === 'ready' && (
        <>
          <div className="map-heading">
            <div className="map-heading-title">{title}</div>
            {subtitle && <div className="map-heading-hint muted-55">{subtitle}</div>}
          </div>

          {/* Names the document actually on screen. While every variable maps
              to the same sample file this is the only way to tell that the
              heading and the map are not yet about the same thing. */}
          {filename && <div className="layer-frame-source muted-45 mono">{filename}</div>}
        </>
      )}
    </div>
  );
}
