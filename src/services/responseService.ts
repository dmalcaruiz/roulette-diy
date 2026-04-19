import {
  collection, doc, getDocs, query, orderBy, limit, startAfter,
  runTransaction, increment, serverTimestamp,
  type QueryDocumentSnapshot, type DocumentData,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { UserProfile } from '../types/profile';
import type { ChallengeResponse } from '../types/response';
import { uploadImage } from './uploadService';

const PAGE = 20;

export interface ResponseCursor {
  last?: QueryDocumentSnapshot<DocumentData>;
  done: boolean;
}

export async function fetchResponses(wheelId: string, cursor?: ResponseCursor): Promise<{
  items: ChallengeResponse[]; cursor: ResponseCursor;
}> {
  if (cursor?.done) return { items: [], cursor };
  const base = collection(db, 'wheels', wheelId, 'responses');
  const q = cursor?.last
    ? query(base, orderBy('createdAt', 'desc'), startAfter(cursor.last), limit(PAGE))
    : query(base, orderBy('createdAt', 'desc'), limit(PAGE));
  const snap = await getDocs(q);
  return {
    items: snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<ChallengeResponse, 'id'>) })),
    cursor: {
      last: snap.docs[snap.docs.length - 1],
      done: snap.docs.length < PAGE,
    },
  };
}

// Full challenge response flow:
// 1. Reserve a response doc ID (needed so the Function's key scheme has a responseId)
// 2. Upload image to R2 via presigned URL (validated server-side: 5MB, image/*, etc.)
// 3. Write the response doc + bump parent wheel's responsesCount
export async function submitChallengeResponse(args: {
  wheelId: string;
  author: UserProfile;
  image: File | Blob;
  caption?: string;
  resultSegmentIndex: number;
  resultSegmentText: string;
}): Promise<string> {
  const responseRef = doc(collection(db, 'wheels', args.wheelId, 'responses'));
  const responseId = responseRef.id;

  const imageUrl = await uploadImage({
    purpose: 'response',
    source: args.image,
    responseId,
  });

  const payload: Omit<ChallengeResponse, 'id'> = {
    wheelId: args.wheelId,
    authorId: args.author.uid,
    authorHandle: args.author.handle,
    authorDisplayName: args.author.displayName,
    authorPhotoUrl: args.author.photoUrl ?? null,
    imageUrl,
    caption: args.caption?.trim() || null,
    resultSegmentIndex: args.resultSegmentIndex,
    resultSegmentText: args.resultSegmentText,
    likesCount: 0,
    commentsCount: 0,
    createdAt: new Date().toISOString(),
  };

  await runTransaction(db, async (tx) => {
    tx.set(responseRef, { ...payload, createdAtServer: serverTimestamp() });
    tx.update(doc(db, 'wheels', args.wheelId), { responsesCount: increment(1) });
  });

  return responseId;
}

export async function deleteResponse(args: { wheelId: string; responseId: string }): Promise<void> {
  const ref = doc(db, 'wheels', args.wheelId, 'responses', args.responseId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    tx.delete(ref);
    tx.update(doc(db, 'wheels', args.wheelId), { responsesCount: increment(-1) });
  });
  // Note: R2 image is not auto-deleted here. A Firebase Function triggered on
  // response doc deletion should clean up the R2 key. Phase 12 (moderation) wires this up.
}

