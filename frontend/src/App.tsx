import { useEffect, useState } from 'react';
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
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const update = () => {
      if (mq.matches) setPanelCollapsed(true);
    };
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

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
      <SidePanel
        stage={stage}
        onStageChange={onStageChange}
        collapsed={panelCollapsed}
        onToggleCollapsed={setPanelCollapsed}
      />
      {privacyOpen && <PrivacyModal onClose={() => setPrivacyOpen(false)} />}
    </div>
  );
}
