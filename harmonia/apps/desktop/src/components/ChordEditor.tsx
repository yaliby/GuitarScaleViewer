// @ts-nocheck
import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { formatChord, parseChord } from '../../../../packages/domain/chord';
import type { ChordSegment } from '../../../../packages/domain/types';
import type { SessionController } from '../../../../packages/application/session';

export function ChordEditor({
  segment,
  controller,
  onClose,
  transposed,
}: {
  segment: ChordSegment;
  controller: SessionController;
  onClose: () => void;
  transposed: boolean;
}) {
  const [symbol, setSymbol] = useState(formatChord(segment.chord));
  const [start, setStart] = useState(String(segment.start));
  const [end, setEnd] = useState(String(segment.end));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const ref = useRef<HTMLDialogElement>(null);
  const symbolInput = useRef<HTMLInputElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    symbolInput.current?.focus();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError('');
    try {
      const chord = parseChord(symbol);
      const startTime = Number(start),
        endTime = Number(end);
      if (!start.trim() || !end.trim() || !Number.isFinite(startTime) || !Number.isFinite(endTime))
        throw new Error('Enter valid start and end times');
      await controller.editSegment(segment.id, { chord, start: startTime, end: endTime });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Invalid chord');
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }
  return (
    <dialog
      ref={ref}
      className="editor"
      aria-labelledby={titleId}
      onCancel={onClose}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls = event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled])',
        );
        const first = controls[0],
          last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <form onSubmit={save}>
        <div className="section-heading">
          <span className="eyebrow">YOUR MUSICAL JUDGMENT</span>
          <button type="button" className="icon-button" aria-label="Close editor" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <h2 id={titleId}>Refine this moment.</h2>
        <p>Corrections stay in your local library.</p>
        {transposed && (
          <p className="hint">
            Edits use the original pitch; display transposition is not applied.
          </p>
        )}
        <label>
          Chord symbol
          <input
            ref={symbolInput}
            disabled={saving}
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
            placeholder="G13(b9)/B"
          />
        </label>
        <label>
          Start time in seconds
          <input
            type="number"
            step="any"
            value={start}
            disabled={saving}
            onChange={(event) => setStart(event.target.value)}
          />
        </label>
        <label>
          End time in seconds
          <input
            type="number"
            step="any"
            value={end}
            disabled={saving}
            onChange={(event) => setEnd(event.target.value)}
          />
        </label>
        <p className="hint">
          Supports extensions, alterations and slash chords. Use N for no chord. Touching neighbors
          move with the boundary. Other neighbors stay fixed; uncovered time has no chord label.
        </p>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <button className="primary" type="submit" disabled={saving}>
          {saving ? 'Saving correction…' : 'Save correction'}
        </button>
      </form>
    </dialog>
  );
}
