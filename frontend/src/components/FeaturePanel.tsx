import { useRef } from 'react';
import type { ReactNode } from 'react';
import { useFeatures, useEngine, FeaturePanel as FeatureInspector, readGpkgFeatureTables, writeGpkg, decodeGpkgFeature } from '@gsbio/engine';
import type { DataFeature, DataFieldDef, GpkgTable } from '@gsbio/engine';
import { Building04, CarAuto, WaterDrop, Sun, Move, Show, Hide, TrashFull, FileUpload, DownloadPackage, Triangle } from 'react-coolicons';
import { configureGeopackageWasm } from '../utils/geopackage';

const categoryIconStyle = { width: 14, height: 14 };

const categoryIconMap: Record<string, ReactNode> = {
  Select: <Move style={categoryIconStyle} />,
  Building: <Building04 style={categoryIconStyle} />,
  Road: <CarAuto style={categoryIconStyle} />,
  River: <WaterDrop style={categoryIconStyle} />,
  Lights: <Sun style={categoryIconStyle} />,
  LightSequence: <Sun style={categoryIconStyle} />,
  GenericResistance: <Triangle style={categoryIconStyle} />,
};

function dataFeatureFromGeoJson(gj: GeoJSON.Feature): DataFeature {
  const meta = decodeGpkgFeature(gj);
  return {
    id: crypto.randomUUID(),
    geometryKind: meta.geometryKind,
    category: meta.category ?? 'Unknown',
    label: meta.label ?? '',
    visible: true,
    geojson: meta.geojson,
    circle: meta.circle,
    data: meta.data,
  };
}

function resolveFields(feature: DataFeature): DataFieldDef[] {
  const isCollection = feature.geometryKind === 'multipoint';
  switch (feature.category) {
    case 'Building':
      return isCollection ? [] : [{ key: 'height', label: 'Height (m)', type: 'number', min: 0, max: 100, step: 1 }];
    case 'Lights':
      return isCollection ? [] : [{ key: 'height', label: 'Height (m)', type: 'number', min: 0, max: 100, step: 1 }];
    case 'LightSequence':
      return isCollection ? [] : [
        { key: 'height', label: 'Height (m)', type: 'number', min: 0, max: 100, step: 1 },
        { key: 'spacing', label: 'Spacing (m)', type: 'number', min: 1, max: 200, step: 1 },
      ];
    case 'GenericResistance':
      return [{ key: 'resistanceValue', label: 'Resistance', type: 'number', min: 1, max: 1000000, step: 1 }];
    default:
      return [];
  }
}

function renderCategoryIcon(feature: DataFeature): ReactNode {
  if (feature.category === 'Roost') {
    return <span className="data-feature-dot" style={{ background: '#5b8def' }} />;
  }
  return <span className="data-feature-dot">{categoryIconMap[feature.category]}</span>;
}

function renderExtra(feature: DataFeature): ReactNode {
  const extras: ReactNode[] = [];
  if (feature.geometryKind === 'multipoint') {
    const pointCount = (feature.geojson.geometry as GeoJSON.MultiPoint).coordinates?.length ?? 0;
    extras.push(
      <div className="feature-card-extra" key="count">
        <span className="field-label">{pointCount} lamp points</span>
      </div>,
    );
  }
  if (feature.category === 'LightMap') {
    const raster = feature.data?.raster as { width?: number; height?: number; crs?: string } | undefined;
    extras.push(
      <div className="feature-card-extra" key="raster">
        <span className="field-label">
          {raster?.width}&times;{raster?.height} px · {raster?.crs}
        </span>
      </div>,
    );
  }
  return extras.length > 0 ? <>{extras}</> : null;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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

  const exportable = () => features.filter((f) => f.category !== 'LightMap');

  const handleExportGpkg = async () => {
    await configureGeopackageWasm();
    const byCategory = new Map<string, GeoJSON.Feature[]>();
    for (const f of exportable()) {
      const gj = JSON.parse(JSON.stringify(f.geojson));
      if (!gj.properties) gj.properties = {};
      gj.properties._dp_category = f.category;
      gj.properties._dp_label = f.label;
      gj.properties._dp_data = JSON.stringify(f.data ?? null);
      gj.properties._dp_circle = JSON.stringify(f.circle ?? null);
      const bucket = byCategory.get(f.category) ?? [];
      bucket.push(gj);
      byCategory.set(f.category, bucket);
    }
    const tables: GpkgTable[] = [...byCategory.entries()].map(([category, gjs]) => ({
      name: category,
      features: gjs,
    }));
    const bytes = await writeGpkg(tables);
    const blob = new Blob([bytes], { type: 'application/geopackage+sqlite3' });
    downloadBlob(blob, 'features.gpkg');
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (/\.gpkg$/i.test(file.name)) {
      await configureGeopackageWasm();
      try {
        const buffer = await file.arrayBuffer();
        const tables = await readGpkgFeatureTables(buffer);
        let added = 0;
        for (const table of tables) {
          for (const gj of table.features) {
            engine.addFeature(dataFeatureFromGeoJson(gj));
            added++;
          }
        }
        if (added === 0) {
          alert('No feature tables found in GeoPackage file.');
        }
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to read GeoPackage file.');
      }
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
          alert('Invalid GeoJSON: must be a FeatureCollection.');
          return;
        }
        for (const gj of data.features as GeoJSON.Feature[]) {
          engine.addFeature(dataFeatureFromGeoJson(gj));
        }
      } catch {
        alert('Failed to parse GeoJSON file.');
      }
    };
    reader.readAsText(file);
  };

  const showEmpty = features.length === 0;
  const nonRoost = features.filter((f) => f.category !== 'Roost');
  const allHidden = nonRoost.length > 0 && nonRoost.every((f) => !f.visible);

  return (
    <div className="feature-panel">
      <div className="feature-panel__actions">
        <button className="btn-ghost feature-panel__action-btn" onClick={allHidden ? showAll : hideAll} disabled={showEmpty} title={allHidden ? 'Show all features' : 'Hide all features'}>
          {allHidden ? <Show style={{ width: 12, height: 12 }} /> : <Hide style={{ width: 12, height: 12 }} />}
          {allHidden ? ' Show all' : ' Hide all'}
        </button>
        <button className="btn-ghost feature-panel__action-btn" onClick={handleExportGpkg} disabled={showEmpty} title="Export features as GeoPackage (.gpkg)">
          <DownloadPackage style={{ width: 24, height: 24 }} />
        </button>
        <button className="btn-ghost feature-panel__action-btn" onClick={() => fileInputRef.current?.click()} title="Import features">
          <FileUpload style={{ width: 24, height: 24 }} />
        </button>
        <input ref={fileInputRef} type="file" accept=".geojson,.json,.gpkg" onChange={handleImport} style={{ display: 'none' }} />
      </div>
      {showEmpty ? (
        <p className="hint">Use the toolbar above the map to draw features, or import lamps from the Lighting section.</p>
      ) : (
        <FeatureInspector
          dataFields={resolveFields}
          icons={{ show: <Show style={{ width: 14, height: 14 }} />, hide: <Hide style={{ width: 14, height: 14 }} />, delete: <TrashFull style={{ width: 14, height: 14 }} /> }}
          renderCategoryIcon={renderCategoryIcon}
          renderExtra={renderExtra}
        />
      )}
    </div>
  );
}
