import { useApp } from './state/app-context';
import { Header } from './components/Header';
import { DataScreen } from './components/screens/DataScreen';
import { MapScreen } from './components/screens/MapScreen';
import { NewProjectScreen } from './components/screens/NewProjectScreen';
import { ProjectsScreen } from './components/screens/ProjectsScreen';
import { TuneScreen } from './components/screens/TuneScreen';
import { Toast } from './components/ui/Toast';

export default function App() {
  const { screen, toast } = useApp();

  return (
    <div className="app">
      <Header />

      {screen === 'projects' && <ProjectsScreen />}
      {screen === 'setup' && <NewProjectScreen />}
      {screen === 'data' && <DataScreen />}
      {screen === 'map' && <MapScreen />}
      {screen === 'tune' && <TuneScreen />}

      {toast && <Toast message={toast} />}
    </div>
  );
}
