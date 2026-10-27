# Test set

Real course screenshots, used to measure each converter change.

```text
fixtures/
  terminal/   ls-output.png   ls-output.txt   (ls-output.json)
  code/       ...
  diagram/    ...
  interface/  ...
  baseline.json   saved scores to compare against
```

- **Folder** = screenshot type. Names `ide` and `ui` also work (as `code` and `interface`).
- **`<name>.txt`** (optional) = the exact correct text: same lines, same
  indentation. Without it, the screenshot still gets a Canvas check but no text score.
- **`<name>.json`** (optional) = `{ "kind": "code", "label": "..." }` to override the folder.

```bash
npm run eval                    # score everything, compare with baseline.json
npm run eval -- --save-baseline # make the current scores the new baseline
npm run eval -- --only ls       # just files whose name contains "ls"
```

Results go to `eval-results/` (not committed): `latest.json` plus one
comparison page per screenshot in `eval-results/preview/`.

Screenshots and their `.txt`/`.json` are **not committed** by default, as
they may show names, hosts or tokens. Remove the rules in `.gitignore` here
to commit them.
