import { useEffect } from 'react';

interface PrivacyModalProps {
  onClose: () => void;
}

export function PrivacyModal({ onClose }: PrivacyModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="privacy-modal__backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Privacy and analytics"
    >
      <div className="privacy-modal">
        <div className="privacy-modal__header">
          <h3>Privacy &amp; analytics</h3>
          <button
            type="button"
            className="btn btn-ghost privacy-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="privacy-modal__body">
          {/* TODO: add consent banner if GDPR compliance becomes required */}
          <p>To function, the application requires geographical coordinates for the pipeline analysis area (roost location and radius) and pipeline parameters.</p>
          <p>Input data and parameters are only stored for as long as required to serve the results. </p>
          <p>We track anonymous daily usage statistics (page visits, pipeline stage counts, and success/failure rates) in order to demonstrate impact to funders and improve the service.</p>
          <p>All analytics are cookie-free.</p>
        </div>
      </div>
    </div>
  );
}
