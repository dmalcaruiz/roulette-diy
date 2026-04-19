import { useState } from 'react';
import DraggableSheet from './DraggableSheet';
import { PushDownButton, InsetTextField } from './PushDownButton';
import { ON_SURFACE, BORDER, PRIMARY } from '../utils/constants';
import { withAlpha } from '../utils/colorUtils';
import { useAuth } from '../contexts/AuthContext';
import { publishWheel } from '../services/publishService';
import { uploadImage } from '../services/uploadService';
import type { Block } from '../models/types';
import { CheckCircle, Circle, ImageIcon, Loader2, Trophy } from 'lucide-react';

interface PublishSheetProps {
  draft: Block;
  onClose: () => void;
  onPublished: (wheelId: string) => void;
}

export default function PublishSheet({ draft, onClose, onPublished }: PublishSheetProps) {
  const { profile } = useAuth();
  const [isChallenge, setIsChallenge] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canSubmit = !!profile && !submitting && (!isChallenge || prompt.trim().length > 0);

  const onPickCover = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setCoverFile(f);
  };

  const onSubmit = async () => {
    if (!profile || !canSubmit) return;
    setSubmitting(true);
    setErr(null);
    try {
      let coverUrl: string | undefined;
      // Cover image must be uploaded AFTER we know the wheel ID, but the upload
      // purpose 'wheel-cover' wants wheelId. Solution: publish first with no cover,
      // then upload + patch. For v1 we skip cover if it's heavy — keep it simple.
      const wheelId = await publishWheel({
        author: profile,
        draft,
        isChallenge,
        challengePrompt: isChallenge ? prompt.trim() : null,
        coverUrl: null,
      });
      if (coverFile) {
        coverUrl = await uploadImage({
          purpose: 'wheel-cover',
          source: coverFile,
          wheelId,
        });
        // Patch the cover URL via a second write. Rules allow the author to update their own wheel.
        const { doc, setDoc, serverTimestamp } = await import('firebase/firestore');
        const { db } = await import('../firebase');
        await setDoc(doc(db, 'wheels', wheelId), {
          coverUrl,
          updatedAtServer: serverTimestamp(),
        }, { merge: true });
      }
      onPublished(wheelId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to publish.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DraggableSheet onClose={onClose}>
      <div style={{ padding: '0 24px 32px' }}>
        <h3 style={{ fontSize: 20, fontWeight: 800, textAlign: 'center', margin: '0 0 24px' }}>
          Publish wheel
        </h3>

        {/* Challenge toggle */}
        <div
          onClick={() => setIsChallenge(!isChallenge)}
          style={toggleRowStyle(isChallenge)}
        >
          <Trophy size={22} color={isChallenge ? PRIMARY : withAlpha(ON_SURFACE, 0.45)} />
          <div style={{ flex: 1, marginLeft: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: ON_SURFACE }}>Make it a challenge</div>
            <div style={{ fontSize: 12, color: withAlpha(ON_SURFACE, 0.55), marginTop: 2 }}>
              Others can upload photo responses to their spin result.
            </div>
          </div>
          {isChallenge
            ? <CheckCircle size={22} color={PRIMARY} />
            : <Circle size={22} color={BORDER} />
          }
        </div>

        {isChallenge && (
          <div style={{ marginTop: 14 }}>
            <label style={labelStyle}>Challenge prompt</label>
            <InsetTextField
              value={prompt}
              onChange={setPrompt}
              placeholder="Show us your spin result!"
            />
          </div>
        )}

        <div style={{ marginTop: 18 }}>
          <label style={labelStyle}>Cover image (optional)</label>
          <label style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 14px',
            borderRadius: 14,
            border: `1.5px dashed ${BORDER}`,
            cursor: 'pointer',
            backgroundColor: '#F8F8F9',
          }}>
            <ImageIcon size={20} color={withAlpha(ON_SURFACE, 0.5)} />
            <span style={{ fontSize: 14, fontWeight: 600, color: withAlpha(ON_SURFACE, 0.7) }}>
              {coverFile ? coverFile.name : 'Choose image…'}
            </span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={onPickCover}
              style={{ display: 'none' }}
            />
          </label>
        </div>

        {err && <p style={{ fontSize: 13, color: '#EF4444', marginTop: 14 }}>{err}</p>}

        <div style={{ height: 20 }} />
        <PushDownButton color={PRIMARY} onTap={canSubmit ? onSubmit : undefined}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#FFF' }}>
            {submitting && <Loader2 size={18} className="spin" />}
            <span style={{ fontWeight: 700, fontSize: 16, opacity: canSubmit ? 1 : 0.6 }}>
              {submitting ? 'Publishing…' : 'Publish'}
            </span>
          </div>
        </PushDownButton>
      </div>
    </DraggableSheet>
  );
}

const toggleRowStyle = (on: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  padding: '14px 16px',
  borderRadius: 14,
  backgroundColor: on ? withAlpha(PRIMARY, 0.12) : '#F4F4F5',
  border: `1.5px solid ${on ? PRIMARY : BORDER}`,
  cursor: 'pointer',
  transition: 'all 0.18s',
});

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 13,
  fontWeight: 700,
  color: withAlpha(ON_SURFACE, 0.6),
  margin: '0 0 6px 4px',
};
