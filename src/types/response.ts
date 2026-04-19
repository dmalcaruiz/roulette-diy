import type { AuthorSnapshot } from './wheel';

// A user's photo response to a challenge wheel spin.
export interface ChallengeResponse extends AuthorSnapshot {
  id: string;                     // responses/{id}
  wheelId: string;                // parent wheel
  imageUrl: string;               // R2 URL
  caption?: string | null;
  resultSegmentIndex: number;     // 0-based index of the wheel segment they landed on
  resultSegmentText: string;      // snapshot of segment text at time of spin
  likesCount: number;
  commentsCount: number;
  createdAt: string;              // ISO
}
