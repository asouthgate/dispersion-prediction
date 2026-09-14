import type { RemoteJobAdapter, RemoteLogEntry } from '@gsbio/engine/remote';
import type { PipelineStage } from './model';
import { fetchWithAuth } from '../../auth';

const API_BASE = '/api';

export interface JobStatus {
  job_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  progress_label: string;
  error: string | null;
  warnings: string[];
  layers?: {
    id: string;
    name: string;
    url: string;
    bounds: [number, number, number, number];
    display?: Record<string, unknown>;
  }[];
  raw_tifs?: Record<string, string>;
  raw_geojson?: Record<string, string>;
  raster_extent?: {
    m: number;
    n: number;
    pixw: number;
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
  };
}

function toLogEntries(lines: string[]): RemoteLogEntry[] {
  return lines.map((line) => ({
    level: line.startsWith('stderr:') ? 'warning' : 'info',
    message: line,
  }));
}

/**
 * Builds the {@link RemoteJobAdapter} for the horseshoe-bat backend pipeline.
 * Encapsulates endpoint URLs, auth, and response parsing; the polling loop,
 * progress reporting, and cancellation mechanics live in `@gsbio/engine/remote`.
 */
export function createPipelineAdapter(stage: PipelineStage): RemoteJobAdapter<JobStatus> {
  return {
    async start(body, signal) {
      const res = await fetchWithAuth(`${API_BASE}/pipeline/${stage}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const bodyErr = await res.json();
          if (bodyErr.detail) detail = bodyErr.detail;
        } catch { /* best-effort */ }
        throw new Error(`Failed to start pipeline: ${detail}`);
      }

      const { job_id } = (await res.json()) as { job_id: string };
      return job_id;
    },

    async fetch(jobId, signal, logOffset) {
      const [statusRes, logsRes] = await Promise.all([
        fetchWithAuth(`${API_BASE}/pipeline/${jobId}`, { signal }),
        fetchWithAuth(`${API_BASE}/pipeline/${jobId}/logs?offset=${logOffset}`, { signal }).catch(() => null),
      ]);

      if (!statusRes.ok) throw new Error(`Poll failed: ${statusRes.status}`);
      const job = (await statusRes.json()) as JobStatus;

      let logs;
      if (logsRes?.ok) {
        const parsed = await logsRes.json() as { lines: string[]; offset: number; has_more: boolean };
        logs = { entries: toLogEntries(parsed.lines), offset: parsed.offset };
      }

      return {
        status: job.status,
        progress: job.progress,
        progressLabel: job.progress_label,
        error: job.error,
        warnings: job.warnings,
        logs,
        result: job,
      };
    },

    async cancel(jobId) {
      await fetchWithAuth(`${API_BASE}/pipeline/${jobId}`, { method: 'DELETE' }).catch(() => {});
    },
  };
}
