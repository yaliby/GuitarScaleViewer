// @ts-nocheck
import { AudioLines, X } from 'lucide-react';

export function SessionError({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      <button className="icon-button" aria-label="Dismiss error" onClick={onDismiss}>
        <X size={16} />
      </button>
    </div>
  );
}

export function AnalysisProgress({
  stage,
  progress,
  onCancel,
}: {
  stage: string;
  progress: number;
  onCancel: () => void;
}) {
  return (
    <div className="analysis-progress" role="status">
      <AudioLines className="analysis-icon" size={56} strokeWidth={1} />
      <span className="eyebrow">LISTENING CLOSELY</span>
      <h1>{stage}</h1>
      <p>Your audio stays on this device.</p>
      <progress value={progress} max="1" />
      <div>
        <span>{Math.round(progress * 100)}%</span>
        <button className="text-button" onClick={onCancel}>
          Cancel analysis
        </button>
      </div>
    </div>
  );
}
