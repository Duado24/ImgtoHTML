import { describe, expect, it } from "vitest";
import { learnedUsernames, sanitizeLines } from "../src/core/privacy";

describe("privacy", () => {
  it("masks Windows, Linux and macOS home folders", () => {
    const { lines } = sanitizeLines([
      "C:\\Users\\jsmith\\Desktop> python app.py",
      "jsmith@laptop:/home/jsmith/code$ ls",
      "/Users/Jane.Doe/Documents",
    ]);
    expect(lines).toEqual([
      "C:\\Users\\username\\Desktop> python app.py",
      "username@laptop:/home/username/code$ ls",
      "/Users/username/Documents",
    ]);
  });

  it("learns names from paths and masks them in email-style identities", () => {
    const { lines, names } = sanitizeLines(["cd /home/duado24", "git config user.email duado24@example.edu"]);
    expect(names).toEqual(new Set(["duado24"]));
    expect(lines[1]).toBe("git config user.email username@example.edu");
  });

  it("doesn't mask a name inside a longer word", () => {
    const { lines } = sanitizeLines(["/home/ann", "joann@example.com ann@example.com"]);
    expect(lines[1]).toBe("joann@example.com username@example.com");
  });

  it("already-masked paths are not learned as names", () => {
    expect(learnedUsernames(["/home/username/x", "/home/./y"])).toEqual(new Set());
  });
});
