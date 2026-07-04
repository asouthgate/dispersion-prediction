import { StrictMode, useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { createSimulationEngine } from '@gsbio/engine';
import { AppProvider } from '@gsbio/engine';
import { App } from './App';
import { installHorseshoeBat } from './models/horseshoeBat';
import type { PipelineStage } from './models/horseshoeBat';
import { ensureValidToken } from './auth';
import './styles/index.css';

export function AppRoot() {
  const [stage, setStage] = useState<PipelineStage>('coverage');
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    ensureValidToken().then(setToken).catch(console.error);
  }, []);

  const [engine] = useState(() => {
    const e = createSimulationEngine();
    e.autoShowResults = true;
    installHorseshoeBat(e, () => stageRef.current);
    return e;
  });

  if (!token) return null;

  return (
    <AppProvider engine={engine}>
      <App stage={stage} onStageChange={setStage} />
    </AppProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>,
);
