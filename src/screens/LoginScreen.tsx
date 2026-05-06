import { signInWithPopup } from 'firebase/auth';
import { auth, googleProvider } from '../firebase';
import { ON_SURFACE, BG, SURFACE, BORDER } from '../utils/constants';
import { withAlpha } from '../utils/colorUtils';

interface LoginScreenProps {
  onLoginSuccess: () => void;
}

export default function LoginScreen({ onLoginSuccess }: LoginScreenProps) {
  const handleGoogleSignIn = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
      onLoginSuccess();
    } catch (e: any) {
      if (e.code !== 'auth/popup-closed-by-user') {
        console.error('Google sign-in error:', e);
      }
    }
  };

  return (
    <div style={{
      height: '100dvh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: BG,
      padding: '0 32px',
    }}>
      <h1 style={{
        fontSize: 28,
        fontWeight: 800,
        color: ON_SURFACE,
        textAlign: 'center',
        margin: '0 0 8px',
      }}>
        Roulette Maker
      </h1>
      <p style={{
        fontSize: 16,
        fontWeight: 400,
        color: withAlpha(ON_SURFACE, 0.55),
        textAlign: 'center',
        margin: '0 0 40px',
      }}>
        Sign in to save your blocks and sync across devices
      </p>

      <button
        onClick={handleGoogleSignIn}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          width: 300,
          height: 50,
          borderRadius: 12,
          border: `1.5px solid ${BORDER}`,
          backgroundColor: SURFACE,
          cursor: 'pointer',
          fontSize: 16,
          fontWeight: 600,
          color: ON_SURFACE,
        }}
      >
        <svg width="20" height="20" viewBox="0 0 48 48">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
          <path fill="#FBBC05" d="M10.53 28.59a14.5 14.5 0 0 1 0-9.18l-7.98-6.19a24.01 24.01 0 0 0 0 21.56l7.98-6.19z"/>
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
        </svg>
        Continue with Google
      </button>
    </div>
  );
}
