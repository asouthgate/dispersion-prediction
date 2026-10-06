import { StrictMode, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { createEngine, EngineProvider } from '@gsbio/engine';
import { App } from './App';
import { installHorseshoeBat, horseshoeBatModel } from './models/horseshoeBat';
import { installRoostFinder, ROOST_FINDER_MODEL_ID } from './models/roostFinder';
import type { PanelTab } from './components/SidePanel';
import { acquireToken } from './auth';
import { trackPageview } from './analytics';
import './styles/index.css';

export function AppRoot() {
  const [activeTab, setActiveTab] = useState<PanelTab>('connectivity');

  useEffect(() => {
    acquireToken().then(t => {
      trackPageview(t);
    }).catch(console.error);
  }, []);

  const [engine] = useState(() => {
    const e = createEngine();
    e.autoShowResults = true;
    installHorseshoeBat(e);
    installRoostFinder(e);
    return e;
  });

  useEffect(() => {
    if (activeTab === 'roost') {
      // TODO: fix this, it's inconsistent
      engine.setModel(ROOST_FINDER_MODEL_ID);
    } else {
      engine.setModel(horseshoeBatModel.id);
    }
  }, [activeTab, engine]);

  return (
    <EngineProvider engine={engine}>
      <App
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />
    </EngineProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>,
);
