// Map of icon names to lucide-react icon component names
// Used for wheel segment icons

export const LUCIDE_ICON_NAMES = [
  'heart', 'star', 'sun', 'moon', 'cloud', 'zap', 'flame', 'droplets',
  'snowflake', 'wind', 'music', 'headphones', 'camera', 'film', 'tv',
  'gamepad-2', 'trophy', 'medal', 'crown', 'gem', 'gift', 'cake',
  'pizza', 'coffee', 'beer', 'apple', 'cherry', 'leaf', 'flower-2',
  'trees', 'dog', 'cat', 'fish', 'bird', 'bug', 'rocket', 'plane',
  'car', 'bike', 'ship', 'home', 'building-2', 'landmark', 'mountain',
  'compass', 'map', 'globe', 'flag', 'target', 'crosshair', 'shield',
  'swords', 'wand-2', 'sparkles', 'palette', 'brush', 'pencil', 'book',
  'graduation-cap', 'lightbulb',
] as const;

export type LucideIconName = typeof LUCIDE_ICON_NAMES[number];
