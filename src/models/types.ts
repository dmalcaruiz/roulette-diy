// ── WheelItem ────────────────────────────────────────────────────────────

export interface WheelItem {
  text: string;
  color: string; // hex color like '#FF0000'
  weight: number;
  imagePath?: string | null;
  iconName?: string | null;
}

// ── WheelConfig ──────────────────────────────────────────────────────────

export interface WheelConfig {
  id: string;
  name: string;
  items: WheelItem[];
  textSize: number;
  headerTextSize: number;
  imageSize: number;
  cornerRadius: number;
  imageCornerRadius: number;
  strokeWidth: number;
  showBackgroundCircle: boolean;
  centerMarkerSize: number;
  innerCornerStyle: 'none' | 'rounded' | 'circular' | 'straight';
  centerInset: number;
  segmentsMode?: 'simple' | 'complex';
}

export function defaultWheelConfig(overrides?: Partial<WheelConfig>): WheelConfig {
  return {
    id: Date.now().toString(),
    name: 'New Wheel',
    items: [],
    textSize: 1.0,
    headerTextSize: 1.0,
    imageSize: 60,
    cornerRadius: 8,
    imageCornerRadius: 8,
    strokeWidth: 3,
    showBackgroundCircle: true,
    centerMarkerSize: 200,
    innerCornerStyle: 'none',
    centerInset: 50,
    segmentsMode: 'simple',
    ...overrides,
  };
}

// ── Block types ──────────────────────────────────────────────────────────

export type BlockType = 'roulette' | 'listRandomizer' | 'experience';

export interface ListCategory {
  name: string;
  options: string[];
}

export interface ListRandomizerConfig {
  categories: ListCategory[];
}

export interface ExperienceStep {
  blockId: string;
  conditionSegment?: string | null;
}

export interface ExperienceConfig {
  steps: ExperienceStep[];
  description?: string | null;
  coverImagePath?: string | null;
}

export interface Block {
  id: string;
  name: string;
  type: BlockType;
  createdAt: string; // ISO string
  lastUsedAt: string;
  wheelConfig?: WheelConfig | null;
  listConfig?: ListRandomizerConfig | null;
  experienceConfig?: ExperienceConfig | null;
  // Set on Roulette/List blocks that are steps of an Experience flow.
  // Points at the Experience block that contains them. Unset for
  // stand-alone blocks.
  parentExperienceId?: string | null;
}

// ── Block helpers ────────────────────────────────────────────────────────

export function newRouletteBlock(): Block {
  const id = Date.now().toString();
  return {
    id,
    name: 'New Roulette',
    type: 'roulette',
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    wheelConfig: {
      id,
      name: 'New Roulette',
      items: [
        { text: 'Option 1', color: '#322d2a', weight: 1 },
        { text: 'Option 2', color: '#fb2d29', weight: 1 },
      ],
      textSize: 1,
      headerTextSize: 1,
      imageSize: 60,
      cornerRadius: 8,
      imageCornerRadius: 8,
      strokeWidth: 3,
      showBackgroundCircle: true,
      centerMarkerSize: 200,
      innerCornerStyle: 'none',
      centerInset: 50,
    },
  };
}

export function newListRandomizerBlock(): Block {
  const id = Date.now().toString();
  return {
    id,
    name: 'New List',
    type: 'listRandomizer',
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    listConfig: {
      categories: [
        { name: 'Category 1', options: ['Option A', 'Option B', 'Option C'] },
        { name: 'Category 2', options: ['Option X', 'Option Y', 'Option Z'] },
      ],
    },
  };
}

export function newExperienceBlock(): Block {
  const id = Date.now().toString();
  return {
    id,
    name: 'New Experience',
    type: 'experience',
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    experienceConfig: { steps: [] },
  };
}

export function getBlockTypeLabel(type: BlockType): string {
  switch (type) {
    case 'roulette': return 'Roulette';
    case 'listRandomizer': return 'List';
    case 'experience': return 'Experience';
  }
}

export function getBlockItemCount(block: Block): number {
  switch (block.type) {
    case 'roulette': return block.wheelConfig?.items.length ?? 0;
    case 'listRandomizer': return block.listConfig?.categories.length ?? 0;
    case 'experience': return block.experienceConfig?.steps.length ?? 0;
  }
}

export function getBlockItemCountLabel(block: Block): string {
  switch (block.type) {
    case 'roulette': return `${getBlockItemCount(block)} segments`;
    case 'listRandomizer': return `${getBlockItemCount(block)} categories`;
    case 'experience': return `${getBlockItemCount(block)} steps`;
  }
}
