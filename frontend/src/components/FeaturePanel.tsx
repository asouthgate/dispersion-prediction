import { useRef } from 'react';
import { useFeatures, useEngine } from '@gsbio/engine';
import type { DataFeature } from '@gsbio/engine';
import { Building04, CarAuto, WaterDrop, Sun, Move, Show, Hide, TrashFull, FileDownload, FileUpload, Triangle } from 'react-coolicons';

const categoryIconStyle = { width: 14, height: 14 };

const categoryIconMap: Record<string, React.ReactNode> = {
  Select: <Move style={categoryIconStyle} />,
  Building: <Building04 style={categoryIconStyle} />,
  Road: <CarAuto style={categoryIconStyle} />,
  River: <WaterDrop style={categoryIconStyle} />,
  Lights: <Sun style={categoryIconStyle} />,
  LightSequence: <Sun style={categoryIconStyle} />,
  GenericResistance: <Triangle style={categoryIconStyle} />,
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
            {feature.visible ? <Show style={{ width: 14, height: 14 }} /> : <Hide style={{ width: 14, height: 14 }} />}
          </button>
          <button className="data-icon-btn data-icon-btn--danger" onClick={(e) => { e.stopPropagation(); removeFeature(feature.id); }} title="Delete">
            <TrashFull style={{ width: 14, height: 14 }} />
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

  const showHeight = feature.category === 'Building' || feature.category === 'Lights' || feature.category === 'LightSequence';
  const showSpacing = feature.category === 'LightSequence';
  const showResistanceValue = feature.category === 'GenericResistance';

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
          {feature.visible ? <Show style={{ width: 14, height: 14 }} /> : <Hide style={{ width: 14, height: 14 }} />}
        </button>
        <button className="data-icon-btn data-icon-btn--danger" onClick={(e) => { e.stopPropagation(); removeFeature(feature.id); }} title="Delete">
          <TrashFull style={{ width: 14, height: 14 }} />
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
                min={1}
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
      {showResistanceValue && (
        <div className="feature-card-extra">
          <label className="field">
            <span className="field-label">Resistance</span>
            <input
              type="number"
              min={1}
              max={1000000}
              step={1}
              value={(feature.data?.resistanceValue as number) ?? ""}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => updateData('resistanceValue', Number(e.target.value))}
            />
          </label>
        </div>
      )}
    </div>
  );
}

export function FeaturePanel() {
  const engine = useEngine();
  const { state } = useFeatures();
  const features = state.features;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hideAll = () => {
    for (const f of features) {
      if (f.category !== 'Roost' && f.visible) {
        engine.toggleFeatureVisibility(f.id);
      }
    }
  };

  const showAll = () => {
    for (const f of features) {
      if (f.category !== 'Roost' && !f.visible) {
        engine.toggleFeatureVisibility(f.id);
      }
    }
  };

  const handleExport = () => {
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: features.map((f) => {
        const gj = JSON.parse(JSON.stringify(f.geojson));
        if (!gj.properties) gj.properties = {};
        gj.properties._dp_category = f.category;
        gj.properties._dp_label = f.label;
        if (f.data) gj.properties._dp_data = f.data;
        if (f.circle) gj.properties._dp_circle = f.circle;
        return gj;
      }),
    };
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'drawings.geojson';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
          alert('Invalid GeoJSON: must be a FeatureCollection.');
          return;
        }
        for (const gj of data.features as GeoJSON.Feature[]) {
          const props = gj.properties ?? {};
          const kind = gj.geometry.type === 'Point' ? 'point'
            : gj.geometry.type === 'LineString' ? 'linestring'
            : gj.geometry.type === 'Polygon' ? 'polygon'
            : 'polygon';
          const id = crypto.randomUUID();
          const feature: DataFeature = {
            id,
            geometryKind: kind,
            category: props._dp_category ?? 'Unknown',
            label: props._dp_label ?? '',
            visible: true,
            geojson: { ...gj, properties: {} },
            circle: props._dp_circle as DataFeature['circle'],
            data: props._dp_data as Record<string, unknown>,
          };
          engine.addFeature(feature);
        }
      } catch {
        alert('Failed to parse GeoJSON file.');
      }
    };
    reader.readAsText(file);
  };

  const showEmpty = features.length === 0;
  const nonRoost = features.filter(f => f.category !== 'Roost');
  const allHidden = nonRoost.length > 0 && nonRoost.every(f => !f.visible);

  return (
    <div className="feature-panel">
      <div className="feature-panel__actions">
        <button className="btn-ghost feature-panel__action-btn" onClick={allHidden ? showAll : hideAll} disabled={showEmpty} title={allHidden ? 'Show all drawings' : 'Hide all drawings'}>
          {allHidden ? <Show style={{ width: 12, height: 12 }} /> : <Hide style={{ width: 12, height: 12 }} />}
          {allHidden ? ' Show all' : ' Hide all'}
        </button>
        <button className="btn-ghost feature-panel__action-btn" onClick={handleExport} disabled={showEmpty} title="Export drawings">
          <FileDownload style={{ width: 24, height: 24 }} />
        </button>
        <button className="btn-ghost feature-panel__action-btn" onClick={() => fileInputRef.current?.click()} title="Import drawings">
          <FileUpload style={{ width: 24, height: 24 }} />
        </button>
        <input ref={fileInputRef} type="file" accept=".geojson,.json" onChange={handleImport} style={{ display: 'none' }} />
      </div>
      {showEmpty ? (
        <p className="hint">Use the toolbar above the map to draw features, or import lamps from the Street Lights section.</p>
      ) : (
        <div className="data-feature-list">
          {features.map((f) => <FeatureCard key={f.id} feature={f} />)}
        </div>
      )}
    </div>
  );
}
