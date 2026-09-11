import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles/organic.css';
import './styles/app.css';
import './styles/screens.css';
import './styles/map.css';
import './styles/tune.css';

import App from './App';
import { AppProvider } from './state/AppProvider';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>,
);
