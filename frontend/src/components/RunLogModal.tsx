import { useEffect } from 'react';
import type { RunSummary } from '@gsbio/engine';

function logTimeOf(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export interface RunLogModalProps {
  run: Pick<RunSummary, 'runId' | 'modelId' | 'log' | 'startedAt'> | null;
  onClose: () => void;
}

export function RunLogModal({ run, onClose }: RunLogModalProps) {
  useEffect(() => {
    if (!run) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run, onClose]);

  if (!run) return null;

  return (
    <div
      className="run-log-modal__backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Run log"
    >
      <div className="run-log-modal">
        <div className="run-log-modal__header">
          <h3>
            Log · {run.modelId} · {new Date(run.startedAt).toLocaleTimeString()}
          </h3>
          <button
            type="button"
            className="btn btn-ghost run-log-modal__close"
            onClick={onClose}
            aria-label="Close log"
          >
            ✕
          </button>
        </div>
        {run.log.length === 0 ? (
          <p className="results-empty">This run produced no log entries.</p>
        ) : (
          <ul className="run-log-modal__entries">
            {run.log.map((e, i) => (
              <li
                key={i}
                className={`run-log-modal__entry run-log-modal__entry--${e.level}`}
              >
                <span className="run-log-modal__time">{logTimeOf(e.ts)}</span>
                <span className="run-log-modal__level">{e.level}</span>
                <span className="run-log-modal__message">{e.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
