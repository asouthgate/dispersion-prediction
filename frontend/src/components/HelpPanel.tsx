import { useState } from 'react';
import { getConsent, setConsent } from '../analytics';

export function HelpPanel() {
  const [consent, setConsentState] = useState(() => getConsent());

  const handleToggle = () => {
    const next = !consent;
    setConsent(next);
    setConsentState(next);
  };

  return (
    <div className="help-content">
      <p><b>1. Check the <a href="https://github.com/js01/dispersion-prediction-app/wiki/Tutorial" target="_blank" rel="noopener noreferrer">tutorial</a> for more information.</b></p>
      <p><b>2. Pinpoint your roost</b> — click the map or enter coordinates in the Roost panel.</p>
      <p><b>3. Import street light data</b> — upload a CSV via the Street Lights section.</p>
      <p><b>4. Draw features</b> — use the toolbar above the map to draw buildings, roads, rivers, lights, or light strings.</p>
      <p><b>5. Generate maps</b> — select a stage (Coverage, Resistance, Current) and click Run Model.</p>
      <p><b>To adjust parameters</b>, open the Parameters section and expand Road, River, Landscape, Linear, or Lamp.</p>
      <p><b>To change the analysis area</b>, adjust the roost radius in the Roost panel. Larger radii limit minimum resolution.</p>
      <p><b>A light string</b> can be created by drawing a line with the LightString tool and setting the spacing in the Drawings panel.</p>
      <p>For more information on methods, see <a href="https://link.springer.com/article/10.1007/s10980-019-00953-1" target="_blank" rel="noopener noreferrer">this paper</a>.</p>
      <p>Encountered a bug? Submit an issue on <a href="https://github.com/js01/dispersion-prediction-app/issues" target="_blank" rel="noopener noreferrer">GitHub</a>.</p>
      <hr />
      <p><b>Privacy &amp; analytics</b></p>
      <p>We collect anonymous usage data to demonstrate impact to funders and improve the service. This includes page visits, pipeline stage counts, and success/failure rates. No submitted parameters, coordinates, or personal data are ever logged. All analytics are self-hosted and cookie-free.</p>
      <p>
        <label style={{ cursor: 'pointer', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={consent}
            onChange={handleToggle}
            style={{ marginRight: '0.4em' }}
          />
          Allow anonymous usage analytics
        </label>
      </p>
    </div>
  );
}
