import { useState } from 'react';
import type { PipelineStage } from './models/horseshoeBat';
import { MapView } from './components/MapView';
import { SidePanel } from './components/SidePanel';
import { PrivacyModal } from './components/PrivacyModal';

interface AppProps {
  stage: PipelineStage;
  onStageChange: (s: PipelineStage) => void;
}

export function App({ stage, onStageChange }: AppProps) {
  const [privacyOpen, setPrivacyOpen] = useState(false);

  return (
    <div className="app-container">
      <div className="map-area">
        <MapView />
        <button
          className="privacy-btn"
          onClick={() => setPrivacyOpen(true)}
          title="Privacy &amp; analytics"
        >
          Privacy
        </button>
      </div>
      <SidePanel stage={stage} onStageChange={onStageChange} />
      {privacyOpen && <PrivacyModal onClose={() => setPrivacyOpen(false)} />}
    </div>
  );
}
