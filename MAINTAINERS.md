# Maintainer Guide

This file documents the maintainer-facing Vouch workflow for AgentLayer.

## Policy

- Issues are allowed from anyone except users who have been explicitly denounced.
- Pull requests are only accepted from vouched contributors or collaborators who already have write access to the repository.
- Maintainers manage trust in `.github/VOUCHED.td`.

## Who Can Manage Vouches

- GitHub users with `admin`, `maintain`, or `write` access can manage vouches through the GitHub workflows.
- The automation listens on issue comments and discussion comments.

## Maintainer Commands

Use these commands in an issue comment or discussion comment.

### Vouch

- `vouch`
  - Vouches the author of the current issue or discussion.
- `vouch @username`
  - Vouches a specific GitHub user.
- `vouch some reason here`
  - Vouches the current issue or discussion author and records the reason.
- `vouch @username some reason here`
  - Vouches a specific user and records the reason.

### Denounce

- `denounce`
  - Denounces the author of the current issue or discussion.
- `denounce @username`
  - Denounces a specific GitHub user.
- `denounce reason here`
  - Denounces the current issue or discussion author and records the reason.
- `denounce @username reason here`
  - Denounces a specific user and records the reason.

### Unvouch

- `unvouch`
  - Removes the current issue or discussion author from the vouch file.
- `unvouch @username`
  - Removes a specific user from the vouch file.

## What Each Action Does

- `vouch`
  - Adds the user to `.github/VOUCHED.td`.
  - The user can then open pull requests even without repository write access.
- `denounce`
  - Adds the user as blocked in `.github/VOUCHED.td`.
  - Their issues and pull requests are auto-closed by policy.
- `unvouch`
  - Removes the user from `.github/VOUCHED.td` entirely.
  - This removes either a positive vouch or a denouncement.

## Recommended Usage

- If a contributor opens a legitimate issue and should be allowed to send PRs, comment `vouch` on their issue.
- If you are commenting somewhere else, use `vouch @username`.
- If someone is abusing the repo, use `denounce @username short reason`.
- If someone was added by mistake, use `unvouch @username`.

## What `/recheck` Does

- `/recheck` is only used for pull requests.
- It does not vouch anyone.
- It reruns the PR check workflow to see whether the PR author is now allowed.

Typical flow:

1. A contributor opens a PR.
2. The PR is auto-closed because they are not vouched yet.
3. A maintainer comments `vouch @username`.
4. Someone comments `/recheck` on the PR.
5. The PR check runs again and sees that the author is now vouched.

Note: `/recheck` reruns the gate, but it does not automatically reopen an already closed PR. If GitHub keeps the PR closed, reopen it manually or ask the contributor to open a new PR.

## Automation Files

- `.github/workflows/vouch-check-issue.yml`
- `.github/workflows/vouch-check-pr.yml`
- `.github/workflows/vouch-manage-by-issue.yml`
- `.github/workflows/vouch-manage-by-discussion.yml`
- `.github/VOUCHED.td`

## Notes

- The workflows automatically commit updates to `.github/VOUCHED.td`.
- If branch protection or rulesets are added later, the Vouch management workflows may need to switch to a GitHub App token.
