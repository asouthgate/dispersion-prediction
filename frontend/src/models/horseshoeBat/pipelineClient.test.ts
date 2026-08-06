import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../auth', () => ({
  fetchWithAuth: vi.fn(),
}));

import { runPipelineJob } from './pipelineClient';
import { fetchWithAuth } from '../../auth';

const mockFetch = fetchWithAuth as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

const COMPLETED_JOB = {
  job_id: 'job-1',
  status: 'completed',
  progress: 1,
  progress_label: 'Done',
  error: null,
  warnings: [],
  layers: [{ id: 'road_res', name: 'Road Resistance', url: '/api/rasters/job-1/road_res.png', bounds: [0, 0, 1, 1] }],
};

describe('runPipelineJob', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws when the pipeline fails to start', async () => {
    mockFetch.mockImplementation(() => jsonResponse({ detail: 'Server busy' }, false, 429));
    await expect(
      runPipelineJob('resistance', {}, new AbortController().signal, {}),
    ).rejects.toThrow('Failed to start pipeline: Server busy');
  });

  it('returns the completed job and streams logs', async () => {
    const onLog = vi.fn();
    const onProgress = vi.fn();
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith('/pipeline/resistance')) return jsonResponse({ job_id: 'job-1' });
      if (url.includes('/logs')) return jsonResponse({ lines: ['step one', 'stderr:careful'], offset: 2, has_more: false });
      return jsonResponse(COMPLETED_JOB);
    });

    const signal = new AbortController().signal;
    const promise = runPipelineJob('resistance', {}, signal, { onLog, onProgress });
    await vi.runAllTimersAsync();
    const job = await promise;

    expect(job.status).toBe('completed');
    expect(job.layers).toHaveLength(1);
    expect(onLog).toHaveBeenCalledWith('info', 'Job job-1 started');
    expect(onLog).toHaveBeenCalledWith('info', 'step one');
    expect(onLog).toHaveBeenCalledWith('warning', 'stderr:careful');
    expect(onProgress).toHaveBeenCalledWith({ step: 'submit', fraction: 1, label: 'Done' });
  });

  it('throws the server error when the job fails', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith('/pipeline/resistance')) return jsonResponse({ job_id: 'job-1' });
      if (url.includes('/logs')) return jsonResponse({ lines: [], offset: 0, has_more: false });
      return jsonResponse({ ...COMPLETED_JOB, status: 'failed', error: 'No data for area' });
    });

    const promise = runPipelineJob('resistance', {}, new AbortController().signal, {});
    const assertion = expect(promise).rejects.toThrow('No data for area');
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('returns cancelled status without throwing', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith('/pipeline/resistance')) return jsonResponse({ job_id: 'job-1' });
      if (url.includes('/logs')) return jsonResponse({ lines: [], offset: 0, has_more: false });
      return jsonResponse({ ...COMPLETED_JOB, status: 'cancelled', progress_label: 'Cancelled' });
    });

    const promise = runPipelineJob('resistance', {}, new AbortController().signal, {});
    await vi.runAllTimersAsync();
    const job = await promise;
    expect(job.status).toBe('cancelled');
  });

  it('forwards warnings from the completed job to onLog', async () => {
    const onLog = vi.fn();
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith('/pipeline/resistance')) return jsonResponse({ job_id: 'job-1' });
      if (url.includes('/logs')) return jsonResponse({ lines: [], offset: 0, has_more: false });
      return jsonResponse({ ...COMPLETED_JOB, warnings: ['coverage sparse'] });
    });

    const promise = runPipelineJob('resistance', {}, new AbortController().signal, { onLog });
    await vi.runAllTimersAsync();
    await promise;
    expect(onLog).toHaveBeenCalledWith('warning', 'coverage sparse');
  });

  it('sends the request body to the correct stage endpoint', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith('/pipeline/coverage')) return jsonResponse({ job_id: 'job-1' });
      if (url.includes('/logs')) return jsonResponse({ lines: [], offset: 0, has_more: false });
      return jsonResponse(COMPLETED_JOB);
    });

    const body = { roost: { lng: -3, lat: 50 }, features: [], params: { resolution: 10 } };
    const promise = runPipelineJob('coverage', body, new AbortController().signal, {});
    await vi.runAllTimersAsync();
    await promise;

    const startCall = mockFetch.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('/pipeline/coverage'));
    expect(startCall).toBeDefined();
    const init = startCall![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(body);
  });
});
