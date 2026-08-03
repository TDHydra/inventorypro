// #228: pure draft-text builder for the "Discuss this" entity-linked chat
// entry. Produces the composer prefill ("Re job #123 · Kitchen fire: ") that
// rides the #203 draft param into (chat)/[id].tsx. DB/React-free for node tests.

export type DiscussKind = 'job' | 'repair' | 'equipment';

export function buildDiscussDraft(input: {
  kind: DiscussKind;
  label: string;
  ref: string | null;
}): string {
  const label = input.label.trim();
  let stem = `Re ${input.kind}`;
  if (input.ref) stem += ` ${input.ref}`;
  if (label) stem += ` · ${label}`;
  return `${stem}: `;
}
