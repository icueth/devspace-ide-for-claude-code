# DevSpace Built-in Packs

Bundled starter pack of agents and skills that ship with every DevSpace
install. Lives under `<App>.app/Contents/Resources/builtin-packs/` after
build (mapped from this repo's `resources/builtin-packs/` via
electron-builder `extraResources`).

## Layout

```
builtin-packs/
  agents/
    <slug>.md            # Claude Code agent definition
    …
  skills/
    <slug>/
      SKILL.md           # Claude Code skill definition
      …                  # optional helpers, references, examples
    …
```

## Discovery

- `AgentsService.listAgents()` and `SkillsService.listSkills()` read this
  directory in addition to `~/.claude/agents` / `~/.claude/skills`.
- Anything here is exposed with `scope: 'builtin'` and is **read-only**
  in the DevSpace UI — users edit a copy by duplicating into global or
  project scope first.
- Precedence when the same slug exists in multiple scopes:
  `project > global > builtin` (highest priority wins; lower entries
  are flagged `overridden: true` and dimmed in the picker).

## Content origin

The bundled agents and skills are curated from the open Claude Code
ecosystem (community agent kits, contrib skills, Anthropic Cookbook
examples). All entries are general-purpose, non-proprietary content
intended to give new DevSpace users a useful default set without
requiring them to assemble one from scratch.

See `ATTRIBUTION.md` for upstream sources and `LICENSE` for the umbrella
license.
