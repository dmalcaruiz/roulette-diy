import {
  collection, doc, setDoc, deleteDoc, getDoc, runTransaction,
  serverTimestamp, increment,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { Block } from '../models/types';
import type { UserProfile } from '../types/profile';
import type { PublishedWheel } from '../types/wheel';
import { saveDraft, getDraft } from './blockService';

interface PublishArgs {
  author: UserProfile;
  draft: Block;
  isChallenge?: boolean;
  challengePrompt?: string | null;
  coverUrl?: string | null;
}

// Publish draft → wheels/{newId}. Stamps author snapshot + resets counters.
// Updates draft with publishedWheelId backpointer.
export async function publishWheel(args: PublishArgs): Promise<string> {
  const { author, draft } = args;
  if (draft.type !== 'roulette') {
    throw new Error('Only roulette blocks can be published in v1.');
  }
  const newRef = doc(collection(db, 'wheels'));
  const now = new Date().toISOString();

  const payload: PublishedWheel = {
    id: newRef.id,
    sourceDraftId: draft.id,

    authorId: author.uid,
    authorHandle: author.handle,
    authorDisplayName: author.displayName,
    authorPhotoUrl: author.photoUrl ?? null,

    name: draft.name,
    type: draft.type,
    wheelConfig: draft.wheelConfig ?? null,

    isChallenge: !!args.isChallenge,
    challengePrompt: args.challengePrompt ?? null,

    coverUrl: args.coverUrl ?? null,

    likesCount: 0,
    commentsCount: 0,
    responsesCount: 0,
    savesCount: 0,

    createdAt: now,
    updatedAt: now,
  };

  await runTransaction(db, async (tx) => {
    tx.set(newRef, { ...payload, createdAtServer: serverTimestamp(), updatedAtServer: serverTimestamp() });
    tx.update(doc(db, 'users', author.uid), { wheelsCount: increment(1) });
  });

  await saveDraft(author.uid, { ...draft, publishedWheelId: newRef.id });
  return newRef.id;
}

// Push updated draft fields to an already-published wheel.
export async function syncPublishedWheel(args: {
  uid: string;
  wheelId: string;
}): Promise<void> {
  const draft = (await getLatestDraft(args.uid, args.wheelId));
  if (!draft) throw new Error('Draft not found for this published wheel.');

  const now = new Date().toISOString();
  await setDoc(doc(db, 'wheels', args.wheelId), {
    name: draft.name,
    wheelConfig: draft.wheelConfig ?? null,
    updatedAt: now,
    updatedAtServer: serverTimestamp(),
  }, { merge: true });
}

// Unpublish: remove wheels/{id}, clear backpointer on draft.
export async function unpublishWheel(args: { uid: string; wheelId: string }): Promise<void> {
  const wheelRef = doc(db, 'wheels', args.wheelId);
  const snap = await getDoc(wheelRef);
  if (!snap.exists()) return;
  const { sourceDraftId } = snap.data() as PublishedWheel;

  await runTransaction(db, async (tx) => {
    tx.delete(wheelRef);
    tx.update(doc(db, 'users', args.uid), { wheelsCount: increment(-1) });
  });

  const draft = await getDraft(args.uid, sourceDraftId);
  if (draft) {
    await saveDraft(args.uid, { ...draft, publishedWheelId: null });
  }
}

// Find which draft backs a given published wheel (reverse lookup helper).
async function getLatestDraft(uid: string, wheelId: string) {
  const wheelSnap = await getDoc(doc(db, 'wheels', wheelId));
  if (!wheelSnap.exists()) return null;
  const { sourceDraftId } = wheelSnap.data() as PublishedWheel;
  return getDraft(uid, sourceDraftId);
}
