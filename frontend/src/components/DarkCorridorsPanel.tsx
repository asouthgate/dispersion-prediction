import { useState, useEffect } from 'react';
import { useModel, useEngine, useEngineState, useResults, RunPanel, ResultsPanel, ParamField, extractResultLayers, downloadLayerZip, computePixelDimensions, computeMinResolution } from '@gsbio/engine';
import { RunLogModal } from './RunLogModal';
import { fetchBytes } from '../auth';

export function DarkCorridorsParams() {
  const { state, setModelParam } = useModel();
  const engine = useEngine();
  const def = engine.models.get(state.modelId);
  if (!def) throw new Error(`Unknown model: ${state.modelId}`);
  for (const param of def.params.filter(p => !p.hidden)) {
    if (!Number.isFinite(state.params[param.key])) {
      throw new Error(`Missing or invalid parameter: ${param.key}`);
    }
  }

  return (
    <div className="panel-section">
      {def.params.filter((p) => !p.hidden).map((p) => (
        <ParamField
          key={p.key}
          def={p}
          value={state.params[p.key]}
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
  const resolution = model.params.resolution;
  if (!Number.isFinite(resolution) || resolution <= 0) {
    throw new Error('Resolution must be a finite positive number.');
  }
  const roost = features.features.find(feature => feature.category === 'Roost');
  if (roost && (!roost.circle || !Number.isFinite(roost.circle.radiusMeters) || roost.circle.radiusMeters <= 0)) {
    throw new Error('Roost must have a circle with a finite positive radius.');
  }
  // Before a roost is drawn, use the resolution control's lower bound.
  const minRes = roost ? computeMinResolution(roost.circle!.radiusMeters, 2000) : 1;
  const pixelDim = roost ? computePixelDimensions(roost.circle!.radiusMeters, resolution) : null;

  useEffect(() => {
    if (roost && resolution < minRes) setModelParam('resolution', minRes);
  }, [roost, resolution, minRes, setModelParam]);
  const [logRunId, setLogRunId] = useState<string | null>(null);
  const logRun = logRunId ? summaries.find((s) => s.runId === logRunId) ?? null : null;

  const handleViewLog = (runId: string) => setLogRunId(runId);

  const handleDownload = async (runId: string) => {
    const rec = engine.findRun(runId);
    if (!rec?.result) throw new Error(`No result available for run: ${runId}`);
    await downloadLayerZip('dark_corridors.zip', extractResultLayers(rec.result), fetchBytes);
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
