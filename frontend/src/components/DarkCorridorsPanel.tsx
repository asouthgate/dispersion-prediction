import { useState } from 'react';
import { useModel, useEngine, useResults, RunPanel, ResultsPanel, ParamField, extractResultLayers, downloadLayerZip } from '@gsbio/engine';
import { RunLogModal } from './RunLogModal';
import { fetchBytes } from '../auth';

export function DarkCorridorsParams() {
  const { state, setModelParam } = useModel();
  const engine = useEngine();
  const def = engine.models.get(state.modelId);

  return (
    <div className="panel-section">
      {(def?.params ?? []).filter((p) => !p.hidden).map((p) => (
        <ParamField
          key={p.key}
          def={p}
          value={state.params[p.key] ?? p.default}
          onChange={(v) => setModelParam(p.key, v)}
        />
      ))}
    </div>
  );
}

export function DarkCorridorsRun() {
  const { summaries } = useResults();
  const engine = useEngine();
  const [logRunId, setLogRunId] = useState<string | null>(null);
  const logRun = logRunId ? summaries.find((s) => s.runId === logRunId) ?? null : null;

  const handleViewLog = (runId: string) => setLogRunId(runId);

  const handleDownload = async (runId: string) => {
    const rec = engine.findRun(runId);
    if (!rec?.result) return;
    try {
      await downloadLayerZip('dark_corridors.zip', extractResultLayers(rec.result), fetchBytes);
    } catch (err) {
      console.error('Download failed:', err);
    }
  };

  return (
    <div className="generate-actions">
      <RunPanel />
      <hr className="generate-divider" />
      <ResultsPanel onViewLog={handleViewLog} onDownload={handleDownload} />
      <RunLogModal run={logRun} onClose={() => setLogRunId(null)} />
    </div>
  );
}
