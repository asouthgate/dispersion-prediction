import { useState } from 'react';
import { useEngine, useModel } from '@gsbio/engine';
import type { ModelParamDef } from '@gsbio/engine';
import { PARAM_GROUPS, TOP_PARAMS } from '../models/horseshoeBat';

function ParamField({ def, value, onChange }: { def: ModelParamDef; value: number; onChange: (v: number) => void }) {
  if (def.type === 'range') {
    return (
      <label className="field">
        <span className="field-label">{def.label}</span>
        <div className="range-field">
          <input
            type="range"
            min={def.min}
            max={def.max}
            step={def.step ?? 1}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          <span className="range-value">{value}</span>
        </div>
      </label>
    );
  }
  return (
    <label className="field">
      <span className="field-label">{def.label}</span>
      <input
        type="number"
        min={def.min}
        max={def.max}
        step={def.step ?? 1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function ParamSubSection({ label, keys }: { label: string; keys: string[] }) {
  const { state, setModelParam } = useModel();
  const engine = useEngine();
  const def = engine.models.get(state.modelId);
  const paramDefs = (def?.params ?? []).filter((p) => keys.includes(p.key));
  const [open, setOpen] = useState(false);

  if (paramDefs.length === 0) return null;

  return (
    <div className="param-subsection">
      <button className="param-subsection-header" onClick={() => setOpen((v) => !v)}>
        <span>{open ? '▾' : '▸'} {label}</span>
      </button>
      {open && (
        <div className="param-subsection-body">
          {paramDefs.map((p) => (
            <ParamField
              key={p.key}
              def={p}
              value={state.params[p.key] ?? p.default}
              onChange={(v) => setModelParam(p.key, v)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ParameterPanel() {
  const { state, setModelParam } = useModel();
  const engine = useEngine();
  const def = engine.models.get(state.modelId);
  const topDefs = (def?.params ?? []).filter((p) => TOP_PARAMS.includes(p.key));

  return (
    <div className="panel-section">
      <p className="warning-banner">
        Warning: please read <a href="https://link.springer.com/article/10.1007/s10980-019-00953-1" target="_blank" rel="noopener noreferrer">this paper</a> before altering these parameters.
      </p>

      {topDefs.map((p) => (
        <ParamField
          key={p.key}
          def={p}
          value={state.params[p.key] ?? p.default}
          onChange={(v) => setModelParam(p.key, v)}
        />
      ))}

      {PARAM_GROUPS.map((g) => (
        <ParamSubSection key={g.label} label={g.label} keys={g.keys} />
      ))}
    </div>
  );
}
