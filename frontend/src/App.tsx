import type { PipelineStage } from './models/horseshoeBat';
import { MapView } from './components/MapView';
import { SidePanel } from './components/SidePanel';

interface AppProps {
  stage: PipelineStage;
  onStageChange: (s: PipelineStage) => void;
}

export function App({ stage, onStageChange }: AppProps) {
  return (
    <div className="app-container">
      <div className="map-area">
        <MapView />
      </div>
      <SidePanel stage={stage} onStageChange={onStageChange} />
    </div>
  );
}
