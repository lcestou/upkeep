# oxlint anti-slop rules

`anti-slop/` is a custom oxlint plugin, the same one sveltekit-boilerplate, svelte-wlm-tools, hangry-buster and oh-my-claude use. Its rules catch the shortcuts a model takes when it does not understand a value: runtime `typeof` probing, `unknown` parameters and returns, chained or uncommented type assertions, open dictionaries, and widening a known value then asserting it back. It also requires a doc comment on every function, which is this repo's own rule (CLAUDE.md). It is wired in `.oxlintrc.json` under `jsPlugins`, loaded through `@oxlint/plugins`, and all seventeen rules are on.

Exemptions, all in `.oxlintrc.json` under `overrides`:

- **I/O boundaries.** These files read data Upkeep does not own and check it into typed values, so `typeof`, `unknown` and loose dictionaries are allowed there:
  - `src/engine/manifest.ts` (the person's `apps.toml`)
  - `src/engine/github.ts` (GitHub's API)
  - `src/engine/forge.ts` (GitLab's and Gitea's release APIs, and the links of a download page)
  - `src/engine/managers.ts` (the lists uv, pipx, npm and cargo print of what they installed, and uv's receipts)
  - `src/engine/store.ts` (`state.json`)
  - `src/engine/transfer.ts` (an export file handed to `upkeep import`, possibly from another machine or an agent)
  - `src/engine/extras/state.ts` (the extras settings file)
  - `src/engine/extras/system.ts` (cinnamon-spice-updater's JSON)
  - `src/engine/extras/firmware.ts` (fwupdmgr's `get-updates --json`)
  - `src/engine/extras/snapshot.ts` (Timeshift's `/etc/timeshift/timeshift.json`)
  - `src/engine/backup.ts` (a restore point's `meta.json`)
  - `src/engine/kinds/plugins.ts` (Claude Code's plugin registry and its `claude plugin update --json` answers)
  - `src/bun/window-size.ts` (the saved window size)
  - `src/bun/dev-script.ts` (a development build's scripted steps)

  Code anywhere else gets typed values from these files. Add a new one to the override when it is written.

- **Tests and browser specs** (`**/*.test.ts`, `e2e/**`) build partial fakes, so they skip the assertion, unknown, dictionary, shadowing and function-scoping rules. The specs also await in loops on purpose, one step of a person's input after another.
- **The plugin's own AST helpers** walk nodes of any shape.

A type assertion outside these exemptions needs a `// SAFETY:` comment right above it that says why it holds.

The plugin's imports name the `.ts` files. oxlint runs JavaScript plugins under the `node` on PATH, and real Node does not map a `.js` import onto a `.ts` file.
