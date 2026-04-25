import {
  collection, doc, getDoc, setDoc, deleteDoc,
  serverTimestamp, runTransaction, increment,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { Block } from '../models/types';
import type { UserProfile } from '../types/profile';
import type { PublishedExperience, PublishedStepBlock } from '../types/experience';
import { saveDraft, getDraft } from './blockService';

// Build the inlined step-block snapshot array from an Experience's draft +
// the per-step roulette/list drafts. Skips any missing or invalid steps so a
// half-finished flow doesn't break publish.
async function snapshotStepBlocks(uid: string, experience: Block): Promise<PublishedStepBlock[]> {
  const steps = experience.experienceConfig?.steps ?? [];
  const blocks: PublishedStepBlock[] = [];
  for (const step of steps) {
    const src = await getDraft(uid, step.blockId);
    if (!src) continue;
    if (src.type === 'roulette' && src.wheelConfig) {
      blocks.push({ type: 'roulette', id: src.id, name: src.name, wheelConfig: src.wheelConfig });
    } else if (src.type === 'listRandomizer' && src.listConfig) {
      blocks.push({ type: 'listRandomizer', id: src.id, name: src.name, listConfig: src.listConfig });
    }
  }
  return blocks;
}

interface PublishExperienceArgs {
  author: UserProfile;
  draft: Block; // experience-type draft. Or any block — we wrap non-experience drafts in a one-step flow.
  description?: string | null;
  coverUrl?: string | null;
  isChallenge?: boolean;
  challengePrompt?: string | null;
}

// Snapshots an Experience (or a single roulette/list block wrapped as a
// one-step Experience) into a publicly-readable document. Returns the new
// published id.
export async function publishExperience(args: PublishExperienceArgs): Promise<string> {
  const { author, draft } = args;
  const newRef = doc(collection(db, 'published_experiences'));
  const now = new Date().toISOString();

  // If the draft isn't already an Experience, wrap it as a one-step flow.
  // This keeps the published surface uniform: every public play URL is an
  // Experience, even if it was authored as "just a roulette."
  let experienceDraft: Block;
  if (draft.type === 'experience') {
    experienceDraft = draft;
  } else {
    experienceDraft = {
      ...draft,
      type: 'experience',
      experienceConfig: { steps: [{ blockId: draft.id }] },
    };
  }

  const stepBlocks = await snapshotStepBlocks(author.uid, experienceDraft);
  if (stepBlocks.length === 0 && draft.type !== 'experience') {
    // Wrapped a single roulette/list — inline it directly so we always have
    // at least one step even if the source draft pointer is stale.
    if (draft.type === 'roulette' && draft.wheelConfig) {
      stepBlocks.push({ type: 'roulette', id: draft.id, name: draft.name, wheelConfig: draft.wheelConfig });
    } else if (draft.type === 'listRandomizer' && draft.listConfig) {
      stepBlocks.push({ type: 'listRandomizer', id: draft.id, name: draft.name, listConfig: draft.listConfig });
    }
  }
  if (stepBlocks.length === 0) {
    throw new Error('Cannot publish an empty Experience.');
  }

  const payload: PublishedExperience = {
    id: newRef.id,
    sourceDraftId: draft.id,

    authorId: author.uid,
    authorHandle: author.handle,
    authorDisplayName: author.displayName,
    authorPhotoUrl: author.photoUrl ?? null,

    name: draft.name,
    description: args.description ?? draft.experienceConfig?.description ?? null,
    coverUrl: args.coverUrl ?? draft.experienceConfig?.coverImagePath ?? null,

    isChallenge: !!args.isChallenge,
    challengePrompt: args.challengePrompt ?? null,

    steps: experienceDraft.experienceConfig?.steps ?? [{ blockId: draft.id }],
    stepBlocks,

    playsCount: 0,
    likesCount: 0,
    commentsCount: 0,
    responsesCount: 0,
    savesCount: 0,

    createdAt: now,
    updatedAt: now,
  };

  await runTransaction(db, async (tx) => {
    tx.set(newRef, {
      ...payload,
      createdAtServer: serverTimestamp(),
      updatedAtServer: serverTimestamp(),
    });
    tx.update(doc(db, 'users', author.uid), { wheelsCount: increment(1) });
  });

  // Backpoint the source draft at the published doc so the editor can show
  // "Already published" UI.
  await saveDraft(author.uid, { ...draft, publishedWheelId: newRef.id });

  return newRef.id;
}

// Public read — no auth required.
export async function getPublishedExperience(id: string): Promise<PublishedExperience | null> {
  const snap = await getDoc(doc(db, 'published_experiences', id));
  return snap.exists() ? (snap.data() as PublishedExperience) : null;
}

// Re-snapshot the source draft over an already-published Experience. Keeps
// the same id (so existing /e/{id}/play URLs stay valid) and preserves the
// stats counters (likesCount/playsCount/etc.) — only the editable fields
// (name, steps, stepBlocks, description, cover) are overwritten.
//
// The author of the published doc must match the calling user; rules
// enforce this on the server side.
export async function syncPublishedExperience(args: {
  uid: string;
  experienceId: string;
}): Promise<void> {
  const ref = doc(db, 'published_experiences', args.experienceId);
  const existing = await getDoc(ref);
  if (!existing.exists()) throw new Error('Published Experience not found.');
  const published = existing.data() as PublishedExperience;
  if (published.authorId !== args.uid) {
    throw new Error('Only the author can re-sync this Experience.');
  }

  const draft = await getDraft(args.uid, published.sourceDraftId);
  if (!draft) throw new Error('Source draft was deleted — unpublish and start over.');

  // Re-build the inlined step snapshot from the latest draft state. Same
  // wrapping rule as publishExperience: a non-Experience draft becomes a
  // one-step flow.
  let experienceDraft: Block;
  if (draft.type === 'experience') {
    experienceDraft = draft;
  } else {
    experienceDraft = {
      ...draft,
      type: 'experience',
      experienceConfig: { steps: [{ blockId: draft.id }] },
    };
  }

  const stepBlocks = await snapshotStepBlocks(args.uid, experienceDraft);
  if (stepBlocks.length === 0 && draft.type !== 'experience') {
    if (draft.type === 'roulette' && draft.wheelConfig) {
      stepBlocks.push({ type: 'roulette', id: draft.id, name: draft.name, wheelConfig: draft.wheelConfig });
    } else if (draft.type === 'listRandomizer' && draft.listConfig) {
      stepBlocks.push({ type: 'listRandomizer', id: draft.id, name: draft.name, listConfig: draft.listConfig });
    }
  }
  if (stepBlocks.length === 0) {
    throw new Error('Cannot re-sync an empty Experience.');
  }

  const now = new Date().toISOString();
  await setDoc(ref, {
    name: draft.name,
    description: draft.experienceConfig?.description ?? null,
    coverUrl: draft.experienceConfig?.coverImagePath ?? published.coverUrl ?? null,
    steps: experienceDraft.experienceConfig?.steps ?? [{ blockId: draft.id }],
    stepBlocks,
    updatedAt: now,
    updatedAtServer: serverTimestamp(),
  }, { merge: true });
}

// Author-only delete.
export async function unpublishExperience(args: { uid: string; experienceId: string }): Promise<void> {
  const ref = doc(db, 'published_experiences', args.experienceId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const { sourceDraftId } = snap.data() as PublishedExperience;

  await runTransaction(db, async (tx) => {
    tx.delete(ref);
    tx.update(doc(db, 'users', args.uid), { wheelsCount: increment(-1) });
  });

  const draft = await getDraft(args.uid, sourceDraftId);
  if (draft) {
    await saveDraft(args.uid, { ...draft, publishedWheelId: null });
  }
}
