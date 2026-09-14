import { useState } from 'react';
import { useModel, useResults, useEngine, useRawSources, RunPanel, ResultsPanel, ParamField, extractResultLayers, downloadLayerZip } from '@gsbio/engine';
import { ROOST_INPUTS_SOURCE_ID, type RoostFinderInputs } from '../models/roostFinder';
import { RunLogModal } from './RunLogModal';
import { fetchBytes } from '../utils/fetchBytes';

const ROOST_FINDER_PAPER_URL = 'https://doi.org/10.1098/rsos.231999';

export function RoostFinderCitation() {
  return (
    <p className="hint roost-citation">
      Method: Henley, L., Finch, D., Mathews, F., Jones, O. &amp; Woolley, T. E. (2024).
      &ldquo;A simple and fast method for estimating bat roost locations.&rdquo;{' '}
      <em>Royal Society Open Science</em> 11(4): 231999.{' '}
      <a href={ROOST_FINDER_PAPER_URL} target="_blank" rel="noopener noreferrer">
        https://doi.org/10.1098/rsos.231999
      </a>
    </p>
  );
}

function FileField({
  label,
  loaded,
  onFile,
  hint,
}: {
  label: string;
  loaded: boolean;
  onFile: (text: string) => void;
  hint?: string;
}) {
  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onFile(reader.result as string);
    reader.readAsText(file);
  };

  return (
    <div className="roost-file-field">
      <span className="field-label">{label}</span>
      <input type="file" accept=".csv" onChange={handleFile} />
      {hint && <span className="hint">{hint}</span>}
      {loaded && <span className="roost-file-loaded">Loaded</span>}
    </div>
  );
}

function useRoostInputs(): RoostFinderInputs | null {
  const engine = useEngine();
  useRawSources();
  const raw = engine.dataStore.getRawSource(ROOST_INPUTS_SOURCE_ID);
  return (raw?.data as RoostFinderInputs | null) ?? null;
}

export function RoostFinderImport() {
  const engine = useEngine();
  const inputs = useRoostInputs();
  const [detectors, setDetectors] = useState<string | null>(inputs?.detectors ?? null);
  const [master, setMaster] = useState<string | null>(inputs?.master ?? null);
  const [sunset, setSunset] = useState<string | null>(inputs?.sunset ?? null);

  const sync = (d: string | null, m: string | null, s: string | null) => {
    setDetectors(d);
    setMaster(m);
    setSunset(s);
    const loaded = d != null && m != null ? { detectors: d, master: m, sunset: s } : null;
    engine.setRawSource(ROOST_INPUTS_SOURCE_ID, 'Roost finder inputs', loaded);
  };

  return (
    <div className="panel-section">
      <p className="hint">
        Import detector and call data CSVs. Coordinates are British National Grid.
        Required columns must match the roost-finder contract (unrecognised columns
        are ignored).
      </p>
      <FileField
        label="Detectors CSV"
        loaded={detectors != null}
        onFile={(t) => sync(t, master, sunset)}
        hint="detector, x, y, n_active_days"
      />
      <FileField
        label="Master call data CSV"
        loaded={master != null}
        onFile={(t) => sync(detectors, t, sunset)}
        hint="detector, date, time"
      />
      <FileField
        label="Sunset CSV (optional)"
        loaded={sunset != null}
        onFile={(t) => sync(detectors, master, t)}
        hint="date, sunset_time (HH:MM:SS) for temporal filtering"
      />
      <p className="hint">
        {detectors != null && master != null
          ? 'Detector and call data ready to run.'
          : 'Load detectors + master CSVs to enable the run.'}
      </p>
      <RoostFinderCitation />
    </div>
  );
}

export function RoostFinderParams() {
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
      <RoostFinderCitation />
    </div>
  );
}

export function RoostFinderRun() {
  const { summaries } = useResults();
  const engine = useEngine();
  const inputs = useRoostInputs();
  const [logRunId, setLogRunId] = useState<string | null>(null);
  const logRun = logRunId ? summaries.find((s) => s.runId === logRunId) ?? null : null;

  const handleViewLog = (runId: string) => setLogRunId(runId);

  const handleDownload = async (runId: string) => {
    const rec = engine.findRun(runId);
    if (!rec?.result) return;
    try {
      await downloadLayerZip('roost_results.zip', extractResultLayers(rec.result), fetchBytes);
    } catch (err) {
      console.error('Download failed:', err);
    }
  };

  return (
    <div className="generate-actions">
      {!inputs && <p className="hint">Import detector and call data CSVs first.</p>}
      <RunPanel />
      <hr className="generate-divider" />
      <ResultsPanel onViewLog={handleViewLog} onDownload={handleDownload} />
      <RunLogModal run={logRun} onClose={() => setLogRunId(null)} />
    </div>
  );
}
