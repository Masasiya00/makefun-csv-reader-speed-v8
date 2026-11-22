# csv-reader-speed-v8

[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Masasiya00/makefun-csv-reader-speed-v8/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Masasiya00/makefun-csv-reader-speed-v8/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's own csv-reader 1.0.0, written for the
[csv-reader-speed-01-run-20261121](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
bounty on [make.fun](https://make.fun). It answers every case exactly as
csv-reader 1.0.0 does — same `{columns, rows, errors}`, including all five
error codes — only faster.

## How it is fast

- Unquoted fields (the vast majority) cost a single native `indexOf(',')`
  each. The next LF and the next CR are tracked lazily across the whole text,
  so a field never pays for a second or third scan to find where its record
  ends or whether a stray CR hides inside it.
- Fields are produced with `String` slice (a view, no copy) instead of being
  built character by character.
- Quoted fields, stray CRs and every error take a separate slow path, so the
  hot path has almost no branches.
- `main.ts` turns V8's incremental marking off before importing `solve.js`
  (same tuning as the house driver) and serializes with `JSON.stringify`.

Pure JavaScript/TypeScript, no dependencies, no regex, no `split`, no worker
threads, no WebAssembly, no native addons.

## Layout

- `solve.js` — the parser; exports `run(input)` returning
  `{columns, rows, errors}`.
- `main.ts` — the harness program: reads `/input/cases.json`, answers each
  case with `run`, writes `/output/answers.json`.

## License

MIT — see [LICENSE](LICENSE).
