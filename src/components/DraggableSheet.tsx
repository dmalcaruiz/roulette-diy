import { useState, useEffect, useCallback, useRef } from 'react';
import { SURFACE } from '../utils/constants';
import { oklchShadow, oklchHighlight } from '../utils/colorUtils';

interface DraggableSheetProps {
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: number;
}

const DISMISS_THRESHOLD = 100;
// Vertical travel before a press is treated as a sheet-drag rather than a tap.
// Below this we leave the gesture alone so child buttons keep native click
// behaviour (a tap that slides off the button never commits).
const DRAG_START = 6;

export default function DraggableSheet({ onClose, children, maxWidth = 500 }: DraggableSheetProps) {
  const [visible, setVisible] = useState(false);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Height (px) the on-screen keyboard currently covers. The sheet is lifted
  // by this so an input inside it stays above the keyboard — and, crucially,
  // so the browser never scrolls the whole page up to reveal a focused field.
  const [keyboardInset, setKeyboardInset] = useState(0);
  const startYRef = useRef(0);
  const pointerIdRef = useRef<number | null>(null);

  // Solapa entrance stagger — revealed a beat AFTER the sheet has slid up,
  // for a layered reveal (mirrors SnappingSheet's solapa). Resets on close.
  const [solapaShown, setSolapaShown] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
  }, []);

  useEffect(() => {
    if (!visible) { setSolapaShown(false); return; }
    const id = setTimeout(() => setSolapaShown(true), 140);
    return () => clearTimeout(id);
  }, [visible]);

  // Track the keyboard via the visual viewport (the layout viewport doesn't
  // shrink for an overlay keyboard, so window height alone can't see it).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onChange = () => {
      setKeyboardInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    };
    vv.addEventListener('resize', onChange);
    vv.addEventListener('scroll', onChange);
    onChange();
    return () => {
      vv.removeEventListener('resize', onChange);
      vv.removeEventListener('scroll', onChange);
    };
  }, []);

  const handleClose = useCallback(() => {
    setVisible(false);
    setDragY(0);
    setTimeout(onClose, 300);
  }, [onClose]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    startYRef.current = e.clientY;
    pointerIdRef.current = e.pointerId;
    // Intentionally NO setPointerCapture here. Capturing the pressed element
    // would route the eventual `click` to it even if the finger slides off,
    // so child buttons would commit on tap-and-slide-off (the browser's
    // normal "click cancels when you lift off the element" stops applying
    // under capture). Capture is deferred to onPointerMove, once we know
    // it's a real drag — and then it's the container that's captured, not
    // the button.
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (pointerIdRef.current !== e.pointerId) return;
    const dy = Math.max(0, e.clientY - startYRef.current);
    if (!dragging) {
      // Still a tap until it travels past DRAG_START — keep native click
      // semantics so a slide-off doesn't commit the underlying button.
      if (dy < DRAG_START) return;
      setDragging(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    setDragY(dy);
  }, [dragging]);

  const onPointerUp = useCallback(() => {
    pointerIdRef.current = null;
    if (!dragging) return; // pure tap — let the child button's own click commit
    setDragging(false);
    if (dragY > DISMISS_THRESHOLD) {
      handleClose();
    } else {
      setDragY(0);
    }
  }, [dragging, dragY, handleClose]);

  const backdropOpacity = visible ? Math.max(0, 0.4 * (1 - dragY / 400)) : 0;

  return (
    <div
      onClick={handleClose}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: `rgba(0,0,0,${backdropOpacity})`,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        // Reserve the keyboard's space so the bottom-anchored sheet rises to
        // sit just above it instead of the page scrolling up underneath.
        paddingBottom: keyboardInset,
        transition: dragging ? 'none' : 'background-color 0.3s ease, padding-bottom 0.2s ease',
      }}
    >
      {/* Wrapper carries the entrance/drag transform + drag handlers and is
          the positioning context for the solapa. The solapa is a SIBLING of
          the opaque sheet (painted before it in DOM, so the sheet covers it),
          which lets it tuck behind the sheet and slide UP from the top edge —
          exactly like SnappingSheet, instead of a fade. */}
      <div
        onClick={e => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          width: '100%',
          maxWidth,
          position: 'relative',
          transform: visible ? `translateY(${dragY}px)` : 'translateY(100%)',
          transition: dragging ? 'none' : 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
          touchAction: 'none',
        }}
      >
        {/* Close solapa — slides up from BEHIND the sheet's top-right edge.
            Hidden state tucks it down (translateY 120) where the opaque sheet
            painted on top covers it; shown state slides it to its peek. */}
        <button
          onClick={handleClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: -36,
            right: 20,
            width: 40,
            height: 36,
            touchAction: 'none',
            borderRadius: '999px 999px 0 0',
            backgroundColor: oklchShadow(SURFACE, 0.02),
            // 3px stroke, lighter than the sheet bg, so the tab reads as a
            // raised pill; no bottom stroke so it fuses with the sheet edge.
            borderTop: `3px solid ${oklchHighlight(SURFACE, 0.02)}`,
            borderLeft: `3px solid ${oklchHighlight(SURFACE, 0.02)}`,
            borderRight: `3px solid ${oklchHighlight(SURFACE, 0.02)}`,
            padding: 0,
            paddingTop: 9,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            cursor: 'pointer',
            transform: solapaShown ? 'translateY(0)' : 'translateY(120px)',
            transition: 'transform 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          <div style={{
            width: 22,
            height: 22,
            backgroundColor: '#FFFFFF',
            WebkitMaskImage: 'url(/images/close.svg)',
            WebkitMaskRepeat: 'no-repeat',
            WebkitMaskSize: 'contain',
            WebkitMaskPosition: 'center',
            maskImage: 'url(/images/close.svg)',
            maskRepeat: 'no-repeat',
            maskSize: 'contain',
            maskPosition: 'center',
          }} />
        </button>
        {/* Opaque sheet — paints OVER the tucked solapa; overflow:hidden clips
            content to the rounded top edge. */}
        <div style={{
          position: 'relative',
          backgroundColor: SURFACE,
          borderRadius: '24px 24px 0 0',
          maxHeight: '85dvh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          {/* Grab handle — same bar as SnappingSheet (white, low opacity).
              Generous top padding so the bar breathes below the sheet edge;
              tighter bottom so the title beneath it doesn't sit too far down. */}
          <div style={{ padding: '14px 0 8px', cursor: 'grab', flexShrink: 0 }}>
            <div style={{
              width: 44, height: 5,
              backgroundColor: 'rgba(255, 255, 255, 0.2)',
              borderRadius: 2.5,
              margin: '0 auto',
            }} />
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
