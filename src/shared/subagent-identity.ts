const identities = [
  ['🌸', 'Flower'],
  ['🦊', 'Fox'],
  ['🌙', 'Moon'],
  ['🔥', 'Flame'],
  ['🍄', 'Mushroom'],
  ['🐙', 'Octopus'],
  ['⭐', 'Star'],
  ['🌊', 'Wave'],
  ['🦉', 'Owl'],
  ['🍋', 'Lemon'],
] as const;

/** A friendly, stable display identity for a subagent's position in a task. */
export function subagentIdentity(index: number): string {
  const [emoji, name] = identities[index % identities.length];
  return `${emoji} Subagent ${name}`;
}
