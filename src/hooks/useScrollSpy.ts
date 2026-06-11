import { useCallback, useEffect, useRef, useState } from 'react';

// Generic scroll-spy: tag stacked sections by key, get told which one is
// currently under an "active line" near the top of the scroll container, and
// imperatively scroll to a section. Wheel-agnostic — knows only DOM + keys.
//
// The scroll root is DISCOVERED by walking up from a registered element to the
// nearest scrollable ancestor (the same recipe WheelEditor uses), so the hook
// works even when it doesn't own the scroll node (e.g. inside SnappingSheet).

export interface ScrollSpyOptions<K extends string> {
  onActiveChange?: (key: K) => void;
  // Fraction from the TOP of the scroll viewport where the active line sits;
  // the section crossing that line is "active". Default 0.2 (20% down).
  activeLineRatio?: number;
  // Re-discover the root + re-observe when this changes (e.g. wheel id).
  resetKey?: string | number;
}

export interface ScrollSpyHandle<K extends string> {
  // Ref-callback factory for `ref={register('key')}`. Stable per key.
  register: (key: K) => (el: HTMLElement | null) => void;
  // Imperative form for handing to a child as a `(key, el) => void` prop.
  registerEl: (key: K, el: HTMLElement | null) => void;
  scrollTo: (key: K, opts?: { instant?: boolean }) => void;
  activeKey: K | null;
}

export function useScrollSpy<K extends string>(
  keys: readonly K[],
  options: ScrollSpyOptions<K> = {},
): ScrollSpyHandle<K> {
  const { onActiveChange, activeLineRatio = 0.2, resetKey } = options;

  // Live mirrors so the stable callbacks below never capture stale options.
  const keysRef = useRef(keys); keysRef.current = keys;
  const onActiveRef = useRef(onActiveChange); onActiveRef.current = onActiveChange;
  const lineRef = useRef(activeLineRatio); lineRef.current = activeLineRatio;

  const elsRef = useRef(new Map<K, HTMLElement>());
  const refCbRef = useRef(new Map<K, (el: HTMLElement | null) => void>());
  const elKeyRef = useRef(new WeakMap<Element, K>());
  const intersectingRef = useRef(new Set<K>());
  const rootRef = useRef<HTMLElement | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const scrollCbRef = useRef<(() => void) | null>(null);
  const rafRef = useRef(0);
  const activeRef = useRef<K | null>(null);
  const [activeKey, setActiveKey] = useState<K | null>(null);

  const recomputeActive = useCallback(() => {
    const root = rootRef.current;
    const ks = keysRef.current;
    let next: K | null = null;
    if (root && ks.length > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 2) {
      // Bottom-pinned — the last section may be too short to reach the line.
      next = ks[ks.length - 1];
    } else {
      // Last section (in declared order) currently crossing the active line.
      for (const k of ks) if (intersectingRef.current.has(k)) next = k;
    }
    // Sticky: never clear to null mid-scroll — keep the previous active.
    if (next && next !== activeRef.current) {
      activeRef.current = next;
      setActiveKey(next);
      onActiveRef.current?.(next);
    }
  }, []);

  const handleIntersect = useCallback<IntersectionObserverCallback>((entries) => {
    for (const e of entries) {
      const k = elKeyRef.current.get(e.target);
      if (!k) continue;
      if (e.isIntersecting) intersectingRef.current.add(k);
      else intersectingRef.current.delete(k);
    }
    recomputeActive();
  }, [recomputeActive]);

  const teardown = useCallback(() => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (rootRef.current && scrollCbRef.current) rootRef.current.removeEventListener('scroll', scrollCbRef.current);
    scrollCbRef.current = null;
    cancelAnimationFrame(rafRef.current);
    intersectingRef.current.clear();
  }, []);

  const ensureObserver = useCallback(() => {
    if (observerRef.current) return;
    const first = elsRef.current.values().next().value as HTMLElement | undefined;
    if (!first) return;
    // Nearest scrollable ancestor. Looser check (no scrollHeight>clientHeight
    // guard) so a not-yet-overflowing sheet still resolves to the real scroller.
    let root: HTMLElement | null = first.parentElement;
    while (root) {
      const cs = getComputedStyle(root);
      if (/(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflow)) break;
      root = root.parentElement;
    }
    rootRef.current = root;
    const L = Math.round(lineRef.current * 100);
    const obs = new IntersectionObserver(handleIntersect, {
      root: root ?? null,
      rootMargin: `-${L}% 0px -${Math.max(0, 99 - L)}% 0px`,
      threshold: [0, 1],
    });
    observerRef.current = obs;
    elsRef.current.forEach(el => obs.observe(el));
    if (root) {
      const cb = () => { cancelAnimationFrame(rafRef.current); rafRef.current = requestAnimationFrame(recomputeActive); };
      scrollCbRef.current = cb;
      root.addEventListener('scroll', cb, { passive: true });
    }
    recomputeActive();
  }, [handleIntersect, recomputeActive]);

  const registerEl = useCallback((key: K, el: HTMLElement | null) => {
    const prev = elsRef.current.get(key);
    if (prev && prev !== el) observerRef.current?.unobserve(prev);
    if (el) {
      elKeyRef.current.set(el, key);
      elsRef.current.set(key, el);
      if (observerRef.current) observerRef.current.observe(el);
      else ensureObserver();
    } else {
      elsRef.current.delete(key);
      intersectingRef.current.delete(key);
    }
  }, [ensureObserver]);

  const register = useCallback((key: K) => {
    let cb = refCbRef.current.get(key);
    if (!cb) {
      cb = (el: HTMLElement | null) => registerEl(key, el);
      refCbRef.current.set(key, cb);
    }
    return cb;
  }, [registerEl]);

  const scrollTo = useCallback((key: K, opts?: { instant?: boolean }) => {
    const el = elsRef.current.get(key);
    if (!el) return;
    const behavior: ScrollBehavior = opts?.instant ? 'auto' : 'smooth';
    const root = rootRef.current;
    if (!root) { el.scrollIntoView({ block: 'start', behavior }); return; }
    const elRect = el.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    root.scrollTo({ top: root.scrollTop + (elRect.top - rootRect.top), behavior });
  }, []);

  // (Re)create on mount + when resetKey changes (wheel switch).
  useEffect(() => {
    teardown();
    activeRef.current = null;
    ensureObserver();
    return teardown;
  }, [resetKey, teardown, ensureObserver]);

  return { register, registerEl, scrollTo, activeKey };
}
