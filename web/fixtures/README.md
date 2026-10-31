# Test set

Real course screenshots with their AI reports and correct text, to measure how
well the AI instructions (or the ChatGPT plugin) read screenshots. Everything
here except this README stays on your computer: screenshots can show names,
hosts or tokens.

```text
fixtures/
  batch-5/   pi-dialog.png          the screenshot (kept for reference; not read)
             pi-dialog.report.json  the AI's report, saved as it replied
             pi-dialog.txt          the exact correct text: same lines, same indentation
```

```bash
npm run eval                  # score every report that has a .txt next to it
npm run eval -- --only pi     # just files whose name contains "pi"
npm run eval -- --allow-empty # no reports (fresh checkout, CI): report SKIPPED, not fail
```

Each report is scored by its whole text, or by the region that best matches
the `.txt` (which may cover only the code): character errors and lines read
right, both ignoring how many spaces there are. Reports that fail the format
check are listed with their problems.
