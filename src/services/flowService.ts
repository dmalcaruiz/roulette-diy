import { Block, WheelConfig, newRouletteBlock } from '../models/types';
import { saveDraft, deleteDraft, getDraft, type CloudBlock } from './blockService';
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

// ── Insert / duplicate / remove helpers ──────────────────────────────────

// Describes a mutation to a flow that may require deletions as well as writes.
export interface FlowChange {
  // Updated Experience doc (null if the flow was fully dissolved).
  experience: CloudBlock | null;
  // Blocks to save (upserts): updated experience + any new/stamped wheels.
  writes: CloudBlock[];
  // Block ids to delete from Firestore.
  deletes: string[];
  // Convenience: the resulting in-memory flowSteps array (ordered).
  nextSteps: CloudBlock[];
  // For insert/duplicate, the id of the newly created step (if any).
  newStepId?: string;
}

// Insert a new empty wheel at the given index within a flow. If the flow
// doesn't exist yet (standalone wheel), wraps the current wheel and the new
// wheel into a fresh Experience. `index` is relative to the resulting steps
// array (0 = first, steps.length = last).
export function buildInsertWheelChange(args: {
  currentBlock: CloudBlock;
  experience?: CloudBlock;
  steps?: CloudBlock[];
  index: number;
}): FlowChange {
  const { currentBlock, experience, steps, index } = args;
  const newBlock = newRoulette();

  // Standalone wheel — wrap it (similar to append) but allow positional insert.
  if (!currentBlock.parentExperienceId || !experience) {
    const ordered = index <= 0 ? [newBlock.id, currentBlock.id] : [currentBlock.id, newBlock.id];
    const newExp = newExperienceBlockWithSteps(ordered);
    const stampedCurrent: CloudBlock = { ...currentBlock, parentExperienceId: newExp.id };
    const stampedNew: CloudBlock = { ...newBlock, parentExperienceId: newExp.id };
    const nextSteps = ordered.map(id => id === currentBlock.id ? stampedCurrent : stampedNew);
    return {
      experience: newExp,
      writes: [stampedCurrent, stampedNew, newExp],
      deletes: [],
      nextSteps,
      newStepId: stampedNew.id,
    };
  }

  // Existing flow — insert into the steps array at the requested index.
  if (experience.type !== 'experience' || !experience.experienceConfig) {
    throw new Error('Parent experience is malformed.');
  }
  const stampedNew: CloudBlock = { ...newBlock, parentExperienceId: experience.id };
  const existingSteps = experience.experienceConfig.steps;
  const clamped = Math.max(0, Math.min(index, existingSteps.length));
  const nextStepEntries = [
    ...existingSteps.slice(0, clamped),
    { blockId: stampedNew.id },
    ...existingSteps.slice(clamped),
  ];
  const updatedExperience: CloudBlock = {
    ...experience,
    experienceConfig: { ...experience.experienceConfig, steps: nextStepEntries },
  };
  const prev = steps ?? [];
  const nextSteps = [
    ...prev.slice(0, clamped),
    stampedNew,
    ...prev.slice(clamped),
  ];
  return {
    experience: updatedExperience,
    writes: [stampedNew, updatedExperience],
    deletes: [],
    nextSteps,
    newStepId: stampedNew.id,
  };
}

// Duplicate the wheel at `index` within a flow, cloning its wheelConfig, and
// inserting the clone immediately after the source.
export function buildDuplicateWheelChange(args: {
  experience: CloudBlock;
  steps: CloudBlock[];
  index: number;
}): FlowChange {
  const { experience, steps, index } = args;
  if (experience.type !== 'experience' || !experience.experienceConfig) {
    throw new Error('Parent experience is malformed.');
  }
  const source = steps[index];
  if (!source) throw new Error('Source wheel not found at index.');

  const newId = uniqueId();
  const now = new Date().toISOString();
  const clone: CloudBlock = {
    ...source,
    id: newId,
    parentExperienceId: experience.id,
    createdAt: now,
    lastUsedAt: now,
    publishedWheelId: null,
    wheelConfig: source.wheelConfig
      ? { ...source.wheelConfig, id: newId, name: source.wheelConfig.name }
      : source.wheelConfig,
  };

  const insertAt = index + 1;
  const existingSteps = experience.experienceConfig.steps;
  const nextStepEntries = [
    ...existingSteps.slice(0, insertAt),
    { blockId: clone.id },
    ...existingSteps.slice(insertAt),
  ];
  const updatedExperience: CloudBlock = {
    ...experience,
    experienceConfig: { ...experience.experienceConfig, steps: nextStepEntries },
  };
  const nextSteps = [
    ...steps.slice(0, insertAt),
    clone,
    ...steps.slice(insertAt),
  ];
  return {
    experience: updatedExperience,
    writes: [clone, updatedExperience],
    deletes: [],
    nextSteps,
    newStepId: clone.id,
  };
}

// Remove the wheel at `index` from a flow. The wheel block is deleted from
// Firestore. If removing the last step, the Experience is also deleted.
export function buildRemoveWheelChange(args: {
  experience: CloudBlock;
  steps: CloudBlock[];
  index: number;
}): FlowChange {
  const { experience, steps, index } = args;
  if (experience.type !== 'experience' || !experience.experienceConfig) {
    throw new Error('Parent experience is malformed.');
  }
  const target = steps[index];
  if (!target) throw new Error('Target wheel not found at index.');

  const remainingSteps = steps.filter((_, i) => i !== index);
  if (remainingSteps.length === 0) {
    // Flow becomes empty — tear it down.
    return {
      experience: null,
      writes: [],
      deletes: [target.id, experience.id],
      nextSteps: [],
    };
  }

  const nextStepEntries = experience.experienceConfig.steps.filter(s => s.blockId !== target.id);
  const updatedExperience: CloudBlock = {
    ...experience,
    experienceConfig: { ...experience.experienceConfig, steps: nextStepEntries },
  };
  return {
    experience: updatedExperience,
    writes: [updatedExperience],
    deletes: [target.id],
    nextSteps: remainingSteps,
  };
}

// Persist a FlowChange: upsert writes + delete removed ids.
export async function persistFlowChange(uid: string, change: FlowChange): Promise<void> {
  await Promise.all([
    ...change.writes.map(b => saveDraft(uid, b)),
    ...change.deletes.map(id => deleteDraft(uid, id)),
  ]);
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
