type CutOffLine = { text: string };

/** The visible cutoff marker is an annotation, not a character read by OCR.
 * Only remove a marker from a complete line recorded by the renderer. All
 * other ellipses and all changes to the observed text remain scored. */
export function withoutCutOffAnnotations(text: string, cutOff: readonly CutOffLine[] = []): string {
  const annotated = new Set(cutOff.filter(({ text }) => !/(?:…|\.{3})$/.test(text.trimEnd())).map(({ text }) => `${text.trim()}…`));
  return text.split("\n").map((line) => annotated.has(line.trim()) ? line.replace(/…(\s*)$/, "$1") : line).join("\n");
}

/** Support just the observed last token with its added annotation. This
 * cannot whitelist a completion or another newly generated word. */
export function cutOffTokens(cutOff: readonly CutOffLine[] = []): string[] {
  return cutOff.filter(({ text }) => !/(?:…|\.{3})$/.test(text.trimEnd()))
    .flatMap(({ text }) => text.match(/\S+(?=\s*$)/)?.map((token) => `${token}…`) ?? []);
}
