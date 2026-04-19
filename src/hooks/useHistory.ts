import { useState, useCallback, useRef, useEffect } from 'react';
import { dbg } from '../utils/debugLog';

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

export function useHistory<T>(
  initial: T,
  onChange?: (state: T) => void,
  // When this key changes, the history is reset to a fresh single-entry
  // stack with the current `initial` value. Used to re-initialize the
  // editor's state when the underlying entity being edited changes
  // (e.g., switching between wheels in a flow) without remounting the
  // host component.
  resetKey?: string | number,
): HistoryControls<T> {
  const [hist, setHist] = useState<HistoryState<T>>({
    entries: [initial],
    index: 0,
    dirty: false,
  });

  const state = hist.entries[hist.index];
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Latest `initial` kept in a ref so the reset effect grabs the most
  // recent value without depending on it (which would fire every render).
  const initialRef = useRef(initial);
  initialRef.current = initial;

  // Reset on resetKey change — skip the first render so mount doesn't
  // double-initialize.
  const prevResetKeyRef = useRef<string | number | undefined>(resetKey);
  const mountedResetRef = useRef(false);
  useEffect(() => {
    if (!mountedResetRef.current) {
      mountedResetRef.current = true;
      prevResetKeyRef.current = resetKey;
      return;
    }
    if (resetKey !== prevResetKeyRef.current) {
      dbg('useHistory', 'reset', { from: String(prevResetKeyRef.current ?? 'null'), to: String(resetKey ?? 'null') });
      prevResetKeyRef.current = resetKey;
      setHist({ entries: [initialRef.current], index: 0, dirty: false });
      mountedOnChangeRef.current = false;
    }
  }, [resetKey]);

  // Fire onChange whenever hist changes (skip initial AND skip immediately
  // after a reset so we don't re-fire a preview for the reset.)
  const mountedOnChangeRef = useRef(false);
  useEffect(() => {
    if (!mountedOnChangeRef.current) {
      mountedOnChangeRef.current = true;
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
