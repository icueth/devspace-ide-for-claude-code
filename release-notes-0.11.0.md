## DevSpace 0.11.0 — Bundled agent/skill packs + chat segment cards

Two features ship together: fresh installs are no longer empty, and chat
no longer collapses long streaming turns into a wall of tools + a flat
paragraph.

### Bundled built-in agents & skills

Every fresh install now comes with **30 agents + 181 skills** curated
from the open Claude Code ecosystem (community agent kits, Cookbook
examples, contrib skills — all MIT / Apache-2.0). They live read-only
under `<App>.app/Contents/Resources/builtin-packs/` and merge into
`AgentsService.listAgents()` / `SkillsService.listSkills()` as a new
`scope: 'builtin'`.

- **Read-only by design.** Settings shows a "Built-in" group with a
  "(read-only)" suffix and lock icon. Click "Duplicate to Global /
  Project" to make an editable copy. For skills, the duplicate is a
  full recursive folder copy — SKILL.md plus any sibling
  `references/` / `examples/` / `assets/` / scripts come along, so the
  duplicate is a complete working copy.
- **Precedence: project > global > plugin > builtin.** Same-slug
  collisions show ALL entries; lower-priority duplicates carry
  `overridden: true` and dim in the picker.

### Chat message segment cards

When Claude streams `text → call Read → more text → call Edit`, the
old UI showed ONE bubble with ALL tools clustered at the top and ALL
text flattened at the bottom. v0.11 renders each chronological chunk as
its own card preserving order — same shape Claude Code CLI uses.

- `ChatMessage.segments` (optional, back-compat) — ordered
  `{ kind: 'text', id, text } | { kind: 'tool_group', id, toolUseIds }`.
- Backend (`ChatLineHandler`) and renderer (`applyEvent`) both build
  segments from the JSONL stream in arrival order. Same-kind blocks
  coalesce.
- Legacy threads (no `segments` on disk) fall back to the old flat
  layout — no migration needed.

### Hardening before commit (2 reviewers, 23 findings)

The agents/skills IPC took caller-controlled file paths, which is the
most dangerous IPC shape. All blockers fixed:

- 🔒 **SEC-BLOCKER** (arbitrary file read): `agents:read` /
  `skills:read` IPC accepted any path. Now gated by
  `assertValidAgentPath` / `assertValidSkillPath` at every IPC entry
  point. Slug regex `/^[a-z0-9][a-z0-9-]{0,63}$/i`.
- 🔒 **SEC-BLOCKER** (slug pollution via duplicate): destination slug
  was derived from caller-controlled source path. Now validated +
  containment-checked.
- 🔒 **SEC-HIGH** (arbitrary write): `saveAgent` / `saveSkill` trusted
  `agent.path` regardless of `agent.scope`. Now refuses paths inside
  the builtin bundle or plugin marketplaces dir, even if scope claims
  writable.
- 🔒 **SEC-HIGH** (arbitrary recursive delete): `deleteSkill` did
  `fs.rm(parent, { recursive: true })` on unvalidated paths. Now
  scope-validated before the destructive call.
- 🔒 **SEC-MEDIUM**: 2 MB cap on agent/skill files; 500 KB / 5000
  segments cap in transcript hydration to bound a hostile JSON
  payload.
- 🐛 **BUG-HIGH** (memo break): renderer's `applyEvent` mutated
  segment objects in place. Worked today only because nothing
  memoizes the children — would freeze the moment anyone added
  `React.memo` for streaming perf. Now replace-not-mutate.
- 🐛 **BUG-HIGH** (broken feature): `duplicateSkill` copied only
  SKILL.md while docs claimed recursive folder copy. Fixed to do real
  `fs.cp(srcDir, destDir, { recursive: true })`.

### Verification

- 221/221 vitest tests pass (212 + 9 new BuiltinScope tests)
- Typecheck clean
- arm64 dmg, signed unsigned (see README for Gatekeeper unblock)

### Upgrade

Users on 0.6.x – 0.10.x will see an in-app update notification
(`latest-mac.yml`). After upgrade, open Settings → Agents or
Settings → Skills to see the new "Built-in" section. Open any chat
and start a turn — long tool-heavy responses should now render as
ordered cards instead of one blob.
