# Contributing

## A38

This repository requires A38 according to the canonical A38 standard in
[DFXswiss/agent](https://github.com/DFXswiss/agent/blob/473be2bbac871694a9c6df5e30c0570d0ca38ea9/docs/a38.md)
at commit `473be2bbac871694a9c6df5e30c0570d0ca38ea9`. Repo job selection:
`.github/a38.json`. Target-branch applicability and fork workflow approval:
`.github/pr-guard.json`. `dfx pr guard` is
[wired in](https://github.com/DFXswiss/agent/blob/473be2bbac871694a9c6df5e30c0570d0ca38ea9/docs/a38-guard.md#how-fork-github-actions-are-meant-to-work).

Feature pull requests target `develop`, not `main`.

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
on the current head. Every new head needs a new report. Authors with write
access to `21gifts/spend` do not need a report.
