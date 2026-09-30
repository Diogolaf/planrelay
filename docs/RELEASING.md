# Releasing agentboard

A checklist for the maintainer. Do the steps in order, and do not skip the checks: they are what keeps private data out of a public repository.

`<owner>`, `<repo>` and `<name>` stand for the GitHub account, the repository and the final name of the tool.

## 1. Before anything is pushed

- [ ] **Choose the final name.** `agentboard` is a working name. To rename:
  - change `src/name.js`, `package.json` (`name`, `bin`), `.claude-plugin/plugin.json` (`name`, the server's key) and `.claude-plugin/marketplace.json` (the marketplace and the plugin);
  - rename the skill folder `skills/agentboard/` and the `name` in its front matter;
  - update the description in `hooks/hooks.json`;
  - rename the `AGENTBOARD_*` variables of the leak guard, in `scripts/`, `.github/workflows/ci.yml` and this guide;
  - find the rest with `git grep -i agentboard`, then run every check of this section.
- [ ] **Create the GitHub account that publishes the project.** In its e-mail settings, turn on "Keep my email addresses private" and "Block command line pushes that expose my email". The first one matters for CI: GitHub writes merge commits with the account's e-mail, and the history check refuses any address that is not a no-reply one.
- [ ] **Rewrite the commit identities.** Set this repository's `user.name` and `user.email` to the account's name and its no-reply address (`<id>+<owner>@users.noreply.github.com`). Then rewrite the author and the committer of every commit to it, for example:

      git filter-branch --env-filter 'export GIT_AUTHOR_NAME="<owner>" GIT_AUTHOR_EMAIL="<no-reply address>" GIT_COMMITTER_NAME="<owner>" GIT_COMMITTER_EMAIL="<no-reply address>"' -- --all

  Afterwards delete the backup refs the rewrite leaves (`git for-each-ref refs/original`), and check that one address is left: `git log --all --format='%ae %ce' | sort -u`.
- [ ] **Run every check.**

      npm test
      npm run test:ui
      npm run check:leaks
      npm run check:history
      npm run check:pack
      claude plugin validate . --strict

  Run `claude plugin validate` with the newest Claude Code: newer versions check more of the manifest.
- [ ] **Run the acceptance script:** `node scripts/acceptance.mjs`. It starts five short real sessions on your own account.

## 2. The first push

- [ ] Create the repository as **private**. Turn on secret scanning and push protection.
- [ ] Add the repository secret `AGENTBOARD_DENYLIST`: the private list, one term per line. Without it, the `denylist` job fails on every push. Add the same secret under Dependabot's secrets if its pull requests should be checked too.
- [ ] Add the remote with credentials of the new account only: an SSH key made for it (selected with `core.sshCommand`), or a credential helper that holds nothing else. Never push with another account's cached login.
- [ ] Make sure the hooks are on in the checkout you push from: `git config core.hooksPath .githooks`. The `pre-push` hook is a tracked file, so a checkout of an older commit does not have it.
- [ ] Push. The hook checks everything the push would publish and refuses it while a commit still carries the placeholder e-mail (`@example.invalid`).
- [ ] Watch the first CI run. It is the first time the workflow runs at all, the first time the Node tests run on Linux and macOS, and the first time the browser tests run on Linux. Fix what it finds before going on.

## 3. Try the plugin from the marketplace

In a throwaway project:

    /plugin marketplace add <owner>/<repo>
    /plugin install <name>@<name>

- [ ] Ask "what does the board say?", create a task, and say "open the board".
- [ ] Check that installing ran no package install: the plugin's folder in Claude Code's plugin cache has no `node_modules`.

## 4. Going public

- [ ] Run `npm run check:history` and gitleaks over the full history once more.
- [ ] Read the repository as a stranger would: the README, the docs, the commit messages, the file names.
- [ ] Make the repository public.

## 5. npm

- [ ] In `package.json`, add `repository`, `homepage` and `bugs`, and remove `"private": true`. The `repository` field also makes the README's screenshots work on the package's npm page (the images are not in the package).
- [ ] `npm run check:pack`, then `npm pack --dry-run` and read the file list.
- [ ] `npm publish`, with an npm account that belongs to the project.
- [ ] In a throwaway project: `npx <name> dashboard`.
- [ ] Update the README: the status line, the install commands (`/plugin marketplace add <owner>/<repo>`) and the dashboard command (`npx <name> dashboard`).

## 6. Every later release

- [ ] Bump `version` in `package.json` and `.claude-plugin/plugin.json` together (a test keeps them equal). Users of the plugin get an update only when the version changes.
- [ ] Run the checks of section 1, then tag, push and publish.

## Pull requests from other people

- The `denylist` job does not run on pull requests from forks, because forks cannot read the secret. Before merging one, look at its commits' author e-mails: an address that is not a GitHub no-reply address makes the history check fail on `main` afterwards.
