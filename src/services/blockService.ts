import {
  collection, doc, getDoc, getDocs, setDoc, deleteDoc, serverTimestamp,
  query, orderBy, writeBatch,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { Block } from '../models/types';
import { loadBlocks as loadLocalBlocks, saveBlocks as saveLocalBlocks } from '../models/blockManager';

// Extends Block with cloud bookkeeping. Kept optional so local code still works.
export interface CloudBlockMeta {
  updatedAt?: string;               // ISO, last edit
  publishedWheelId?: string | null; // wheels/{id} this draft is published as
  order?: number;                   // sort index in user's library
}

export type CloudBlock = Block & CloudBlockMeta;

function draftsCol(uid: string) {
  return collection(db, 'users', uid, 'drafts');
}
function draftDoc(uid: string, id: string) {
  return doc(db, 'users', uid, 'drafts', id);
}

// ── Reads ───────────────────────────────────────────────────────────────

export async function loadDrafts(uid: string): Promise<CloudBlock[]> {
  const snap = await getDocs(query(draftsCol(uid), orderBy('order', 'asc')));
  return snap.docs.map(d => d.data() as CloudBlock);
}

export async function getDraft(uid: string, id: string): Promise<CloudBlock | null> {
  const snap = await getDoc(draftDoc(uid, id));
  return snap.exists() ? (snap.data() as CloudBlock) : null;
}

// ── Writes ──────────────────────────────────────────────────────────────

export async function saveDraft(uid: string, block: CloudBlock): Promise<void> {
  const ref = draftDoc(uid, block.id);
  const now = new Date().toISOString();
  // Preserve order if present; else give it a trailing order number
  const existing = await getDoc(ref);
  const order = existing.exists()
    ? (existing.data() as CloudBlock).order ?? Date.now()
    : Date.now();
  await setDoc(ref, {
    ...stripUndefined(block),
    updatedAt: now,
    updatedAtServer: serverTimestamp(),
    order: block.order ?? order,
  }, { merge: true });
}

export async function deleteDraft(uid: string, id: string): Promise<void> {
  await deleteDoc(draftDoc(uid, id));
}

export async function saveDraftOrder(uid: string, ids: string[]): Promise<void> {
  const batch = writeBatch(db);
  ids.forEach((id, i) => batch.set(draftDoc(uid, id), { order: i }, { merge: true }));
  await batch.commit();
}

// ── One-time localStorage → cloud migration ─────────────────────────────
// Runs on first sign-in only: if the cloud side is empty and localStorage
// has blocks, copy them up. Idempotent via the `saved_blocks_migrated_{uid}` flag.

const MIG_KEY = (uid: string) => `saved_blocks_migrated_${uid}`;

export async function migrateLocalBlocksIfNeeded(uid: string): Promise<{ migrated: number }> {
  if (localStorage.getItem(MIG_KEY(uid))) return { migrated: 0 };

  const local = loadLocalBlocks();
  if (local.length === 0) {
    localStorage.setItem(MIG_KEY(uid), new Date().toISOString());
    return { migrated: 0 };
  }

  // Only migrate if the cloud side is empty — refuse to overwrite.
  const cloud = await loadDrafts(uid);
  if (cloud.length > 0) {
    localStorage.setItem(MIG_KEY(uid), new Date().toISOString());
    return { migrated: 0 };
  }

  const batch = writeBatch(db);
  const now = new Date().toISOString();
  local.forEach((block, i) => {
    batch.set(draftDoc(uid, block.id), {
      ...stripUndefined(block),
      updatedAt: now,
      order: i,
    });
  });
  await batch.commit();

  localStorage.setItem(MIG_KEY(uid), now);
  return { migrated: local.length };
}

// ── Cross-uid draft rescue ──────────────────────────────────────────────
// Merge a set of drafts into a user's collection WITHOUT clobbering drafts
// that already live there. Used when an anonymous device signs into an
// EXISTING Google account: signInWithCredential abandons the anon uid, so the
// wheels created on that device would be orphaned. We read them while still
// authed as the anon user, then call this once switched to the real account.
// Drafts whose id already exists on the target are left untouched (the real
// account's data wins); genuinely new ones are appended after the current
// max order. Returns how many were added.
export async function mergeDraftsInto(uid: string, drafts: CloudBlock[]): Promise<number> {
  if (drafts.length === 0) return 0;
  const existing = await loadDrafts(uid);
  const existingIds = new Set(existing.map(d => d.id));
  const toAdd = drafts.filter(d => !existingIds.has(d.id));
  if (toAdd.length === 0) return 0;

  let nextOrder = existing.reduce((m, d) => Math.max(m, d.order ?? 0), 0) + 1;
  const batch = writeBatch(db);
  const now = new Date().toISOString();
  for (const d of toAdd) {
    batch.set(draftDoc(uid, d.id), {
      ...stripUndefined(d),
      updatedAt: d.updatedAt ?? now,
      order: nextOrder++,
    }, { merge: true });
  }
  await batch.commit();
  return toAdd.length;
}

// Preserve a backup of localStorage blocks after migration — users can still
// view them signed-out, but the cloud is now the source of truth when signed-in.
export function clearLocalBlocksCache(): void {
  saveLocalBlocks([]);
}

function stripUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}
