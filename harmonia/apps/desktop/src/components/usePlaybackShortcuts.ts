// @ts-nocheck
import { useEffect } from 'react';
import type { SessionController } from '../../../../packages/application/session';
export function usePlaybackShortcuts(
  controller: SessionController,
  duration: number,
  editingId: string | null,
  onSeek?: (seconds: number) => void,
) {
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLButtonElement ||
        editingId
      )
        return;
      if (event.code === 'Space') {
        event.preventDefault();
        void controller.togglePlayback();
      }
      if (event.code === 'ArrowRight') {
        event.preventDefault();
        const seconds = Math.min(duration, controller.player.position + 5);
        if (onSeek) onSeek(seconds);
        else controller.player.seek(seconds);
      }
      if (event.code === 'ArrowLeft') {
        event.preventDefault();
        const seconds = Math.max(0, controller.player.position - 5);
        if (onSeek) onSeek(seconds);
        else controller.player.seek(seconds);
      }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [controller, duration, editingId, onSeek]);
}
