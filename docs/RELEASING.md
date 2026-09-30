# Releasing agentboard

A checklist for the maintainer. Do the steps in order, and do not skip the checks: they are what keeps private data out of a public repository.

`<owner>`, `<repo>` and `<name>` stand for the GitHub account, the repository and the final name of the tool.

## 1. Before anything is pushed

- [ ] **Choose the final name.** `agentboard` is a working name and cannot be the published one: an unrelated package of that name is already on npm. Before renaming anything, check that the new name is free: `npm view <name>` must answer with a 404 error, and a search on GitHub should find no project of that name. A scoped name (`@<owner>/<name>`) is the other way out.
- [ ] **Rename.** The name is in many files, so do it mechanically:
  - replace `agentboard` and `AGENTBOARD` in every tracked file outside `docs/plans/` (the plans are history);
  - `git mv skills/agentboard skills/<name>`;
  - you are done when `git grep -i agentboard -- . ':!docs/plans'` prints nothing;
  - the leak guard's names change with it: the `AGENTBOARD_DENYLIST` and `AGENTBOARD_DENYLIST_FILE` variables and the default folder `~/.agentboard-dev/`. Move your private list to the new folder, or every hook fails with "no denylist found";
  - then run every check of this section. The old name stays in the history (commit messages and old file contents).
- [ ] **Merge into `main`** and delete the merged feature branches, so the next step rewrites one branch and the first push publishes one.
- [ ] **Create the GitHub account that publishes the project.** In its e-mail settings, turn on "Keep my email addresses private" and "Block command line pushes that expose my email". The first one matters for CI: GitHub writes merge commits with the account's e-mail, and the history check refuses any address that is not a no-reply one.
- [ ] **Rewrite the commit identities.** Set this repository's `user.name` to the account's login and `user.email` to its no-reply address (`<id>+<owner>@users.noreply.github.com`). Then rewrite the author and the committer of every commit, in Git Bash:

      git filter-branch --env-filter 'export GIT_AUTHOR_NAME="<owner>" GIT_AUTHOR_EMAIL="<no-reply address>" GIT_COMMITTER_NAME="<owner>" GIT_COMMITTER_EMAIL="<no-reply address>"' -- --all

  - The commits keep their dates, with the time zone of the machine that made them. To publish them in UTC instead, add this inside the same quotes: `GIT_AUTHOR_DATE="${GIT_AUTHOR_DATE% *} +0000" GIT_COMMITTER_DATE="${GIT_COMMITTER_DATE% *} +0000"`, and commit with `TZ=UTC` from then on.
  - The rewrite leaves backup refs. Delete them: `git for-each-ref --format="delete %(refname)" refs/original | git update-ref --stdin`.
  - Check that one address is left: `git log --all --format='%ae %ce' | sort -u` prints one line.
  - With tags in the repository, add `--tag-name-filter cat` before `-- --all`.
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

- [ ] Create the repository as **private**. While it is private, the protection against leaks is this repository's own: the hooks before each commit and push, and the `gitleaks` and `denylist` jobs in CI. GitHub's secret scanning and push protection are not available for a private repository of a free personal account.
- [ ] Add the repository secret `AGENTBOARD_DENYLIST` (or its new name): the private list, one term per line. Without it, the `denylist` job fails on every push. Add the same secret under Dependabot's secrets if its pull requests should be checked too.
- [ ] Add the remote with credentials of the new account only: an SSH key made for it (selected with `core.sshCommand`), or a credential helper that holds nothing else. Never push with another account's cached login.
- [ ] Make sure the hooks are on in the checkout you push from: `git config core.hooksPath .githooks`. The `pre-push` hook is a tracked file, so a checkout of an older commit does not have it.
- [ ] `git push -u origin main`. The hook checks everything the push would publish and refuses it while a commit still carries the placeholder e-mail (`@example.invalid`).
- [ ] Watch the first CI run. It is the first time the workflow runs at all, the first time the Node tests run on Linux and macOS, and the first time the browser tests run on Linux. Fix what it finds before going on. A private repository pays for its CI minutes, and the macOS jobs count many times over; a public one does not.

## 3. Try the plugin from the marketplace

In a throwaway project. While the repository is private, Claude Code must be able to clone it without asking: it uses the machine's default SSH key, or the stored git credentials, and neither is the new account's. Give the new account's key a host alias in `~/.ssh/config`, then:

    /plugin marketplace add git@<alias>:<owner>/<repo>.git
    /plugin install <name>@<name>

- [ ] Before installing, make sure no older copy of the plugin or of its server is still registered in Claude Code, so the two do not both load.
- [ ] Ask "what does the board say?", create a task, and say "open the board".
- [ ] Check that installing ran no package install: the plugin's folder in Claude Code's plugin cache has no `node_modules`.

## 4. Going public

- [ ] Run `npm run check:history` and `gitleaks git --redact --no-banner .` once more.
- [ ] Read the repository as a stranger would: the README, the docs, the commit messages, the file names.
- [ ] If the history had to be rewritten after the first push, do not make this repository public. A forced push leaves the old commits on GitHub, reachable by their hash. Delete the repository and create a new one from the clean history. Delete any CI run whose log you would not want public.
- [ ] Update the README for a public repository, commit and push: the status line, and the install commands (`/plugin marketplace add <owner>/<repo>`, `/plugin install <name>@<name>`).
- [ ] Make the repository public. Then check, in its security settings, that secret scanning and push protection are on.
- [ ] Remove the marketplace added in section 3 and add it again with the exact command the README shows.

## 5. npm

- [ ] In `package.json`, add `repository`, `homepage` and `bugs`, and remove `"private": true`. The `repository` field also makes the README's screenshots work on the package's npm page (the images are not in the package).
- [ ] Update the README's lines that depend on npm, because the package carries the README and the npm page shows it until the next version: the status line, the sentence about a local copy in Install, the dashboard commands (`npx <name> dashboard`) and the `repair` command. Commit and push.
- [ ] `npm run check:pack`, then `npm pack --dry-run` and read the file list.
- [ ] `npm login` with an npm account that belongs to the project, with two-factor authentication on. Then `npm publish` from that commit (it runs the package check again first), and tag the commit.
- [ ] In a throwaway project: `npx <name> dashboard`.

## 6. Every later release

- [ ] Bump `version` in `package.json` and `.claude-plugin/plugin.json` together (a test keeps them equal). Users of the plugin get an update only when the version changes.
- [ ] Run the checks of section 1, then tag, push and publish.

## Pull requests from other people

- The `denylist` job does not run on pull requests from forks, because forks cannot read the secret. Before merging one, look at its commits' author e-mails: an address that is not a GitHub no-reply address makes the history check fail on `main` afterwards.
