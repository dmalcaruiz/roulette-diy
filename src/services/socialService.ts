import {
  doc, getDoc, runTransaction, increment, serverTimestamp, collection, getDocs, query, orderBy, limit,
} from 'firebase/firestore';
import { db } from '../firebase';

// ── Likes ───────────────────────────────────────────────────────────────

export async function isWheelLiked(uid: string, wheelId: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'users', uid, 'liked_wheels', wheelId));
  return snap.exists();
}

export async function likeWheel(uid: string, wheelId: string): Promise<void> {
  const likeRef = doc(db, 'users', uid, 'liked_wheels', wheelId);
  const wheelRef = doc(db, 'wheels', wheelId);
  await runTransaction(db, async (tx) => {
    const existing = await tx.get(likeRef);
    if (existing.exists()) return;
    tx.set(likeRef, { likedAt: serverTimestamp() });
    tx.update(wheelRef, { likesCount: increment(1) });
  });
}

export async function unlikeWheel(uid: string, wheelId: string): Promise<void> {
  const likeRef = doc(db, 'users', uid, 'liked_wheels', wheelId);
  const wheelRef = doc(db, 'wheels', wheelId);
  await runTransaction(db, async (tx) => {
    const existing = await tx.get(likeRef);
    if (!existing.exists()) return;
    tx.delete(likeRef);
    tx.update(wheelRef, { likesCount: increment(-1) });
  });
}

// ── Response likes (same shape, different collection) ───────────────────

export async function isResponseLiked(uid: string, responseId: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'users', uid, 'liked_responses', responseId));
  return snap.exists();
}

export async function likeResponse(uid: string, responseId: string, wheelId: string): Promise<void> {
  const likeRef = doc(db, 'users', uid, 'liked_responses', responseId);
  const respRef = doc(db, 'wheels', wheelId, 'responses', responseId);
  await runTransaction(db, async (tx) => {
    const existing = await tx.get(likeRef);
    if (existing.exists()) return;
    tx.set(likeRef, { likedAt: serverTimestamp(), wheelId });
    tx.update(respRef, { likesCount: increment(1) });
  });
}

export async function unlikeResponse(uid: string, responseId: string, wheelId: string): Promise<void> {
  const likeRef = doc(db, 'users', uid, 'liked_responses', responseId);
  const respRef = doc(db, 'wheels', wheelId, 'responses', responseId);
  await runTransaction(db, async (tx) => {
    const existing = await tx.get(likeRef);
    if (!existing.exists()) return;
    tx.delete(likeRef);
    tx.update(respRef, { likesCount: increment(-1) });
  });
}

// ── Save to library ─────────────────────────────────────────────────────

export async function isWheelSaved(uid: string, wheelId: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'users', uid, 'library', wheelId));
  return snap.exists();
}

export async function saveWheel(uid: string, wheelId: string): Promise<void> {
  const saveRef = doc(db, 'users', uid, 'library', wheelId);
  const wheelRef = doc(db, 'wheels', wheelId);
  await runTransaction(db, async (tx) => {
    const existing = await tx.get(saveRef);
    if (existing.exists()) return;
    tx.set(saveRef, { savedAt: serverTimestamp() });
    tx.update(wheelRef, { savesCount: increment(1) });
  });
}

export async function unsaveWheel(uid: string, wheelId: string): Promise<void> {
  const saveRef = doc(db, 'users', uid, 'library', wheelId);
  const wheelRef = doc(db, 'wheels', wheelId);
  await runTransaction(db, async (tx) => {
    const existing = await tx.get(saveRef);
    if (!existing.exists()) return;
    tx.delete(saveRef);
    tx.update(wheelRef, { savesCount: increment(-1) });
  });
}

// ── Follow ──────────────────────────────────────────────────────────────

export async function isFollowing(uid: string, targetUid: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'users', uid, 'following', targetUid));
  return snap.exists();
}

export async function followUser(uid: string, targetUid: string): Promise<void> {
  if (uid === targetUid) throw new Error("Can't follow yourself.");
  const followRef = doc(db, 'users', uid, 'following', targetUid);
  const meRef = doc(db, 'users', uid);
  const targetRef = doc(db, 'users', targetUid);
  await runTransaction(db, async (tx) => {
    const existing = await tx.get(followRef);
    if (existing.exists()) return;
    tx.set(followRef, { followedAt: serverTimestamp() });
    tx.update(meRef, { followingCount: increment(1) });
    tx.update(targetRef, { followersCount: increment(1) });
  });
}

export async function unfollowUser(uid: string, targetUid: string): Promise<void> {
  const followRef = doc(db, 'users', uid, 'following', targetUid);
  const meRef = doc(db, 'users', uid);
  const targetRef = doc(db, 'users', targetUid);
  await runTransaction(db, async (tx) => {
    const existing = await tx.get(followRef);
    if (!existing.exists()) return;
    tx.delete(followRef);
    tx.update(meRef, { followingCount: increment(-1) });
    tx.update(targetRef, { followersCount: increment(-1) });
  });
}

// ── User's library (saved wheels) ───────────────────────────────────────

export async function listSavedWheelIds(uid: string, max = 100): Promise<string[]> {
  const q = query(
    collection(db, 'users', uid, 'library'),
    orderBy('savedAt', 'desc'),
    limit(max),
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => d.id);
}
