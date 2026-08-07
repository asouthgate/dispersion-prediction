import { useState } from 'react';
import { useEngine, type FileSourceDef } from '@gsbio/engine';
import { AgreementModal } from './AgreementModal';

const LIGHTS_SOURCE: FileSourceDef = {
  id: 'uploaded-lights',
  name: 'Street Lights',
  category: 'Lights',
};

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
      <p className="hint">Import a GeoJSON file with Point features (coordinates in WGS84).</p>
      <input type="file" accept=".geojson,.json" onChange={handleFile} />
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
