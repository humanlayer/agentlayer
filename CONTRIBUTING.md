# Contributing to AgentLayer

Thanks for your interest in AgentLayer.

Maintainers should see `MAINTAINERS.md` for maintainer-only Vouch commands and moderation workflows.

## Contribution Policy

- Issues are open to everyone except users who have been explicitly denounced.
- Pull requests are only accepted from vouched contributors or collaborators who already have write access to the repository.
- If you need a vouch, join our Discord at http://humanlayer.com/discord, introduce yourself, and include your GitHub username plus what you want to work on.
- Open-ended product ideas, design conversations, and community discussion should go in GitHub Discussions when possible.

## Issues

- Use the closest issue template and include concrete reproduction steps, context, and environment details when reporting bugs.
- Feature requests should explain the problem they solve, not just the proposed interface.
- Issues from denounced users are automatically closed.

## Pull Requests

- Complete the pull request template.
- Keep pull requests focused and explain the user-facing or developer-facing impact.
- Run the relevant tests before opening a pull request.
- Pull requests from unvouched users are automatically closed.

If your pull request is auto-closed because you are not vouched yet, request a vouch in Discord and then comment `/recheck` on the pull request after a maintainer confirms it.

## How Vouches Work

- Maintainers manage vouches in `.github/VOUCHED.td`.
- Maintainers can update the trust list directly in git or by using the Vouch workflows:
  - `vouch @username`
  - `denounce @username optional reason`
  - `unvouch @username`
- These commands can be used in issue comments, and also in discussion comments once Discussions are enabled.
- Collaborators with write access are already allowed to open pull requests even if they are not listed in `.github/VOUCHED.td`.

## Development Basics

- Run tests with `bun run test`.
- Run typechecking with `bun run typecheck`.
- Run formatting with `bun run biome`.

When in doubt, prefer small, well-scoped changes with clear explanations.
