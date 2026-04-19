import { Block, WheelConfig, newRouletteBlock } from '../models/types';
import { saveDraft, getDraft, type CloudBlock } from './blockService';
import { dbg, sid, sids } from '../utils/debugLog';

function uniqueId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newExperienceBlockWithSteps(stepBlockIds: string[]): CloudBlock {
  const id = uniqueId();
  const now = new Date().toISOString();
  return {
    id,
    name: 'New Flow',
    type: 'experience',
    createdAt: now,
    lastUsedAt: now,
    experienceConfig: {
      steps: stepBlockIds.map(blockId => ({ blockId })),
    },
  };
}

function newRoulette(): CloudBlock {
  const base = newRouletteBlock();
  const id = uniqueId();
  return {
    ...base,
    id,
    wheelConfig: base.wheelConfig ? { ...base.wheelConfig, id } : base.wheelConfig,
  };
}

export interface AppendWheelChange {
  newBlock: CloudBlock;
  // All docs that must be written to Firestore to persist this change.
  writes: CloudBlock[];
  // The Experience block for the flow (new or updated).
  experience: CloudBlock;
}

// Synchronous — builds all the objects needed to append a new wheel to a flow.
// Caller must pass the already-loaded experience if `currentBlock` is already
// part of one (lookup via `currentBlock.parentExperienceId`). For first `+`
// press, pass `experience: undefined` and a fresh Experience will be created.
export function buildAppendWheelChange(args: {
  currentBlock: CloudBlock;
  experience?: CloudBlock;
}): AppendWheelChange {
  const { currentBlock, experience } = args;
  const newBlock = newRoulette();
  dbg('flowService', 'buildAppendWheelChange:enter', {
    currentBlock: sid(currentBlock.id),
    parentExperienceId: sid(currentBlock.parentExperienceId ?? null),
    passedExperience: sid(experience?.id ?? null),
    newBlockId: sid(newBlock.id),
  });

  // Case 1: appending to an existing flow
  if (currentBlock.parentExperienceId) {
    if (!experience) {
      throw new Error('Experience must be passed when appending to an existing flow.');
    }
    if (experience.type !== 'experience' || !experience.experienceConfig) {
      throw new Error('Parent experience is malformed.');
    }
    const updatedExperience: CloudBlock = {
      ...experience,
      experienceConfig: {
        ...experience.experienceConfig,
        steps: [
          ...experience.experienceConfig.steps,
          { blockId: newBlock.id },
        ],
      },
    };
    const stampedNewBlock: CloudBlock = {
      ...newBlock,
      parentExperienceId: experience.id,
    };
    dbg('flowService', 'buildAppendWheelChange:appendExisting', {
      experience: sid(experience.id),
      newSteps: sids(updatedExperience.experienceConfig!.steps.map(s => ({ id: s.blockId }))),
    });
    return {
      newBlock: stampedNewBlock,
      experience: updatedExperience,
      writes: [stampedNewBlock, updatedExperience],
    };
  }

  // Case 2: first `+` on a stand-alone Roulette — wrap it.
  const newExperience = newExperienceBlockWithSteps([currentBlock.id, newBlock.id]);
  const stampedCurrent: CloudBlock = { ...currentBlock, parentExperienceId: newExperience.id };
  const stampedNewBlock: CloudBlock = { ...newBlock, parentExperienceId: newExperience.id };
  dbg('flowService', 'buildAppendWheelChange:wrap', {
    newExperience: sid(newExperience.id),
    stampedCurrent: sid(stampedCurrent.id),
    newBlock: sid(stampedNewBlock.id),
  });
  return {
    newBlock: stampedNewBlock,
    experience: newExperience,
    writes: [stampedCurrent, stampedNewBlock, newExperience],
  };
}

// Async — persists the writes from a build step. Returns on full success;
// rejects on first failure. Callers wanting optimistic UI should fire this
// without awaiting and handle rollback in `.catch`.
export async function persistBlocks(uid: string, blocks: CloudBlock[]): Promise<void> {
  dbg('flowService', 'persistBlocks:enter', { count: blocks.length, ids: sids(blocks) });
  try {
    await Promise.all(blocks.map(b => saveDraft(uid, b)));
    dbg('flowService', 'persistBlocks:ok', { count: blocks.length });
  } catch (e) {
    dbg('flowService', 'persistBlocks:fail', { err: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

// Convenience — does the full build + persist. Use when optimism isn't needed.
export async function appendWheelToFlow(args: {
  uid: string;
  currentBlock: CloudBlock;
}): Promise<{ experience: CloudBlock; newBlock: CloudBlock }> {
  let experience: CloudBlock | undefined;
  if (args.currentBlock.parentExperienceId) {
    const loaded = await getDraft(args.uid, args.currentBlock.parentExperienceId);
    if (!loaded) throw new Error('Parent experience not found.');
    experience = loaded;
  }
  const change = buildAppendWheelChange({ currentBlock: args.currentBlock, experience });
  await persistBlocks(args.uid, change.writes);
  return { experience: change.experience, newBlock: change.newBlock };
}

// Load every step block for an Experience in order.
// Returns null for any step whose referenced block is missing.
export async function loadFlowStepBlocks(args: {
  uid: string;
  experience: CloudBlock;
}): Promise<(CloudBlock | null)[]> {
  const steps = args.experience.experienceConfig?.steps ?? [];
  return Promise.all(
    steps.map(step => getDraft(args.uid, step.blockId))
  );
}

export type { WheelConfig };
