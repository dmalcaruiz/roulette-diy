import {
  doc, getDoc, setDoc, runTransaction, serverTimestamp, deleteDoc,
} from 'firebase/firestore';
import { db } from '../firebase';
import { type UserProfile, normalizeHandle, isValidHandle } from '../types/profile';

// ── Reads ───────────────────────────────────────────────────────────────

export async function getProfile(uid: string): Promise<UserProfile | null> {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? (snap.data() as UserProfile) : null;
}

export async function getProfileByHandle(handle: string): Promise<UserProfile | null> {
  const h = normalizeHandle(handle);
  const handleSnap = await getDoc(doc(db, 'handles', h));
  if (!handleSnap.exists()) return null;
  const { uid } = handleSnap.data() as { uid: string };
  return getProfile(uid);
}

export async function isHandleAvailable(handle: string): Promise<boolean> {
  const h = normalizeHandle(handle);
  if (!isValidHandle(h)) return false;
  const snap = await getDoc(doc(db, 'handles', h));
  return !snap.exists();
}

// ── Writes ──────────────────────────────────────────────────────────────

// Claim a handle + create the profile in one atomic transaction.
// Used on first sign-in (Profile Setup flow).
export async function createProfile(args: {
  uid: string;
  displayName: string;
  handle: string;
  bio?: string;
  photoUrl?: string;
}): Promise<void> {
  const handle = normalizeHandle(args.handle);
  if (!isValidHandle(handle)) {
    throw new Error('Handle must be 3–20 chars: a–z, 0–9, _');
  }

  const userRef = doc(db, 'users', args.uid);
  const handleRef = doc(db, 'handles', handle);

  await runTransaction(db, async (tx) => {
    const existing = await tx.get(handleRef);
    if (existing.exists()) throw new Error('Handle already taken');

    const profile: UserProfile = {
      uid: args.uid,
      displayName: args.displayName.trim(),
      handle,
      bio: args.bio?.trim() || undefined,
      photoUrl: args.photoUrl || undefined,
      createdAt: new Date().toISOString(),
      followersCount: 0,
      followingCount: 0,
      wheelsCount: 0,
    };

    tx.set(userRef, { ...profile, createdAtServer: serverTimestamp() });
    tx.set(handleRef, { uid: args.uid });
  });
}

// Update profile fields. If the handle changes, move the index atomically.
export async function updateProfile(args: {
  uid: string;
  displayName?: string;
  handle?: string;
  bio?: string;
  photoUrl?: string;
}): Promise<void> {
  const userRef = doc(db, 'users', args.uid);

  if (args.handle === undefined) {
    await setDoc(userRef, cleanUpdates(args), { merge: true });
    return;
  }

  const newHandle = normalizeHandle(args.handle);
  if (!isValidHandle(newHandle)) throw new Error('Handle must be 3–20 chars: a–z, 0–9, _');

  await runTransaction(db, async (tx) => {
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists()) throw new Error('Profile not found');
    const oldHandle = (userSnap.data() as UserProfile).handle;

    if (newHandle === oldHandle) {
      tx.set(userRef, cleanUpdates(args), { merge: true });
      return;
    }

    const newHandleRef = doc(db, 'handles', newHandle);
    const newHandleSnap = await tx.get(newHandleRef);
    if (newHandleSnap.exists()) throw new Error('Handle already taken');

    tx.delete(doc(db, 'handles', oldHandle));
    tx.set(newHandleRef, { uid: args.uid });
    tx.set(userRef, { ...cleanUpdates(args), handle: newHandle }, { merge: true });
  });
}

function cleanUpdates<T extends Record<string, unknown>>(args: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'uid' || k === 'handle') continue;
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// Dev helper — not exposed in UI.
export async function releaseHandle(handle: string): Promise<void> {
  await deleteDoc(doc(db, 'handles', normalizeHandle(handle)));
}
