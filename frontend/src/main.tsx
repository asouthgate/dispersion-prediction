import { StrictMode, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { createSimulationEngine } from '@gsbio/engine';
import { AppProvider } from '@gsbio/engine';
import { App } from './App';
import { installHorseshoeBat } from './models/horseshoeBat';
import type { PipelineStage } from './models/horseshoeBat';
import './styles/index.css';

export function AppRoot() {
  const [stage, setStage] = useState<PipelineStage>('coverage');
  const stageRef = useRef(stage);
  stageRef.current = stage;

  const [engine] = useState(() => {
    const e = createSimulationEngine();
    e.autoShowResults = true;
    installHorseshoeBat(e, () => stageRef.current);
    return e;
  });

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
