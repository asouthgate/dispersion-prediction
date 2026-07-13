import { useCallback, useEffect, useState } from 'react';
import { useFeatures } from '@gsbio/engine';
import type { DataFeature, CircleGeometry } from '@gsbio/engine';
import { wgs84ToBng, formatCoord } from '../utils/projections';

const DEFAULT_LAT = 50.604;
const DEFAULT_LNG = -3.600;
const DEFAULT_RADIUS = 2500;

function findRoost(features: DataFeature[]): DataFeature | undefined {
  return features.find((f) => f.category === 'Roost');
}

export function RoostPanel() {
  const { state, addFeature, updateCircle } = useFeatures();
  const roost = findRoost(state.features);

  const [lat, setLat] = useState(String(DEFAULT_LAT));
  const [lng, setLng] = useState(String(DEFAULT_LNG));
  const [radius, setRadius] = useState(DEFAULT_RADIUS);

  useEffect(() => {
    if (roost?.circle) {
      setLat(roost.circle.center.lat.toFixed(5));
      setLng(roost.circle.center.lng.toFixed(5));
      setRadius(roost.circle.radiusMeters);
    }
  }, [roost?.circle?.center.lat, roost?.circle?.center.lng, roost?.circle?.radiusMeters]);

  const ensureRoost = useCallback(() => {
    if (!roost) {
      const r: CircleGeometry = {
        center: { lng: parseFloat(lng) || DEFAULT_LNG, lat: parseFloat(lat) || DEFAULT_LAT },
        radiusMeters: radius,
      };
      addFeature({
        id: `roost-${Date.now()}`,
        geometryKind: 'circle',
        category: 'Roost',
        label: 'Roost',
        visible: true,
        geojson: { type: 'Feature', geometry: { type: 'Point', coordinates: [r.center.lng, r.center.lat] }, properties: {} },
        circle: r,
      });
    }
  }, [roost, lat, lng, radius, addFeature]);

  const updateRoost = (field: 'lat' | 'lng' | 'radius', val: number) => {
    if (!roost) return;
    if (field === 'lat') {
      updateCircle(roost.id, { center: { lng: roost.circle!.center.lng, lat: val } });
    } else if (field === 'lng') {
      updateCircle(roost.id, { center: { lng: val, lat: roost.circle!.center.lat } });
    } else {
      updateCircle(roost.id, { radiusMeters: val });
    }
  };

  const [easting, northing] = roost?.circle
    ? wgs84ToBng(roost.circle.center.lat, roost.circle.center.lng)
    : [0, 0];

  return (
    <div className="panel-section">
      {!roost ? (
        <>
          <p className="hint">No roost placed. Click the map or enter coordinates to place one.</p>
          <button className="btn" onClick={ensureRoost}>Place Roost at Map Center</button>
        </>
      ) : (
        <>
          <label className="field">
            <span className="field-label">Radius (metres)</span>
            <div className="range-field">
              <input
                type="range"
                min={100}
                max={5000}
                step={50}
                value={radius}
                onChange={(e) => { setRadius(Number(e.target.value)); updateRoost('radius', Number(e.target.value)); }}
              />
              <span className="range-value">{radius.toLocaleString()}</span>
            </div>
          </label>
          <label className="field">
            <span className="field-label">Latitude</span>
            <input
              type="number"
              step={0.00001}
              value={lat}
              onChange={(e) => { setLat(e.target.value); updateRoost('lat', Number(e.target.value)); }}
            />
          </label>
          <label className="field">
            <span className="field-label">Longitude</span>
            <input
              type="number"
              step={0.00001}
              value={lng}
              onChange={(e) => { setLng(e.target.value); updateRoost('lng', Number(e.target.value)); }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <span className="field-label">Easting (BNG)</span>
              <div className="coord-display">{formatCoord(easting)}</div>
            </div>
            <div style={{ flex: 1 }}>
              <span className="field-label">Northing (BNG)</span>
              <div className="coord-display">{formatCoord(northing)}</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
