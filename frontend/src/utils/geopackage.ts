import { setSqljsWasmLocateFile } from '@gsbio/engine';
import sqlWasmUrl from '@ngageoint/geopackage/dist/sql-wasm.wasm?url';

let configured = false;

/** Point the GeoPackage sql.js adapter at the bundled wasm asset (idempotent). */
export async function configureGeopackageWasm(): Promise<void> {
  if (configured) return;
  await setSqljsWasmLocateFile(() => sqlWasmUrl);
  configured = true;
}
