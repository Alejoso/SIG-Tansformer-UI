import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppContext, type AppContextValue, type MapView, type Screen } from './app-context';
import type { Project } from '../types';

/** How long the confirmation toast stays up. */
const TOAST_MS = 3200;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [screen, setScreen] = useState<Screen>('projects');
  const [project, setProject] = useState<Project | null>(null);
  const [showHints, setShowHints] = useState(true);
  const [mapView, setMapView] = useState<MapView>({ mode: 'input', scale: 'raw', variableId: null });
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const goTo = useCallback((next: Screen) => setScreen(next), []);

  const openProject = useCallback((next: Project, target: Screen) => {
    setProject(next);
    setMapView({ mode: 'input', scale: 'raw', variableId: null });
    setScreen(target);
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      screen, goTo,
      project, openProject,
      showHints, setShowHints,
      mapView, setMapView,
      toast, showToast,
    }),
    [screen, goTo, project, openProject, showHints, mapView, toast, showToast],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
