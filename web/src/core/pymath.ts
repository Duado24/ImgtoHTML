/** Small helpers that copy Python's number rules, so spacing and colors
 *  come out the same as in the Python version (v1.2.6). */

/** Python's round(): halves go to the even neighbour (2.5 → 2, 3.5 → 4). */
export function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python's % for floats: the result has the sign of the divisor. */
export function pyMod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** Middle item of an already sorted list (Python: xs[len(xs) // 2]). */
export function middle(sorted: readonly number[]): number {
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error("middle() of an empty list");
  return value;
}

/** Python's str.isalnum() for non-empty strings. */
export function isAlnum(text: string): boolean {
  return /^[\p{L}\p{N}]+$/u.test(text);
}

/** Python's len() on a string: counts code points, not UTF-16 units. */
export function pyLen(text: string): number {
  return [...text].length;
}
