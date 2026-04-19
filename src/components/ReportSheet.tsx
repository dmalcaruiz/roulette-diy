import { useState } from 'react';
import DraggableSheet from './DraggableSheet';
import { PushDownButton } from './PushDownButton';
import { ON_SURFACE, BORDER, PRIMARY } from '../utils/constants';
import { withAlpha } from '../utils/colorUtils';
import { useAuth } from '../contexts/AuthContext';
import { submitReport, type ReportReason, type ReportTargetKind } from '../services/reportService';
import { CheckCircle, Circle, Loader2 } from 'lucide-react';

const REASONS: { value: ReportReason; label: string; desc: string }[] = [
  { value: 'nsfw',       label: 'Nudity or sexual content', desc: 'Explicit imagery that shouldn\'t be here.' },
  { value: 'harassment', label: 'Harassment or hate',       desc: 'Attacks a person or group.' },
  { value: 'spam',       label: 'Spam',                     desc: 'Commercial or repetitive noise.' },
  { value: 'off-topic',  label: 'Off-topic',                desc: 'Doesn\'t fit the wheel or challenge.' },
  { value: 'copyright',  label: 'Copyright',                desc: 'Uses content without permission.' },
  { value: 'other',      label: 'Something else',           desc: 'Tell us below.' },
];

interface ReportSheetProps {
  targetKind: ReportTargetKind;
  targetId: string;
  parentWheelId?: string | null;
  onClose: () => void;
}

export default function ReportSheet({ targetKind, targetId, parentWheelId, onClose }: ReportSheetProps) {
  const { profile } = useAuth();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canSubmit = !!profile && !!reason && !submitting;

  const onSubmit = async () => {
    if (!profile || !reason) return;
    setSubmitting(true);
    setErr(null);
    try {
      await submitReport({
        reporterId: profile.uid,
        targetKind,
        targetId,
        parentWheelId: parentWheelId ?? null,
        reason,
        note: note.trim() || undefined,
      });
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to submit report.');
      setSubmitting(false);
    }
  };

  return (
    <DraggableSheet onClose={onClose}>
      <div style={{ padding: '0 24px 32px' }}>
        {done ? (
          <>
            <h3 style={{ fontSize: 20, fontWeight: 800, textAlign: 'center', margin: '0 0 12px' }}>
              Report received
            </h3>
            <p style={{ fontSize: 14, color: withAlpha(ON_SURFACE, 0.6), textAlign: 'center', margin: '0 0 20px' }}>
              Thanks — we'll take a look.
            </p>
            <PushDownButton color={PRIMARY} onTap={onClose}>
              <span style={{ color: '#FFF', fontWeight: 700, fontSize: 15 }}>Done</span>
            </PushDownButton>
          </>
        ) : (
          <>
            <h3 style={{ fontSize: 20, fontWeight: 800, textAlign: 'center', margin: '0 0 18px' }}>
              Report
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
              {REASONS.map(r => {
                const active = reason === r.value;
                return (
                  <div
                    key={r.value}
                    onClick={() => setReason(r.value)}
                    style={{
                      display: 'flex',
                      gap: 12,
                      padding: '12px 14px',
                      borderRadius: 14,
                      border: `1.5px solid ${active ? PRIMARY : BORDER}`,
                      backgroundColor: active ? withAlpha(PRIMARY, 0.08) : '#FFF',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ marginTop: 2 }}>
                      {active ? <CheckCircle size={20} color={PRIMARY} /> : <Circle size={20} color={BORDER} />}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: ON_SURFACE }}>{r.label}</div>
                      <div style={{ fontSize: 12, color: withAlpha(ON_SURFACE, 0.55), marginTop: 1 }}>{r.desc}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            <textarea
              value={note}
              onChange={e => setNote(e.target.value.slice(0, 500))}
              placeholder="Add details (optional)…"
              rows={3}
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: 12,
                border: `1.5px solid ${BORDER}`,
                backgroundColor: '#F8F8F9',
                fontSize: 14,
                fontFamily: 'inherit',
                outline: 'none',
                resize: 'none',
              }}
            />

            {err && <p style={{ fontSize: 13, color: '#EF4444', marginTop: 12 }}>{err}</p>}

            <div style={{ height: 16 }} />
            <PushDownButton color="#EF4444" onTap={canSubmit ? onSubmit : undefined}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#FFF' }}>
                {submitting && <Loader2 size={16} className="spin" />}
                <span style={{ fontWeight: 700, fontSize: 15, opacity: canSubmit ? 1 : 0.6 }}>
                  {submitting ? 'Sending…' : 'Send report'}
                </span>
              </div>
            </PushDownButton>
          </>
        )}
      </div>
    </DraggableSheet>
  );
}
