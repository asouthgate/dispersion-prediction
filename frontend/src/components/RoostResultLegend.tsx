import { useEffect, useState } from 'react';
import { useEngine, useResults, type ResultLayerEntry, type TerraDraw2DRenderer } from '@gsbio/engine';
import { ROOST_FINDER_MODEL_ID } from '../models/roostFinder';

interface PlacedLegend {
  id: string;
  items: NonNullable<ResultLayerEntry['legend']>;
  left: number;
  top: number;
}

export function RoostResultLegend({ renderer }: { renderer: TerraDraw2DRenderer }) {
  const engine = useEngine();
  const { summaries } = useResults();
  const [legends, setLegends] = useState<PlacedLegend[]>([]);

  useEffect(() => {
    const map = renderer.getMap();
    if (!map) return;
    const update = () => {
      const placed: PlacedLegend[] = [];
      for (const run of summaries) {
        if (run.modelId !== ROOST_FINDER_MODEL_ID) continue;
        const surface = engine.findRun(run.runId)?.result?.layers.find(layer => layer.id === 'roost_surface');
        if (surface?.envelope.kind !== 'image') continue;
        const [west, south] = surface.envelope.bounds;
        const position = map.project([west, south]);
        for (const id of run.visibleLayerIds) {
          const items = run.layerLegends?.[id];
          if (items?.length) placed.push({ id: `${run.runId}:${id}`, items, left: position.x + 8, top: position.y - 8 });
        }
      }
      setLegends(placed);
    };
    update();
    map.on('move', update);
    map.on('resize', update);
    return () => { map.off('move', update); map.off('resize', update); };
  }, [renderer, engine, summaries]);

  if (!legends.length) return null;

  return (
    <div className="roost-result-legends">
      {legends.map(legend => (
        <div key={legend.id} className="roost-result-legend" aria-label="Roost points legend" style={{ left: legend.left, top: legend.top }}>
          <ul>
            {legend.items.map(item => (
              <li key={item.value}>
                <span aria-hidden="true" className="roost-result-legend__marker" style={{
                  background: item.color, borderColor: item.strokeColor ?? item.color, borderWidth: item.strokeWidth ?? 1,
                }} />
                <span>{item.label}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
