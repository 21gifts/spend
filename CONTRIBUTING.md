# Contributing

[REVIEW.md](REVIEW.md) is binding for every change and for every review of a change. Read it and this file at the base revision of the pull request. A pull request that changes either file does not replace that base text for the rest of its diff. The review does not change files.

## A38

This repository requires A38 according to the canonical A38 standard in
[DFXswiss/agent](https://github.com/DFXswiss/agent/blob/87df78c2b2952ba928c048ce585fbd1f0124be8b/docs/a38.md)
at commit `87df78c2b2952ba928c048ce585fbd1f0124be8b`. Repo job selection:
`.github/a38.json`. Target-branch applicability and fork workflow approval:
`.github/pr-guard.json`. `dfx pr guard` is
[wired in](https://github.com/DFXswiss/agent/blob/87df78c2b2952ba928c048ce585fbd1f0124be8b/docs/a38-guard.md#how-fork-github-actions-are-meant-to-work).

Feature pull requests always target `develop`, not `staging` and not `main`. Developers rebase `staging` onto `develop` regularly, because those pull requests land on `develop` and do not update `staging`.

This is a **public** repository. GitHub-hosted runners execute the heavy suite
(Vitest with the coverage gate, Playwright UI, the invoice path against the
api checkout, and Playwright visual). A38 does not replace those GitHub
checks. The author report only covers the light local job in
`.github/a38.json` (`bun install --frozen-lockfile`, then `bun run typecheck`,
with `CI=true`). Do not run Vitest or Playwright locally for A38.

Draft pull requests run the GitHub CI jobs. GitHub holds fork runs from
external contributors as `action_required`. Ready does not start CI. After a
fresh A38 enforce pass on the current head, `dfx pr guard` approves those
waiting initial runs, then sets Ready when the required GitHub jobs are green
and the PR is mergeable. The merger does not click Approve and run workflows.
Do not ask a maintainer to approve workflow runs. Post the light A38 report
on the current head only when the pinned standard requires one. A head that
still requires a report needs a new report. That standard defines the waivers,
including write access and a markdown-only or guard-docs change set.
