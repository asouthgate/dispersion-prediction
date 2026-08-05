import { useState, useEffect } from 'react';
import type { PipelineStage } from '../models/horseshoeBat';
import { useModel, useRun, useResults, useEngine, useEngineState, computePixelDimensions, computeMinResolution } from '@gsbio/engine';
import type { RunLogEntry, DataFeature } from '@gsbio/engine';
import { RunPanel, ResultsPanel } from '@gsbio/engine';
import { RunLogModal } from './RunLogModal';
import { fetchWithAuth } from '../auth';

const MAX_PIXEL_DIMENSION = 2000;

const STAGES: { key: PipelineStage; label: string }[] = [
  { key: 'coverage', label: 'Coverage' },
  { key: 'resistance', label: 'Resistance' },
  { key: 'current', label: 'Current' },
];

interface GeneratePanelProps {
  stage: PipelineStage;
  onStageChange: (s: PipelineStage) => void;
}

export function GeneratePanel({ stage, onStageChange }: GeneratePanelProps) {
  const engine = useEngine();
  const { state: runState } = useRun();
  const { state: model, setModelParam } = useModel();
  const { summaries } = useResults();
  const isRunning = runState.current !== null &&
    (runState.current.status === 'preprocessing' || runState.current.status === 'submitting' || runState.current.status === 'running');

  const [logRunId, setLogRunId] = useState<string | null>(null);
  const logRun = logRunId ? summaries.find((s) => s.runId === logRunId) ?? null : null;

  const resolution = model.params.resolution ?? 10;

  const { features } = useEngineState();
  const roost = features.features.find((f: DataFeature) => f.category === 'Roost');
  const roostRadius = roost?.circle?.radiusMeters ?? 0;
  const minRes = roostRadius > 0 ? computeMinResolution(roostRadius, MAX_PIXEL_DIMENSION) : 1;
  const pixelDim = roostRadius > 0 ? computePixelDimensions(roostRadius, resolution) : null;

  useEffect(() => {
    if (roostRadius > 0 && resolution < minRes) {
      setModelParam('resolution', minRes);
    }
  }, [roostRadius, minRes, resolution, setModelParam]);

  const handleViewLog = (runId: string, _log: RunLogEntry[]): void => {
    void _log;
    setLogRunId(runId);
  };

  const handleDownload = async (runId: string): Promise<void> => {
    const rec = engine.findRun(runId);
    if (!rec?.result || !rec.taskId) return;
    try {
      const res = await fetchWithAuth(`/api/rasters/${rec.taskId}/download`);
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'results.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download failed:', err);
    }
  };

  return (
    <div className="generate-actions">
      <p className="warning-banner">
        Please check LiDAR data coverage before generating resistance maps.
      </p>

      <div className="stage-tabs">
        {STAGES.map((s) => (
          <button
            key={s.key}
            className={`stage-tab ${stage === s.key ? 'active' : ''}`}
            disabled={isRunning}
            onClick={() => onStageChange(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="field">
        <span className="field-label">Resolution (m/px)</span>
        <div className="range-field">
          <input
            type="range"
            min={minRes}
            max={100}
            step={1}
            value={resolution}
            onChange={(e) => setModelParam('resolution', Number(e.target.value))}
          />
          <span className="range-value">{resolution}</span>
        </div>
        {pixelDim && (
          <span className="range-subtext">{pixelDim.width} × {pixelDim.height} px</span>
        )}
      </div>

      <RunPanel />
      <hr className="generate-divider" />
      <ResultsPanel onViewLog={handleViewLog} onDownload={handleDownload} />

      <RunLogModal run={logRun} onClose={() => setLogRunId(null)} />
    </div>
  );
}
