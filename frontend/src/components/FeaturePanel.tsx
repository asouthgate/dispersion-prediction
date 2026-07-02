import { useFeatures } from '@gsbio/engine';
import type { DataFeature } from '@gsbio/engine';
import { Building04, CarAuto, WaterDrop, Sun } from 'react-coolicons';

const categoryIconStyle = { width: 14, height: 14 };

const categoryIconMap: Record<string, React.ReactNode> = {
  Building: <Building04 style={categoryIconStyle} />,
  Road: <CarAuto style={categoryIconStyle} />,
  River: <WaterDrop style={categoryIconStyle} />,
  Lights: <Sun style={categoryIconStyle} />,
  LightString: <Sun style={categoryIconStyle} />,
};

const kindIconFallback = {
  point: '◉',
  linestring: '〰',
  polygon: '⬡',
  circle: '○',
} as const;

function FeatureCard({ feature }: { feature: DataFeature }) {
  const { state, updateFeature, selectFeature, removeFeature, toggleVisibility } = useFeatures();

  if (feature.category === 'Roost') {
    return (
      <div
        className={`data-feature-item ${state.selectedFeatureId === feature.id ? 'selected' : ''}`}
        onClick={() => selectFeature(feature.id)}
      >
        <div className="data-feature-row">
          <span className="data-feature-dot" style={{ background: '#5b8def' }} />
          <span className="data-feature-type">Roost</span>
          <input
            type="text"
            className="data-feature-label"
            value={feature.label}
            placeholder="Label..."
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => updateFeature(feature.id, { label: e.target.value })}
          />
          <button className="data-icon-btn" onClick={(e) => { e.stopPropagation(); toggleVisibility(feature.id); }} title={feature.visible ? 'Hide' : 'Show'}>
            {feature.visible ? '👁' : '∅'}
          </button>
          <button className="data-icon-btn data-icon-btn--danger" onClick={(e) => { e.stopPropagation(); removeFeature(feature.id); }} title="Delete">
            ✕
          </button>
        </div>
      </div>
    );
  }

  const kindIcon = categoryIconMap[feature.category] ?? kindIconFallback[feature.geometryKind as keyof typeof kindIconFallback] ?? '○';

  const height = feature.data?.height as number | undefined;
  const spacing = feature.data?.spacing as number | undefined;

  const updateData = (key: string, val: number) => {
    updateFeature(feature.id, { data: { ...(feature.data ?? {}), [key]: val } });
  };

  const showHeight = feature.category === 'Building' || feature.category === 'Lights' || feature.category === 'LightString';
  const showSpacing = feature.category === 'LightString';

  return (
    <div
      className={`data-feature-item ${state.selectedFeatureId === feature.id ? 'selected' : ''}`}
      onClick={() => selectFeature(feature.id)}
    >
      <div className="data-feature-row">
        <span className="data-feature-dot">{kindIcon}</span>
        <span className="data-feature-type">{feature.category}</span>
        <input
          type="text"
          className="data-feature-label"
          value={feature.label}
          placeholder="Label..."
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => updateFeature(feature.id, { label: e.target.value })}
        />
        <button className="data-icon-btn" onClick={(e) => { e.stopPropagation(); toggleVisibility(feature.id); }} title={feature.visible ? 'Hide' : 'Show'}>
          {feature.visible ? '👁' : '∅'}
        </button>
        <button className="data-icon-btn data-icon-btn--danger" onClick={(e) => { e.stopPropagation(); removeFeature(feature.id); }} title="Delete">
          ✕
        </button>
      </div>

      {showHeight && (
        <div className="feature-card-extra">
          <label className="field">
            <span className="field-label">Height (m)</span>
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={height ?? ""}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => updateData('height', Number(e.target.value))}
            />
          </label>
          {showSpacing && (
            <label className="field">
              <span className="field-label">Spacing (m)</span>
              <input
                type="number"
                min={0}
                max={200}
                step={1}
                value={spacing ?? ""}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => updateData('spacing', Number(e.target.value))}
              />
            </label>
          )}
        </div>
      )}
    </div>
  );
}

export function FeaturePanel() {
  const { state } = useFeatures();
  const features = state.features;

  if (features.length === 0) {
    return (
      <div className="feature-panel">
        <p className="hint">Use the toolbar above the map to draw features, or import lamps from the Street Lights section.</p>
      </div>
    );
  }

  return (
    <div className="feature-panel">
      <div className="data-feature-list">
        {features.map((f) => <FeatureCard key={f.id} feature={f} />)}
      </div>
    </div>
  );
}
