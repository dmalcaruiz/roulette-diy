import { useState, useEffect, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import { SURFACE, SURFACE_ELEVATED } from '../utils/constants';

interface DraggableSheetProps {
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: number;
}

const DISMISS_THRESHOLD = 100;

export default function DraggableSheet({ onClose, children, maxWidth = 500 }: DraggableSheetProps) {
  const [visible, setVisible] = useState(false);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startYRef = useRef(0);

  useEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
  }, []);

  const handleClose = useCallback(() => {
    setVisible(false);
    setDragY(0);
    setTimeout(onClose, 300);
  }, [onClose]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    startYRef.current = e.clientY;
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    const dy = Math.max(0, e.clientY - startYRef.current);
    setDragY(dy);
  }, [dragging]);

  const onPointerUp = useCallback(() => {
    if (!dragging) return;
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
        transition: dragging ? 'none' : 'background-color 0.3s ease',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          backgroundColor: SURFACE,
          borderRadius: '24px 24px 0 0',
          width: '100%',
          maxWidth,
          transform: visible ? `translateY(${dragY}px)` : 'translateY(100%)',
          transition: dragging ? 'none' : 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
          touchAction: 'none',
          maxHeight: '85dvh',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
        }}
      >
        {/* Drag handle */}
        <div style={{ padding: '12px 0 8px', cursor: 'grab', flexShrink: 0 }}>
          <div style={{
            width: 48, height: 5,
            backgroundColor: '#D4D4D8',
            borderRadius: 3,
            margin: '0 auto',
          }} />
        </div>
        {/* Top-right close button */}
        <button
          onClick={handleClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 12,
            right: 14,
            width: 32,
            height: 32,
            borderRadius: 50,
            backgroundColor: SURFACE_ELEVATED,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            cursor: 'pointer',
            zIndex: 1,
          }}
        >
          <X size={16} color="#1E1E2C" />
        </button>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {children}
        </div>
      </div>
    </div>
  );
}
