/** Mask user names in home-folder paths and email-style identities.
 *  Pattern-based and incomplete: manual privacy review is still required. */

const HOME_PATHS: readonly RegExp[] = [
  /([A-Z]:\\Users\\)([^\\\s/>:]+)/giu,
  /(\/home\/)([^/\s]+)/giu,
  /(\/Users\/)([^/\s]+)/giu,
];

const NOT_NAMES = new Set(["username", ".", ".."]);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** User names found in home-folder paths anywhere in the text. */
export function learnedUsernames(lines: readonly string[]): Set<string> {
  const text = lines.join("\n");
  const names = new Set<string>();

  for (const pattern of HOME_PATHS) {
    for (const match of text.matchAll(pattern)) {
      const name = match[2]!;
      if (!NOT_NAMES.has(name.toLowerCase())) names.add(name);
    }
  }
  return names;
}

export function sanitizeText(text: string, names: ReadonlySet<string>): string {
  for (const pattern of HOME_PATHS) {
    text = text.replace(pattern, (_, prefix: string) => prefix + "username");
  }

  const longestFirst = [...names].sort((a, b) => b.length - a.length);
  for (const name of longestFirst) {
    const email = new RegExp(`(?<![\\p{L}\\p{N}_.+-])${escapeRegExp(name)}(?=@[\\p{L}\\p{N}_.-]+)`, "giu");
    text = text.replace(email, "username");
  }
  return text;
}

export function sanitizeLines(lines: readonly string[]): { lines: string[]; names: Set<string> } {
  const names = learnedUsernames(lines);
  return { lines: lines.map((line) => sanitizeText(line, names)), names };
}
