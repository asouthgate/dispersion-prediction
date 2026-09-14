import { useState } from 'react';
import { useEngine, type FileSourceDef } from '@gsbio/engine';
import { AgreementModal } from './AgreementModal';
import { parseLightsCsv } from '../utils/parseLightsCsv';

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

export function FileUpload() {
  const engine = useEngine();
  const [warning, setWarning] = useState('');
  const [loaded, setLoaded] = useState(0);
  const [showAgreement, setShowAgreement] = useState(false);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setWarning('');

    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      let data: object;
      if (isCsvFile(file.name, text)) {
        try {
          data = parseLightsCsv(text).geojson;
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
      setLoaded(total);
    };
    reader.readAsText(file);
  };

  return (
    <div className="csv-upload">
      <p className="hint">Import a GeoJSON file with Point features (WGS84), or a CSV with lat/lng or easting/northing columns and an optional height column.</p>
      <input type="file" accept=".geojson,.json,.csv" onChange={handleFile} />
      {loaded > 0 && (
        <p className="hint">Loaded {loaded} lamps</p>
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
