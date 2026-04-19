import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';

export type ReportTargetKind = 'wheel' | 'response' | 'comment' | 'user';
export type ReportReason =
  | 'nsfw' | 'harassment' | 'spam' | 'off-topic' | 'copyright' | 'other';

export async function submitReport(args: {
  reporterId: string;
  targetKind: ReportTargetKind;
  targetId: string;
  parentWheelId?: string | null; // for comments/responses — where they live
  reason: ReportReason;
  note?: string;
}): Promise<string> {
  const ref = await addDoc(collection(db, 'reports'), {
    reporterId: args.reporterId,
    targetKind: args.targetKind,
    targetId: args.targetId,
    parentWheelId: args.parentWheelId ?? null,
    reason: args.reason,
    note: args.note?.slice(0, 500) ?? null,
    status: 'open',
    createdAt: new Date().toISOString(),
    createdAtServer: serverTimestamp(),
  });
  return ref.id;
}
