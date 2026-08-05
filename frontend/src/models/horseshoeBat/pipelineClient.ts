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
  layers?: { id: string; name: string; url: string; bounds: [number, number, number, number] }[];
  raw_tifs?: Record<string, string>;
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

type LogFn = (level: 'info' | 'warning' | 'error', message: string) => void;
type ProgressFn = (progress: { step: 'submit'; fraction: number; label: string }) => void;

interface JobContext {
  onLog?: LogFn;
  onProgress?: ProgressFn;
}

const POLL_INTERVAL_MS = 2000;
const SLOW_POLL_AFTER = 60;
const MAX_POLLS = 420;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    const onAbort = () => { clearTimeout(id); reject(new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    signal?.addEventListener('abort', () => clearTimeout(id), { once: true });
  });
}

export async function runPipelineJob(
  stage: PipelineStage,
  body: Record<string, unknown>,
  signal: AbortSignal,
  ctx: JobContext,
): Promise<JobStatus> {
  const startRes = await fetchWithAuth(`${API_BASE}/pipeline/${stage}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!startRes.ok) {
    let detail = `HTTP ${startRes.status}`;
    try {
      const bodyErr = await startRes.json();
      if (bodyErr.detail) detail = bodyErr.detail;
    } catch { /* best-effort */ }
    throw new Error(`Failed to start pipeline: ${detail}`);
  }

  const { job_id } = (await startRes.json()) as { job_id: string };
  ctx.onLog?.('info', `Job ${job_id} started`);

  const onAbort = () => {
    fetchWithAuth(`${API_BASE}/pipeline/${job_id}`, { method: 'DELETE' }).catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    let job: JobStatus = {
      job_id, status: 'pending', progress: 0, progress_label: '', error: null, warnings: [],
    };
    let logOffset = 0;

    for (let poll = 0; poll < MAX_POLLS; poll++) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      await delay(poll < SLOW_POLL_AFTER ? POLL_INTERVAL_MS : 5000, signal);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const [statusRes, logsRes] = await Promise.all([
        fetchWithAuth(`${API_BASE}/pipeline/${job_id}`, { signal }),
        fetchWithAuth(`${API_BASE}/pipeline/${job_id}/logs?offset=${logOffset}`, { signal }).catch(() => null),
      ]);

      if (!statusRes.ok) throw new Error(`Poll failed: ${statusRes.status}`);
      job = (await statusRes.json()) as JobStatus;

      if (logsRes?.ok) {
        const logs = await logsRes.json() as { lines: string[]; offset: number; has_more: boolean };
        for (const line of logs.lines) {
          const level = line.startsWith('stderr:') ? 'warning' : 'info';
          ctx.onLog?.(level, line);
        }
        logOffset = logs.offset;
      }

      ctx.onProgress?.({ step: 'submit', fraction: job.progress, label: job.progress_label });
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') break;
    }

    if (job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled') {
      throw new Error('Pipeline timed out — it took longer than expected. Try a smaller area or contact support.');
    }

    try {
      const finalLogs = await fetchWithAuth(`${API_BASE}/pipeline/${job_id}/logs?offset=${logOffset}`, { signal: new AbortController().signal });
      if (finalLogs.ok) {
        const logs = await finalLogs.json() as { lines: string[] };
        for (const line of logs.lines) ctx.onLog?.('info', line);
      }
    } catch { /* best-effort */ }

    if (job.status === 'failed') {
      ctx.onLog?.('error', job.error ?? 'Pipeline failed');
      throw new Error(job.error ?? 'Pipeline failed');
    }

    for (const w of job.warnings ?? []) {
      ctx.onLog?.('warning', w);
    }

    return job;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
