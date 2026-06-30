import { useFeatures } from '@gsbio/engine';
import type { DataFeature } from '@gsbio/engine';

const CATEGORY_OPTIONS = ['Building', 'Road', 'River', 'Lights', 'LightString'];

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

  const kindIcon = feature.geometryKind === 'point' ? '◉'
    : feature.geometryKind === 'linestring' ? '〰'
    : feature.geometryKind === 'polygon' ? '⬡'
    : '○';

  const height = (feature.data?.height as number) ?? 0;
  const spacing = (feature.data?.spacing as number) ?? 0;

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
        <select
            className="feature-type-select"
            value={feature.category}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => updateFeature(feature.id, { category: e.target.value })}
          >
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
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
              value={height}
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
                value={spacing}
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
