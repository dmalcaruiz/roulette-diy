import { useState } from 'react';
import DraggableSheet from './DraggableSheet';
import { PushDownButton } from './PushDownButton';
import { ON_SURFACE, BORDER, PRIMARY } from '../utils/constants';
import { withAlpha } from '../utils/colorUtils';
import { useAuth } from '../contexts/AuthContext';
import { submitChallengeResponse } from '../services/responseService';
import { ImageIcon, Loader2 } from 'lucide-react';

interface ResponseUploadSheetProps {
  wheelId: string;
  resultSegmentIndex: number;
  resultSegmentText: string;
  challengePrompt?: string | null;
  onClose: () => void;
  onUploaded: (responseId: string) => void;
}

export default function ResponseUploadSheet({
  wheelId, resultSegmentIndex, resultSegmentText, challengePrompt, onClose, onUploaded,
}: ResponseUploadSheetProps) {
  const { profile } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(f));
  };

  const canSubmit = !!profile && !!file && !submitting;

  const onSubmit = async () => {
    if (!profile || !file) return;
    setSubmitting(true);
    setErr(null);
    try {
      const id = await submitChallengeResponse({
        wheelId,
        author: profile,
        image: file,
        caption: caption.trim() || undefined,
        resultSegmentIndex,
        resultSegmentText,
      });
      onUploaded(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Upload failed.');
      setSubmitting(false);
    }
  };

  return (
    <DraggableSheet onClose={onClose}>
      <div style={{ padding: '0 24px 32px' }}>
        <h3 style={{ fontSize: 20, fontWeight: 800, textAlign: 'center', margin: '0 0 4px' }}>
          Upload response
        </h3>
        <p style={{ fontSize: 13, textAlign: 'center', color: withAlpha(ON_SURFACE, 0.55), margin: '0 0 18px' }}>
          You landed on <strong style={{ color: ON_SURFACE }}>{resultSegmentText}</strong>
        </p>

        {challengePrompt && (
          <div style={{
            padding: '12px 14px',
            borderRadius: 12,
            backgroundColor: withAlpha(PRIMARY, 0.08),
            border: `1.5px solid ${withAlpha(PRIMARY, 0.2)}`,
            marginBottom: 16,
            fontSize: 14,
            fontWeight: 600,
            color: ON_SURFACE,
          }}>
            "{challengePrompt}"
          </div>
        )}

        {/* Image picker / preview */}
        <label style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 200,
          borderRadius: 14,
          border: `1.5px dashed ${BORDER}`,
          cursor: 'pointer',
          backgroundColor: '#F8F8F9',
          overflow: 'hidden',
          backgroundImage: previewUrl ? `url(${previewUrl})` : undefined,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}>
          {!previewUrl && (
            <>
              <ImageIcon size={32} color={withAlpha(ON_SURFACE, 0.4)} />
              <span style={{ fontSize: 14, fontWeight: 600, color: withAlpha(ON_SURFACE, 0.6), marginTop: 8 }}>
                Tap to pick a photo
              </span>
            </>
          )}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={onPick}
            style={{ display: 'none' }}
          />
        </label>

        <div style={{ marginTop: 14 }}>
          <textarea
            value={caption}
            onChange={e => setCaption(e.target.value.slice(0, 200))}
            placeholder="Add a caption (optional)…"
            rows={2}
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
        </div>

        {err && <p style={{ fontSize: 13, color: '#EF4444', marginTop: 12 }}>{err}</p>}

        <div style={{ height: 18 }} />
        <PushDownButton color={PRIMARY} onTap={canSubmit ? onSubmit : undefined}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#FFF' }}>
            {submitting && <Loader2 size={18} className="spin" />}
            <span style={{ fontWeight: 700, fontSize: 16, opacity: canSubmit ? 1 : 0.6 }}>
              {submitting ? 'Uploading…' : 'Submit'}
            </span>
          </div>
        </PushDownButton>
      </div>
    </DraggableSheet>
  );
}
