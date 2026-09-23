import { useRef, useState } from 'react';
import { useEngine, useFeatures, decodeGeoTiff, plotRaster, type FileSourceDef, type DataFeature, type DecodedRaster } from '@gsbio/engine';
import { AgreementModal } from './AgreementModal';
import { parseLightsCsv } from '../utils/parseLightsCsv';
import { LIGHTMAP_CATEGORY, LIGHTMAP_LABEL, lightMapFootprint } from '../models/horseshoeBat/lightMap';

const LIGHTS_SOURCE: FileSourceDef = {
  id: 'uploaded-lights',
  name: 'Street Lights',
  category: 'Lights',
};

function isCsvFile(name: string, text: string): boolean {
  return /\.csv$/i.test(name) || !text.trimStart().startsWith('{');
}

function countPoints(features: { geometryKind: string; geojson: GeoJSON.Feature }[]): number {
  return features.reduce((n, f) => {
    if (f.geometryKind === 'multipoint') {
      const g = f.geojson.geometry as GeoJSON.MultiPoint;
      return n + (Array.isArray(g?.coordinates) ? g.coordinates.length : 0);
    }
    return n + 1;
  }, 0);
}

export function LightUpload() {
  const engine = useEngine();
  const { state: featureState } = useFeatures();
  const [warning, setWarning] = useState('');
  const [loaded, setLoaded] = useState(0);
  const [lightMapWarning, setLightMapWarning] = useState('');
  const [showAgreement, setShowAgreement] = useState(false);
  const lightMapInputRef = useRef<HTMLInputElement>(null);

  const lightMapFeature = featureState.features.find((f) => f.category === LIGHTMAP_CATEGORY);
  const lightMap = lightMapFeature?.data?.raster as DecodedRaster | null | undefined;

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setWarning('');

    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      let data: object;
      let warnings: string[] = [];
      if (isCsvFile(file.name, text)) {
        try {
          const parsed = parseLightsCsv(text);
          data = parsed.geojson;
          warnings = parsed.warnings;
        } catch (err) {
          setWarning(err instanceof Error ? err.message : 'Failed to parse CSV file.');
          return;
        }
      } else {
        try {
          data = JSON.parse(text);
        } catch {
          setWarning('Invalid GeoJSON file.');
          return;
        }
      }

      const features = engine.addFileSourceFeatures(LIGHTS_SOURCE, data);
      const total = countPoints(features);
      if (total === 0) {
        setWarning('No valid features found in file. Provide a GeoJSON FeatureCollection or a CSV with lat/lng or easting/northing columns.');
        return;
      }
      setWarning(warnings.join(' '));
      setLoaded(total);
    };
    reader.readAsText(file);
  };

  const handleLightMap = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLightMapWarning('');

    const reader = new FileReader();
    reader.onload = () => {
      decodeGeoTiff(reader.result as ArrayBuffer)
        .then(async (decoded) => {
          const plotted = await plotRaster(decoded, {
            palette: 'magma',
            scale: 'linear',
            label: 'Light map',
            colorbar: false,
          });
          for (const f of engine.dataStore.getFeatures().filter((f) => f.category === LIGHTMAP_CATEGORY)) {
            engine.removeFeature(f.id);
          }
          const feature: DataFeature = {
            id: crypto.randomUUID(),
            geometryKind: 'polygon',
            category: LIGHTMAP_CATEGORY,
            label: LIGHTMAP_LABEL,
            visible: true,
            geojson: { type: 'Feature', geometry: lightMapFootprint(decoded), properties: {} },
            data: { raster: decoded },
            raster: { kind: 'image', url: plotted.url, bounds: plotted.boundsWgs84 },
          };
          engine.addFeature(feature);
          if (lightMapInputRef.current) lightMapInputRef.current.value = '';
        })
        .catch((err) => {
          setLightMapWarning(err instanceof Error ? err.message : 'Failed to read light map GeoTIFF.');
        });
    };
    reader.onerror = () => setLightMapWarning('Failed to read file.');
    reader.readAsArrayBuffer(file);
  };

  return (
    <div className="csv-upload">
      <p className="hint">Import a GeoJSON file with Point features (WGS84), or a CSV with lat/lng or easting/northing columns plus a height column (height or z).</p>
      <input type="file" accept=".geojson,.json,.csv" onChange={handleFile} />
      {loaded > 0 && (
        <p className="hint">Loaded {loaded} lamps</p>
      )}

      <div className="light-map-upload">
        <p className="hint">Alternatively, import a pre-computed light map (single-band GeoTIFF, EPSG:27700 or EPSG:4326). It replaces lamp-point irradiance and is normalised to the lamp resistance factor.</p>
        <input ref={lightMapInputRef} type="file" accept=".tif,.tiff" onChange={handleLightMap} />
        {lightMap && (
          <p className="hint">
            Light map loaded: {lightMap.width}&times;{lightMap.height} px, {lightMap.crs}
          </p>
        )}
      </div>
      {lightMapWarning && (
        <div className="warning-banner">{lightMapWarning}</div>
      )}
      <div className="gov-notice">
        <p>Raw street lamp data and user-imported vector features such as
        buildings and roads are confined to your browser and are not
        transferred to our server.</p>
        <p>Irradiance and other resistance maps are calculated in your
        browser using WebAssembly. Only derived model outputs such as
        resistance and current maps are sent to our server, where they are
        processed temporarily to generate the final dispersion map and
        then deleted.</p>
        <p>By using this service, you agree
        to our end user license agreement{' '}
        <button className="link-button" onClick={() => setShowAgreement(true)}>here</button>.</p>
      </div>
      {warning && (
        <div className="warning-banner">{warning}</div>
      )}
      {showAgreement && <AgreementModal onClose={() => setShowAgreement(false)} />}
    </div>
  );
}
