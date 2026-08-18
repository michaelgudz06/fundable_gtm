<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# personalize-api

One decision layer: identity in, one ICP + use cases + one plain-text email body
out (`POST /api/v1/personalize`). It sends nothing. [README.md](README.md) is
the entry point; [docs/SPEC-v2.md](docs/SPEC-v2.md) is the spec. Where the spec
and the files under `config/registry/` disagree, fix the JSON files, not the
prompts.

## The rule that must not regress

Generated copy is **fail-closed against the claims registry**: catalog copy may
only assert claims whose `status` is `"approved"` in
`config/registry/approved_claims.json`. `pending_review` means a human has not
signed off — never flip a status to `approved` yourself, and never route around
the gate in code or prompt.

## Behaviour lives in JSON

Most behaviour changes are registry edits, not code — see "Editing behaviour" in
the README for which file governs what. **Bump the file's `version` after any
edit**: labels are cached against it for 30 days, and an unbumped edit keeps
serving old answers.

## Verify loop

- `npm run verify` — typecheck every workspace + 140 offline tests + build.
  Offline, no keys. Must pass before any commit.
- Gold-set loop (live, spends real credits): mine candidates with
  `npx tsx scripts/build-gold-set.ts --csv <export>`, a **human** approves every
  row (`--approve <queue>`), then score with
  `npx tsx scripts/evaluate-gold-set.ts` against the frozen baseline
  (`--freeze` re-records it). Only human-approved rows reach the gold set — a
  set our own classifier labelled would measure nothing.
- `npx tsx scripts/debug-classify.ts --preset cre` — why did THIS lead get THAT
  label.

## Root docs map

- `README.md` — the current product. Keep it correct; it is the only status doc.
- `FINDINGS.md` — live-probed defects in the upstream Fundable API. Read it
  before touching `packages/fundable-shared/src/fundable.ts`.
- `PRD.md`, `BUILD_LOG.md` — historical records of the v1 personalizer
  (`/api/personalize`, route since deleted; its streaming sibling
  `/api/personalize/stream` is still in the tree, serving `/demo`). Do not
  update them and do not read them as current status.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
