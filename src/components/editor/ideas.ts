// Themed "idea" starter sets (à la Spinly): tap to fill the wheel with a fun,
// ready-made set of slices + a matching title. The Ideas button picks one at
// random so each tap feels fresh.
export interface WheelIdea {
  emoji: string;
  title: string;
  options: string[];
}

export const WHEEL_IDEAS: WheelIdea[] = [
  { emoji: '🍕', title: "What's for dinner?", options: ['Pizza', 'Tacos', 'Sushi', 'Burgers', 'Pasta', 'Thai'] },
  { emoji: '🎯', title: 'Truth or Dare', options: ['Truth', 'Dare', 'Truth', 'Dare', 'Wild card', 'Free pass'] },
  { emoji: '💸', title: 'Who pays?', options: ['Me', 'You', 'Split it', 'Loser pays', 'Flip again'] },
  { emoji: '🪙', title: 'Should I?', options: ['Yes', 'No', 'Definitely', 'No way', 'Ask later'] },
  { emoji: '🎬', title: 'Movie night', options: ['Action', 'Comedy', 'Horror', 'Romance', 'Anime', 'Doc'] },
  { emoji: '🎉', title: 'Party dare', options: ['Sing it', 'Dance', 'Best impression', 'Tell a secret', 'Swap seats', 'Free pass'] },
  { emoji: '🎮', title: 'What to play?', options: ['Fortnite', 'Minecraft', 'Valorant', 'Just Chatting', 'Retro', 'Viewer pick'] },
  { emoji: '🔥', title: 'Stream dare', options: ['Funny accent', 'No swearing', 'Sing the intro', 'Webcam zoom', 'Read chat dramatically', 'Free pass'] },
  { emoji: '🍀', title: 'Make the call', options: ['Do it', 'Skip it', 'Chat decides', 'Coin flip', 'Maybe later'] },
];

// A random idea, avoiding `exclude` so consecutive taps don't repeat.
export function randomIdea(exclude?: WheelIdea | null): WheelIdea {
  if (WHEEL_IDEAS.length <= 1) return WHEEL_IDEAS[0];
  let idea: WheelIdea;
  do {
    idea = WHEEL_IDEAS[Math.floor(Math.random() * WHEEL_IDEAS.length)];
  } while (idea === exclude);
  return idea;
}

// Fun wheel names for the title's "surprise" button.
export const WHEEL_TITLES: string[] = [
  'Wheel of Fate', 'The Decider', 'Spin to Win', 'Chaos Wheel', 'Lucky Spin',
  'Destiny Spinner', 'Fortune Wheel', 'The Randomizer', 'Wheel of Maybe',
  'Spin Doctor', "Fate's Call", 'The Picker', 'Wheel of Chaos', 'Round & Round', 'Spinmaster',
];

export function randomTitle(exclude?: string | null): string {
  if (WHEEL_TITLES.length <= 1) return WHEEL_TITLES[0];
  let t: string;
  do {
    t = WHEEL_TITLES[Math.floor(Math.random() * WHEEL_TITLES.length)];
  } while (t === exclude);
  return t;
}
