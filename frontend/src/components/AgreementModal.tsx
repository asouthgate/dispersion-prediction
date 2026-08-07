import { useEffect } from 'react';

interface AgreementModalProps {
  onClose: () => void;
}

export function AgreementModal({ onClose }: AgreementModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="agreement-modal__backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="End user license agreement"
    >
      <div className="agreement-modal">
        <div className="agreement-modal__header">
          <h3>End user license agreement</h3>
          <button
            type="button"
            className="btn btn-ghost agreement-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="agreement-modal__body">
          <p>
            This software is provided for research purposes by Cardiff University.
            By using this service you agree to the following conditions.
          </p>
          <p>
            You may use the results of this service for any lawful purpose,
            including academic research, environmental planning, and commercial
            applications. You must not attempt to reverse-engineer, decompile,
            or extract the underlying models or algorithms.
          </p>
          <p>
            Raw input data, including roost coordinates, street lamp positions,
            drawn polygons, and any vector features, is processed entirely in
            your browser and is not transmitted to our servers. Only derived
            model outputs (resistance and current rasters) are sent to the
            server and are deleted after processing.
          </p>
          <p>
            The software is provided &ldquo;as is&rdquo;, without warranty of any
            kind. Cardiff University, its employees, and affiliates
            disclaim all liability for any damages arising from use of this
            service. We make no guarantee of service availability or accuracy of
            results.
          </p>
          <p>
            We may update this agreement from time to time. Continued use of the
            service constitutes acceptance of the latest version.
          </p>
        </div>
      </div>
    </div>
  );
}
