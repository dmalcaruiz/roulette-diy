import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  onAuthStateChanged,
  signInAnonymously,
  signOut as fbSignOut,
  linkWithPopup,
  signInWithPopup,
  type User,
} from 'firebase/auth';
import { auth, googleProvider } from '../firebase';
import { getProfile } from '../services/profileService';
import type { UserProfile } from '../types/profile';

interface AuthState {
  user: User | null;         // Firebase user (uid, email, displayName, photoURL)
  profile: UserProfile | null; // App profile doc (null while loading or not yet created)
  authLoading: boolean;      // true until first onAuthStateChanged fires
  profileLoading: boolean;   // true while fetching profile doc after sign-in
  isAnonymous: boolean;      // true while user hasn't linked a real account
  anonymousAuthBlocked: boolean; // true if signInAnonymously was rejected (provider disabled, etc.)
  refreshProfile: () => Promise<void>;
  signInWithGoogle: () => Promise<void>; // links the current anon user OR fresh popup sign-in
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [anonymousAuthBlocked, setAnonymousAuthBlocked] = useState(false);
  // Guard against double-firing signInAnonymously across re-renders / strict-mode.
  const anonSigningInRef = useRef(false);

  const refreshProfile = async () => {
    if (!user || user.isAnonymous) { setProfile(null); return; }
    setProfileLoading(true);
    try {
      setProfile(await getProfile(user.uid));
    } finally {
      setProfileLoading(false);
    }
  };

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      // Render the app immediately on the first auth event, regardless of
      // whether `u` is null or a user. Blocking on signInAnonymously's HTTP
      // round-trip before first paint made initial loads feel multi-second
      // slow — Firebase Identity Toolkit can take 300–800ms on a cold load.
      // Instead we set the user (or null) right away, free the gating, and
      // sign in anonymously in the background; a second onAuthStateChanged
      // tick will populate the user once it resolves.
      setUser(u);
      setAuthLoading(false);

      // Anonymous-first: if Firebase has no user, kick off sign-in in the
      // background. Drafts/blocks key on uid; once the user later links a
      // Google account via linkWithPopup the same uid is kept, so no
      // migration is needed for their own data.
      if (!u) {
        if (anonSigningInRef.current) return;
        anonSigningInRef.current = true;
        // Fire-and-forget — we do NOT await this. The user sees the app
        // shell instantly while the request races in the background.
        signInAnonymously(auth)
          .then(() => setAnonymousAuthBlocked(false))
          .catch((e: any) => {
            console.error('Anonymous sign-in failed:', e);
            // Most common cause: anonymous provider disabled in Firebase
            // console (auth/admin-restricted-operation /
            // auth/operation-not-allowed). Surface a flag so the app can
            // show a Google-only sign-in fallback instead of waiting forever.
            setAnonymousAuthBlocked(true);
          })
          .finally(() => { anonSigningInRef.current = false; });
        setProfile(null);
        return;
      }

      // Anonymous users have no profile doc — skip the fetch entirely.
      if (u.isAnonymous) {
        setProfile(null);
        return;
      }

      setProfileLoading(true);
      try {
        setProfile(await getProfile(u.uid));
      } catch (e) {
        console.error('Failed to load profile:', e);
        setProfile(null);
      } finally {
        setProfileLoading(false);
      }
    });
  }, []);

  const signInWithGoogle = async () => {
    // If we have an anonymous user, prefer linking — keeps the same uid so
    // their drafts and Experiences come with them. Falls back to a regular
    // popup sign-in if linking fails (e.g. credential already in use).
    const current = auth.currentUser;
    if (current?.isAnonymous) {
      try {
        await linkWithPopup(current, googleProvider);
        return;
      } catch (e: any) {
        if (e?.code === 'auth/credential-already-in-use') {
          // Another account already exists for this Google identity. Sign in
          // to it directly; the anon uid is abandoned (data not migrated yet
          // — that's a follow-up).
          await signInWithPopup(auth, googleProvider);
          return;
        }
        if (e?.code === 'auth/popup-closed-by-user') return;
        throw e;
      }
    }
    await signInWithPopup(auth, googleProvider);
  };

  const signOut = async () => {
    await fbSignOut(auth);
    // onAuthStateChanged will fire with null and the effect will sign in
    // anonymously again, keeping the app usable.
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        authLoading,
        profileLoading,
        isAnonymous: !!user?.isAnonymous,
        anonymousAuthBlocked,
        refreshProfile,
        signInWithGoogle,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
