import { StrictMode, useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { createEngine, EngineProvider } from '@gsbio/engine';
import { App } from './App';
import { installHorseshoeBat } from './models/horseshoeBat';
import type { PipelineStage } from './models/horseshoeBat';
import { acquireToken } from './auth';
import { trackPageview } from './analytics';
import './styles/index.css';

export function AppRoot() {
  const [stage, setStage] = useState<PipelineStage>('coverage');
  const stageRef = useRef(stage);
  stageRef.current = stage;
  // const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    acquireToken().then(t => {
      // setToken(t);
      trackPageview(t);
    }).catch(console.error);
  }, []);

  const [engine] = useState(() => {
    const e = createEngine();
    e.autoShowResults = true;
    installHorseshoeBat(e, () => stageRef.current);
    return e;
  });

  useEffect(() => {
    const stageMap: Record<PipelineStage, string | null> = {
      current: 'log_current',
      resistance: 'log_total_res',
      coverage: null,
    };
    engine.defaultLayerId = stageMap[stage] ?? null;
  }, [stage, engine]);

  // if (!token) return null;

  return (
    <EngineProvider engine={engine}>
      <App stage={stage} onStageChange={setStage} />
    </EngineProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>,
);
