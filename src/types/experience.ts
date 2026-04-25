import type { Block, ExperienceStep } from '../models/types';
import type { AuthorSnapshot } from './wheel';

// Public, denormalized snapshot of an Experience flow. Single document holds
// the Experience config + every step block inlined, so the play URL can read
// one doc and render the whole flow without further fetches.
//
// Why a separate collection (vs. extending wheels/): published_experiences
// have a fundamentally different shape — they bundle multiple blocks in one
// doc — and the play URL pattern (/e/:id/play) is its own surface.
//
// Public read, author-only write — matches the existing wheels/ rules.
export interface PublishedExperience extends AuthorSnapshot {
  id: string;                  // published_experiences/{id}
  sourceDraftId: string;       // users/{uid}/drafts/{sourceDraftId}

  name: string;
  description?: string | null;
  coverUrl?: string | null;

  // Carry-overs from the original wheels/ flow so existing Feed surfaces work
  // unchanged when we eventually unify them. Optional — most Experiences won't
  // be challenges.
  isChallenge?: boolean;
  challengePrompt?: string | null;

  // Flow definition.
  steps: ExperienceStep[];     // ordered, refs by stepBlocks[].id
  stepBlocks: PublishedStepBlock[]; // inlined snapshot of each step's source

  // Stats.
  playsCount: number;          // increments on each play
  likesCount: number;
  commentsCount: number;
  responsesCount?: number;     // only meaningful for challenges
  savesCount: number;

  createdAt: string;           // ISO
  updatedAt: string;           // ISO
}

// A snapshot of the source roulette/list block at publish time. Future edits
// to the user's draft do NOT propagate automatically — they must republish.
// This keeps published Experiences stable for embeds/OBS.
export type PublishedStepBlock =
  | { type: 'roulette';       id: string; name: string; wheelConfig: NonNullable<Block['wheelConfig']> }
  | { type: 'listRandomizer'; id: string; name: string; listConfig:  NonNullable<Block['listConfig']> };

// A single play-completion record. Anonymous users can write these too
// (publishing a result is part of the audience-engagement loop, not a creator
// action), so the rule is permissive.
export interface ExperiencePlayResult {
  id: string;                  // published_experiences/{expId}/results/{id}
  experienceId: string;
  // Each step's result text in order.
  steps: { stepBlockId: string; resultText: string }[];
  // Optional viewer attribution. Anonymous users still write a uid (their
  // anonymous Firebase uid), so we get rough deduplication without forcing
  // sign-in.
  playerUid?: string | null;
  createdAt: string;           // ISO
}
