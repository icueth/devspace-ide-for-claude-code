# Built-in Pack Attribution

The agents and skills bundled under `builtin-packs/agents/` and
`builtin-packs/skills/` are drawn from the open Claude Code ecosystem.
They cover general engineering, product, marketing, design, and
operations workflows. None of the bundled content represents
proprietary DevSpace logic.

## Sources

- Community Claude Code **agent kits** (general dev personas: backend,
  fullstack, security, devops, python-pro, rust-pro, typescript-pro,
  etc.) — distributed under MIT-compatible terms.
- Community **skill collections** for the Claude Code Skills ecosystem,
  including the open `skills/` marketplace and contrib repos. Most
  skills are MIT or Apache-2.0; see individual `SKILL.md` frontmatter
  if an upstream-specific license is referenced.
- Anthropic Cookbook and Claude Code documentation patterns
  (Apache-2.0).

## How to update

To refresh the bundled content from a curator's `~/.claude/agents` and
`~/.claude/skills` directories:

```sh
# from the repo root
cp -R ~/.claude/agents/. resources/builtin-packs/agents/
cp -R ~/.claude/skills/. resources/builtin-packs/skills/
```

Then bump version, regenerate the dmg, and commit. Anything personal
(internal infrastructure, proprietary workflows, credentials) should be
removed before commit — only general-purpose entries belong here.

## Reporting issues

If you're an author whose work is bundled here and you'd like the
attribution updated or removed, open an issue at
https://github.com/icueth/devspace-ide-for-claude-code/issues.
