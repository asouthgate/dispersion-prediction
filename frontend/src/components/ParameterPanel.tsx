import { useState } from 'react';
import { TriangleWarning } from 'react-coolicons';
import { useEngine, useModel, ParamField } from '@gsbio/engine';
import type { ModelParamDef } from '@gsbio/engine';

function ParamGroup({ label, params }: { label: string; params: ModelParamDef[] }) {
  const { state, setModelParam } = useModel();
  const [open, setOpen] = useState(false);

  return (
    <div className="param-subsection">
      <button className="param-subsection-header" onClick={() => setOpen((v) => !v)}>
        <span>{open ? '▾' : '▸'} {label}</span>
      </button>
      {open && (
        <div className="param-subsection-body">
          {params.map((p) => (
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
  const params = (def?.params ?? []).filter((p) => !p.hidden);

  const top = params.filter((p) => !p.group);
  const groups: { label: string; params: ModelParamDef[] }[] = [];
  const byGroup = new Map<string, ModelParamDef[]>();
  for (const p of params) {
    if (!p.group) continue;
    if (!byGroup.has(p.group)) byGroup.set(p.group, []);
    byGroup.get(p.group)!.push(p);
  }
  for (const [label, groupParams] of byGroup) groups.push({ label, params: groupParams });

  return (
    <div className="panel-section">
      <div className="parameter-warning">
        <TriangleWarning className="parameter-warning__icon" aria-hidden="true" />
        <p>Warning: please read <a href="https://link.springer.com/article/10.1007/s10980-019-00953-1" target="_blank" rel="noopener noreferrer">this paper</a> before altering these parameters.</p>
      </div>

      {top.map((p) => (
        <ParamField
          key={p.key}
          def={p}
          value={state.params[p.key] ?? p.default}
          onChange={(v) => setModelParam(p.key, v)}
        />
      ))}

      {groups.map((g) => (
        <ParamGroup key={g.label} label={g.label} params={g.params} />
      ))}
    </div>
  );
}
