import { addDoc, collection, increment, doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { db, auth } from '../firebase';
import type { ExperiencePlayResult } from '../types/experience';

// Records the outcome of a single Experience play. Anyone (including
// anonymous users) can submit one — that's the whole point. Increments the
// playsCount on the parent published_experience.
//
// For drafts (private play / OBS for owner), we don't have a published doc,
// so we fall back to a localStorage log — the data is still there if the
// owner publishes later and wants to see what their stream picked.
export async function recordPlayResult(args: {
  experienceId: string; // either published_experiences/{id} or a local draft id
  isPublished: boolean;
  experienceName: string;
  steps: { stepBlockId: string; resultText: string }[];
}): Promise<void> {
  const { experienceId, isPublished, steps } = args;
  const now = new Date().toISOString();

  if (!isPublished) {
    logExperienceResult({
      experienceId,
      experienceName: args.experienceName,
      steps,
    });
    return;
  }

  const playerUid = auth.currentUser?.uid ?? null;
  const payload: Omit<ExperiencePlayResult, 'id'> = {
    experienceId,
    steps,
    playerUid,
    createdAt: now,
  };

  try {
    await addDoc(collection(db, 'published_experiences', experienceId, 'results'), {
      ...payload,
      createdAtServer: serverTimestamp(),
    });
    await updateDoc(doc(db, 'published_experiences', experienceId), {
      playsCount: increment(1),
    });
  } catch (e) {
    console.error('recordPlayResult failed, falling back to local log:', e);
    logExperienceResult({
      experienceId,
      experienceName: args.experienceName,
      steps,
    });
  }
}

// Local-storage fallback / draft log. Useful for owner-only OBS play before
// publishing, and as a last-resort if Firestore writes fail.
const LOCAL_KEY = 'experience_play_results';

interface LocalPlayResult {
  experienceId: string;
  experienceName: string;
  steps: { stepBlockId: string; resultText: string }[];
  createdAt: string;
}

export function logExperienceResult(entry: Omit<LocalPlayResult, 'createdAt'>): void {
  try {
    const existing = readLocalResults();
    existing.push({ ...entry, createdAt: new Date().toISOString() });
    // Keep the log bounded — last 500 plays per browser is plenty for a
    // creator's local-only history.
    const trimmed = existing.slice(-500);
    localStorage.setItem(LOCAL_KEY, JSON.stringify(trimmed));
  } catch (e) {
    console.error('logExperienceResult failed:', e);
  }
}

export function readLocalResults(): LocalPlayResult[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
