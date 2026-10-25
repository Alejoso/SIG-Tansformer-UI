/**
 * App-wide state: which screen is showing, which project is open, and the
 * toast. Anything that only one screen cares about stays local to that screen.
 */

import { createContext, useContext } from 'react';
import type { MapMode, Project } from '../types';

export type Screen = 'projects' | 'setup' | 'data' | 'map' | 'tune' | 'examples';

/**
 * Order of the header stepper.
 *
 * Not every screen is in it. `setup` is reached from the Projects screen,
 * which is where you are when you want a new one, and `examples` from the
 * Model screen it explains — neither is a step in the work, and a stepper
 * that lists places you do not pass through stops reading as an order.
 */
export const SCREEN_ORDER: { screen: Screen; label: string }[] = [
  { screen: 'projects', label: 'Projects' },
  { screen: 'data', label: 'Data' },
  { screen: 'map', label: 'Map' },
  { screen: 'tune', label: 'Model' },
];

export interface AppContextValue {
  screen: Screen;
  goTo: (screen: Screen) => void;

  /** The open project. `null` on the projects list and while setting one up. */
  project: Project | null;
  openProject: (project: Project, screen: Screen) => void;

  /** The plain-language help under form fields and in the map sidebar. */
  showHints: boolean;
  setShowHints: (value: boolean) => void;

  /**
   * Which layer the map screen is showing. It lives here rather than in the
   * map screen because Apply, over on the model screen, needs to send the user
   * to a specific layer.
   */
  mapView: MapView;
  setMapView: (view: MapView) => void;

  toast: string | null;
  showToast: (message: string) => void;
}

export interface MapView {
  /** Which side of the project the sidebar lists. */
  mode: MapMode;
  /** Id of the selected node in the layer tree; `null` means "not chosen yet". */
  nodeId: string | null;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}
