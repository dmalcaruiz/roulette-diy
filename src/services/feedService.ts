import {
  collection, doc, getDoc, getDocs, query, orderBy, limit, startAfter, where,
  type QueryDocumentSnapshot, type DocumentData,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { PublishedWheel, WheelCard } from '../types/wheel';

const PAGE_SIZE = 20;

export interface PageCursor {
  last?: QueryDocumentSnapshot<DocumentData>;
  done: boolean;
}

function toCard(w: PublishedWheel): WheelCard {
  return {
    id: w.id,
    name: w.name,
    type: w.type,
    coverUrl: w.coverUrl ?? null,
    isChallenge: w.isChallenge,
    likesCount: w.likesCount,
    commentsCount: w.commentsCount,
    responsesCount: w.responsesCount,
    savesCount: w.savesCount,
    authorId: w.authorId,
    authorHandle: w.authorHandle,
    authorDisplayName: w.authorDisplayName,
    authorPhotoUrl: w.authorPhotoUrl ?? null,
    createdAt: w.createdAt,
  };
}

// ── Global chronological feed ───────────────────────────────────────────
export async function fetchFeedPage(cursor?: PageCursor): Promise<{
  items: WheelCard[]; cursor: PageCursor;
}> {
  if (cursor?.done) return { items: [], cursor };
  const base = collection(db, 'wheels');
  const q = cursor?.last
    ? query(base, orderBy('createdAt', 'desc'), startAfter(cursor.last), limit(PAGE_SIZE))
    : query(base, orderBy('createdAt', 'desc'), limit(PAGE_SIZE));
  const snap = await getDocs(q);
  const items = snap.docs.map(d => toCard(d.data() as PublishedWheel));
  return {
    items,
    cursor: {
      last: snap.docs[snap.docs.length - 1],
      done: snap.docs.length < PAGE_SIZE,
    },
  };
}

// ── Challenges-only feed ────────────────────────────────────────────────
export async function fetchChallengesPage(cursor?: PageCursor): Promise<{
  items: WheelCard[]; cursor: PageCursor;
}> {
  if (cursor?.done) return { items: [], cursor };
  const base = collection(db, 'wheels');
  const q = cursor?.last
    ? query(base, where('isChallenge', '==', true), orderBy('createdAt', 'desc'), startAfter(cursor.last), limit(PAGE_SIZE))
    : query(base, where('isChallenge', '==', true), orderBy('createdAt', 'desc'), limit(PAGE_SIZE));
  const snap = await getDocs(q);
  return {
    items: snap.docs.map(d => toCard(d.data() as PublishedWheel)),
    cursor: {
      last: snap.docs[snap.docs.length - 1],
      done: snap.docs.length < PAGE_SIZE,
    },
  };
}

// ── Single wheel ────────────────────────────────────────────────────────
export async function fetchWheel(wheelId: string): Promise<PublishedWheel | null> {
  const snap = await getDoc(doc(db, 'wheels', wheelId));
  return snap.exists() ? (snap.data() as PublishedWheel) : null;
}

// ── By author handle ────────────────────────────────────────────────────
export async function fetchWheelsByAuthor(authorId: string): Promise<WheelCard[]> {
  const q = query(
    collection(db, 'wheels'),
    where('authorId', '==', authorId),
    orderBy('createdAt', 'desc'),
    limit(50),
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => toCard(d.data() as PublishedWheel));
}
