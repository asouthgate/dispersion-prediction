import { StrictMode, useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { createSimulationEngine } from '@gsbio/engine';
import { AppProvider } from '@gsbio/engine';
import { App } from './App';
import { installHorseshoeBat } from './models/horseshoeBat';
import type { PipelineStage } from './models/horseshoeBat';
import './styles/index.css';

const API_BASE = '/api';

async function ensureAuthToken(): Promise<string> {
  const stored = sessionStorage.getItem('session_token');
  if (stored) return stored;

  const res = await fetch(`${API_BASE}/auth/token`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to create session token: ${res.status}`);
  const { token } = (await res.json()) as { token: string };
  sessionStorage.setItem('session_token', token);
  return token;
}

export function AppRoot() {
  const [stage, setStage] = useState<PipelineStage>('coverage');
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    ensureAuthToken().then(setToken).catch(console.error);
  }, []);

  const [engine] = useState(() => {
    const e = createSimulationEngine();
    e.autoShowResults = true;
    installHorseshoeBat(e, () => stageRef.current, () => sessionStorage.getItem('session_token'));
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
