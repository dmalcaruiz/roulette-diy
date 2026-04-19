import {
  collection, doc, getDocs, query, orderBy, limit, startAfter,
  serverTimestamp, increment, runTransaction,
  type QueryDocumentSnapshot, type DocumentData,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { UserProfile } from '../types/profile';
import type { Comment } from '../types/comment';

const PAGE = 30;

type Target =
  | { kind: 'wheel'; wheelId: string }
  | { kind: 'response'; wheelId: string; responseId: string };

function commentsCol(target: Target) {
  return target.kind === 'wheel'
    ? collection(db, 'wheels', target.wheelId, 'comments')
    : collection(db, 'wheels', target.wheelId, 'responses', target.responseId, 'comments');
}

function parentDoc(target: Target) {
  return target.kind === 'wheel'
    ? doc(db, 'wheels', target.wheelId)
    : doc(db, 'wheels', target.wheelId, 'responses', target.responseId);
}

export interface CommentCursor {
  last?: QueryDocumentSnapshot<DocumentData>;
  done: boolean;
}

export async function fetchComments(target: Target, cursor?: CommentCursor): Promise<{
  items: Comment[]; cursor: CommentCursor;
}> {
  if (cursor?.done) return { items: [], cursor };
  const base = commentsCol(target);
  const q = cursor?.last
    ? query(base, orderBy('createdAt', 'desc'), startAfter(cursor.last), limit(PAGE))
    : query(base, orderBy('createdAt', 'desc'), limit(PAGE));
  const snap = await getDocs(q);
  return {
    items: snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<Comment, 'id'>) })),
    cursor: {
      last: snap.docs[snap.docs.length - 1],
      done: snap.docs.length < PAGE,
    },
  };
}

export async function postComment(args: {
  target: Target;
  author: UserProfile;
  text: string;
}): Promise<string> {
  const text = args.text.trim();
  if (!text) throw new Error('Comment is empty.');
  if (text.length > 1000) throw new Error('Comment too long (max 1000 chars).');

  const colRef = commentsCol(args.target);
  const newRef = doc(colRef);

  await runTransaction(db, async (tx) => {
    tx.set(newRef, {
      authorId: args.author.uid,
      authorHandle: args.author.handle,
      authorDisplayName: args.author.displayName,
      authorPhotoUrl: args.author.photoUrl ?? null,
      text,
      createdAt: new Date().toISOString(),
      createdAtServer: serverTimestamp(),
      likesCount: 0,
    });
    tx.update(parentDoc(args.target), { commentsCount: increment(1) });
  });

  return newRef.id;
}

export async function deleteComment(args: { target: Target; commentId: string }): Promise<void> {
  const ref = doc(commentsCol(args.target), args.commentId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    tx.delete(ref);
    tx.update(parentDoc(args.target), { commentsCount: increment(-1) });
  });
}

