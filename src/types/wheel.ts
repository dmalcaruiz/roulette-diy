import type { WheelConfig, BlockType } from '../models/types';

// Denormalized author snapshot embedded on every public doc.
// Cheap to read (no extra fetch) and stays correct even if the user renames
// (we backfill on rename or accept staleness — your call).
export interface AuthorSnapshot {
  authorId: string;
  authorHandle: string;
  authorDisplayName: string;
  authorPhotoUrl?: string | null;
}

export interface PublishedWheel extends AuthorSnapshot {
  id: string;                     // wheels/{id}
  sourceDraftId: string;          // users/{uid}/drafts/{sourceDraftId}
  name: string;
  type: BlockType;
  wheelConfig?: WheelConfig | null;
  // (listConfig/experienceConfig omitted for now — challenges are roulette-only in v1)

  isChallenge: boolean;
  challengePrompt?: string | null;

  coverUrl?: string | null;       // R2 URL (wheel-cover purpose)

  likesCount: number;
  commentsCount: number;
  responsesCount: number;
  savesCount: number;

  createdAt: string;              // ISO
  updatedAt: string;              // ISO
}

// Lightweight card shape for feeds — what we render in lists.
export type WheelCard = Pick<
  PublishedWheel,
  'id' | 'name' | 'type' | 'coverUrl' | 'isChallenge'
  | 'likesCount' | 'commentsCount' | 'responsesCount' | 'savesCount'
  | 'authorId' | 'authorHandle' | 'authorDisplayName' | 'authorPhotoUrl'
  | 'createdAt'
>;
