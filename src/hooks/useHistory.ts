import { useState, useCallback, useRef, useEffect } from 'react';

const MAX_HISTORY = 50;

export interface HistoryControls<T> {
  state: T;
  set: (next: T) => void;
  patch: (partial: Partial<T>) => void;
  commit: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

interface HistoryState<T> {
  entries: T[];
  index: number;
  dirty: boolean;
}

export function useHistory<T>(initial: T, onChange?: (state: T) => void): HistoryControls<T> {
  const [hist, setHist] = useState<HistoryState<T>>({
    entries: [initial],
    index: 0,
    dirty: false,
  });

  const state = hist.entries[hist.index];
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Fire onChange whenever hist changes (skip initial)
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    onChangeRef.current?.(hist.entries[hist.index]);
  }, [hist]);

  const set = useCallback((next: T) => {
    setHist(h => {
      const base = h.entries.slice(0, h.dirty ? h.index : h.index + 1);
      const entries = [...base, next].slice(-MAX_HISTORY);
      return { entries, index: entries.length - 1, dirty: false };
    });
  }, []);

  const patch = useCallback((partial: Partial<T>) => {
    setHist(h => {
      const current = h.entries[h.index];
      const patched = { ...current, ...partial };
      if (!h.dirty) {
        const entries = [...h.entries.slice(0, h.index + 1), patched].slice(-MAX_HISTORY);
        return { entries, index: entries.length - 1, dirty: true };
      }
      const entries = [...h.entries];
      entries[h.index] = patched;
      return { entries, index: h.index, dirty: true };
    });
  }, []);

  const commit = useCallback(() => {
    setHist(h => (h.dirty ? { ...h, dirty: false } : h));
  }, []);

  const undo = useCallback(() => {
    setHist(h => {
      if (h.dirty) {
        const entries = h.entries.slice(0, h.index);
        return { entries, index: entries.length - 1, dirty: false };
      }
      if (h.index <= 0) return h;
      return { ...h, index: h.index - 1 };
    });
  }, []);

  const redo = useCallback(() => {
    setHist(h => {
      if (h.index >= h.entries.length - 1) return h;
      return { ...h, index: h.index + 1 };
    });
  }, []);

  const canUndo = hist.dirty || hist.index > 0;
  const canRedo = !hist.dirty && hist.index < hist.entries.length - 1;

  return { state, set, patch, commit, undo, redo, canUndo, canRedo };
}
