import { PushDownButton } from './PushDownButton';
import DraggableSheet from './DraggableSheet';
import { ON_SURFACE, BORDER, PRIMARY, SURFACE } from '../utils/constants';
import { withAlpha } from '../utils/colorUtils';

interface ConfirmSheetProps {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export default function ConfirmSheet({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onClose,
}: ConfirmSheetProps) {
  const accent = destructive ? '#EF4444' : PRIMARY;

  return (
    <DraggableSheet onClose={onClose}>
      <div style={{ padding: '0 24px 32px' }}>
        <h3 style={{ fontSize: 20, fontWeight: 800, color: ON_SURFACE, margin: '0 0 8px', textAlign: 'center' }}>
          {title}
        </h3>
        {message && (
          <p style={{ fontSize: 14, color: withAlpha(ON_SURFACE, 0.6), margin: '0 0 22px', textAlign: 'center', lineHeight: 1.4 }}>
            {message}
          </p>
        )}
        {!message && <div style={{ height: 14 }} />}

        <PushDownButton color={accent} onTap={() => { onConfirm(); onClose(); }}>
          <span style={{ color: '#FFF', fontWeight: 700, fontSize: 16, padding: '0 18px' }}>
            {confirmLabel}
          </span>
        </PushDownButton>

        <button
          onClick={onClose}
          style={{
            display: 'block',
            width: '100%',
            marginTop: 12,
            padding: '14px 16px',
            borderRadius: 14,
            border: `1.5px solid ${BORDER}`,
            backgroundColor: SURFACE,
            color: ON_SURFACE,
            fontSize: 15,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          {cancelLabel}
        </button>
      </div>
    </DraggableSheet>
  );
}
