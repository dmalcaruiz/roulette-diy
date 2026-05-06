import { useEffect, useState } from 'react';
import { PushDownButton, InsetTextField } from '../components/PushDownButton';
import { ON_SURFACE, BORDER, PRIMARY, BG, SURFACE } from '../utils/constants';
import { withAlpha } from '../utils/colorUtils';
import { useAuth } from '../contexts/AuthContext';
import { createProfile, isHandleAvailable } from '../services/profileService';
import { normalizeHandle, isValidHandle } from '../types/profile';
import { Check, X as XIcon, Loader2 } from 'lucide-react';

export default function ProfileSetupScreen() {
  const { user, refreshProfile } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [handle, setHandle] = useState('');
  const [bio, setBio] = useState('');
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const normalized = normalizeHandle(handle);
  const validFormat = isValidHandle(normalized);

  // Debounced availability check
  useEffect(() => {
    if (!validFormat) { setAvailable(null); return; }
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        setAvailable(await isHandleAvailable(normalized));
      } catch {
        setAvailable(null);
      } finally {
        setChecking(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [normalized, validFormat]);

  const canSubmit =
    !!user && displayName.trim().length > 0 && validFormat && available === true && !submitting;

  const onSubmit = async () => {
    if (!canSubmit || !user) return;
    setSubmitting(true);
    setErr(null);
    try {
      await createProfile({
        uid: user.uid,
        displayName: displayName.trim(),
        handle: normalized,
        bio: bio.trim() || undefined,
        photoUrl: user.photoURL ?? undefined,
      });
      await refreshProfile();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong.');
      setSubmitting(false);
    }
  };

  return (
    <div style={{
      height: '100dvh',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      padding: '0 28px',
      backgroundColor: BG,
    }}>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: ON_SURFACE, margin: '0 0 8px' }}>
        Set up your profile
      </h1>
      <p style={{ fontSize: 15, color: withAlpha(ON_SURFACE, 0.55), margin: '0 0 28px' }}>
        Pick a handle. This is how others find you.
      </p>

      <label style={labelStyle}>Display name</label>
      <InsetTextField value={displayName} onChange={setDisplayName} placeholder="Your name" />

      <div style={{ height: 16 }} />

      <label style={labelStyle}>Handle</label>
      <div style={{ position: 'relative' }}>
        <InsetTextField
          value={handle}
          onChange={v => setHandle(v.toLowerCase())}
          placeholder="yourhandle"
        />
        <div style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)' }}>
          {checking && <Loader2 size={18} color={withAlpha(ON_SURFACE, 0.4)} className="spin" />}
          {!checking && handle.length > 0 && validFormat && available === true && <Check size={18} color="#10B981" />}
          {!checking && handle.length > 0 && (available === false || !validFormat) && <XIcon size={18} color="#EF4444" />}
        </div>
      </div>
      <p style={{ fontSize: 12, color: withAlpha(ON_SURFACE, 0.5), margin: '6px 4px 0' }}>
        {handle.length === 0
          ? '3–20 chars, lowercase letters, numbers, underscores.'
          : !validFormat
          ? 'Invalid: 3–20 chars, a–z, 0–9, _ only.'
          : available === false
          ? 'Taken — try another.'
          : available === true
          ? 'Available.'
          : ' '}
      </p>

      <div style={{ height: 16 }} />

      <label style={labelStyle}>Bio (optional)</label>
      <textarea
        value={bio}
        onChange={e => setBio(e.target.value.slice(0, 160))}
        placeholder="A line about you…"
        rows={3}
        style={{
          width: '100%',
          padding: '12px 14px',
          borderRadius: 14,
          border: `1.5px solid ${BORDER}`,
          backgroundColor: '#F8F8F9',
          fontSize: 15,
          fontFamily: 'inherit',
          outline: 'none',
          resize: 'none',
        }}
      />

      {err && (
        <p style={{ fontSize: 13, color: '#EF4444', marginTop: 12 }}>{err}</p>
      )}

      <div style={{ height: 24 }} />
      <PushDownButton color={PRIMARY} onTap={canSubmit ? onSubmit : undefined}>
        <span style={{ color: '#FFF', fontWeight: 700, fontSize: 16, opacity: canSubmit ? 1 : 0.6 }}>
          {submitting ? 'Creating…' : 'Create profile'}
        </span>
      </PushDownButton>
    </div>
  );
}

const labelStyle = {
  display: 'block',
  fontSize: 13,
  fontWeight: 700,
  color: withAlpha(ON_SURFACE, 0.6),
  margin: '0 0 6px 4px',
} as const;
