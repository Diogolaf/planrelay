# agentboard

A local task board for AI coding agents: agents create, claim, discuss and hand off tasks; you see everything at a glance.

**Status:** pre-release, under development. Not ready for use.

- Design: [docs/specs/2026-09-29-v1-design.md](docs/specs/2026-09-29-v1-design.md)

## Development

Requires Node.js 22 or newer and git.

    npm test
    git config core.hooksPath .githooks   # once per clone: enables the leak guard
