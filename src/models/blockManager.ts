import { Block } from './types';

const BLOCKS_KEY = 'saved_blocks';
const ORDER_KEY = 'block_order';

export function loadBlocks(): Block[] {
  try {
    const raw = localStorage.getItem(BLOCKS_KEY);
    if (!raw) return [];
    const blocks: Block[] = JSON.parse(raw);

    const order = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]') as string[];
    if (order.length > 0) {
      blocks.sort((a, b) => {
        const ia = order.indexOf(a.id);
        const ib = order.indexOf(b.id);
        if (ia === -1 && ib === -1) return 0;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });
    }

    return blocks;
  } catch {
    return [];
  }
}

export function saveBlocks(blocks: Block[]): void {
  localStorage.setItem(BLOCKS_KEY, JSON.stringify(blocks));
}

export function saveBlock(block: Block): void {
  const blocks = loadBlocks();
  const idx = blocks.findIndex(b => b.id === block.id);
  if (idx >= 0) {
    blocks[idx] = block;
  } else {
    blocks.push(block);
  }
  saveBlocks(blocks);
}

export function deleteBlock(id: string): void {
  const blocks = loadBlocks();
  saveBlocks(blocks.filter(b => b.id !== id));
}

export function saveOrder(blockIds: string[]): void {
  localStorage.setItem(ORDER_KEY, JSON.stringify(blockIds));
}
