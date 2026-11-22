# site-generator-speed-01 — a faster drop-in for makefun-site 1.0.0

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/hikmalalfatih/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/hikmalalfatih/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own static site generator, [makefun-site 1.0.0](https://make.fun/bounty/site-generator-speed-01-run-20261122), written for the [site-generator-speed-01-run-20261122 bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122). It answers exactly as makefun-site 1.0.0 does on every case — byte for byte — and does it with less CPU time.

## How it works

`solve.js` re-implements makefun-site's build from scratch (front matter, its Markdown subset, its template dialect, its slug rule and its report):

- sources are read as line arrays once; each body is lexed and rendered in a single sweep, with no token objects in between;
- inline Markdown escapes plain text in bulk instead of one character at a time;
- slugs are cached per case (titles and tag names repeat a lot);
- every template is compiled to a JavaScript function, and the partials that only read the site, its tags and its recent posts are rendered once per case and reused.

`main.ts` is the driver the harness runs: it reads every case from `/input/cases.json`, answers each one alone with `run()` from `solve.js`, and writes `/output/answers.json`.

## Run it

```sh
node main.ts
```

Node 22 or later. No dependencies, no network, no build step.

## License

MIT — see [LICENSE](LICENSE).
