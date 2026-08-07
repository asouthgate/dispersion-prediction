import { useState } from 'react';
import { useEngine, type FileSourceDef } from '@gsbio/engine';

const LIGHTS_SOURCE: FileSourceDef = {
  id: 'uploaded-lights',
  name: 'Street Lights',
  category: 'Lights',
};

export function FileUpload() {
  const engine = useEngine();
  const [warning, setWarning] = useState('');
  const [loaded, setLoaded] = useState(0);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setWarning('');

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string);
        const features = engine.addFileSourceFeatures(LIGHTS_SOURCE, data);

        if (features.length === 0) {
          setWarning('No valid features found in file. Must be a GeoJSON FeatureCollection.');
          return;
        }

        setLoaded(features.length);
      } catch {
        setWarning('Invalid JSON file.');
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="csv-upload">
      <p className="hint">Upload a GeoJSON file with Point features (coordinates in WGS84).</p>
      <input type="file" accept=".geojson,.json" onChange={handleFile} />
      {loaded > 0 && (
        <p className="hint">Loaded {loaded} lamps</p>
      )}
      <p className="gov-notice">
        Raw street lamp data and user-imported vector features such as 
        buildings and roads are confined to your browser and are not 
        transfered to our server. 
        Irradiance and other resistance maps are calculated in your browser using
        WebAssembly.
        Derived model outputs such as
        resistance and current maps are processed by our server,
        but are deleted after processing.
        We process derived resistance maps temporarily
        in order to generate the final dispersion map.
        By uploading your data, you agree
        to our end user license agreement <a href="/license">here</a>.
      </p>
      {warning && (
        <div className="warning-banner">{warning}</div>
      )}
    </div>
  );
}
