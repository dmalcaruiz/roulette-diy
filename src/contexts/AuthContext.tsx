import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { onAuthStateChanged, signOut as fbSignOut, type User } from 'firebase/auth';
import { auth } from '../firebase';
import { getProfile } from '../services/profileService';
import type { UserProfile } from '../types/profile';

interface AuthState {
  user: User | null;         // Firebase user (uid, email, displayName, photoURL)
  profile: UserProfile | null; // App profile doc (null while loading or not yet created)
  authLoading: boolean;      // true until first onAuthStateChanged fires
  profileLoading: boolean;   // true while fetching profile doc after sign-in
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);

  const refreshProfile = async () => {
    if (!user) { setProfile(null); return; }
    setProfileLoading(true);
    try {
      setProfile(await getProfile(user.uid));
    } finally {
      setProfileLoading(false);
    }
  };

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setAuthLoading(false);
      if (!u) {
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

  const signOut = async () => {
    await fbSignOut(auth);
  };

  return (
    <AuthContext.Provider value={{ user, profile, authLoading, profileLoading, refreshProfile, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
