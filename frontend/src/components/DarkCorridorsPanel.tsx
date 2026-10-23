import { useState, useEffect } from 'react';
import { useModel, useEngine, useEngineState, useResults, RunPanel, ResultsPanel, ParamField, extractResultLayers, downloadLayerZip, computePixelDimensions, computeMinResolution } from '@gsbio/engine';
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
  const { state: model, setModelParam } = useModel();
  const { features } = useEngineState();
  const resolution = model.params.resolution ?? 10;
  const roost = features.features.find(feature => feature.category === 'Roost');
  const roostRadius = roost?.circle?.radiusMeters ?? 0;
  const minRes = roostRadius > 0 ? computeMinResolution(roostRadius, 2000) : 1;
  const pixelDim = roostRadius > 0 ? computePixelDimensions(roostRadius, resolution) : null;

  useEffect(() => {
    if (roostRadius > 0 && resolution < minRes) setModelParam('resolution', minRes);
  }, [roostRadius, resolution, minRes, setModelParam]);
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
      <div className="field">
        <span className="field-label">Resolution (m/px)</span>
        <div className="range-field">
          <input
            type="range"
            aria-label="Resolution (m/px)"
            min={minRes}
            max={100}
            step={1}
            value={resolution}
            onChange={event => setModelParam('resolution', Number(event.target.value))}
          />
          <span className="range-value">{resolution}</span>
        </div>
        {pixelDim && <span className="range-subtext">{pixelDim.width} × {pixelDim.height} px</span>}
      </div>
      <RunPanel />
      <hr className="generate-divider" />
      <ResultsPanel onViewLog={handleViewLog} onDownload={handleDownload} />
      <RunLogModal run={logRun} onClose={() => setLogRunId(null)} />
    </div>
  );
}
