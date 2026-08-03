// #241: pure @mention parser for chat messages. DB/React-free so it stays
// unit-testable (mirrors discussDraft.ts's pure-builder pattern). No
// autocomplete UI for v1 — this only runs at send time against the CURRENT
// conversation participants, matching "@<display name>" (case-insensitive).
//
// Longest-name-first: participants are tried longest-name-first at each '@'
// so a mention of "John Smith" isn't mistakenly captured as a shorter "John"
// mention (leaving " Smith" as ordinary trailing text) when both are
// participants. A trailing word-boundary check additionally prevents a short
// name from matching inside a longer unrelated word ("@Johnny" must not match
// participant "John").
export interface MentionCandidate {
  id: string;
  name: string;
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_]/.test(ch);
}

// Returns the (deduped) participant ids mentioned in `text`, in order of
// first appearance. The sender is always excluded (can't @mention yourself
// into a mute-bypass push) — pass their id as `senderId`.
export function parseMentions(
  text: string,
  participants: MentionCandidate[],
  senderId?: string | null,
): string[] {
  const candidates = participants
    .filter(p => p.id !== senderId && p.name && p.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);

  const found: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@') continue;
    if (isWordChar(text[i - 1])) continue; // '@' mid-word (e.g. an email) — skip

    let matchLen = 0;
    let matchedId: string | null = null;
    for (const c of candidates) {
      const name = c.name;
      const end = i + 1 + name.length;
      if (end > text.length) continue;
      if (text.slice(i + 1, end).toLowerCase() !== name.toLowerCase()) continue;
      if (isWordChar(text[end])) continue; // e.g. "John" inside "@Johnny"
      matchLen = name.length;
      matchedId = c.id;
      break; // candidates are longest-first — first hit is the longest match
    }

    if (matchedId) {
      if (!seen.has(matchedId)) {
        seen.add(matchedId);
        found.push(matchedId);
      }
      i += matchLen; // skip past the matched name (loop's i++ advances past '@')
    }
  }

  return found;
}
