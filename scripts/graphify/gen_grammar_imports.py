"""Print the tree-sitter grammar modules to bundle, as a JSON array, by listing
every installed `tree_sitter_*` top-level module in the (freeze) environment.

Run with the freeze venv's python AFTER installing graphifyy[mcp]:
    python scripts/graphify/gen_grammar_imports.py
Output (stdout): ["tree_sitter_c", "tree_sitter_go", "tree_sitter_python", ...]

Why enumerate INSTALLED modules instead of graphify's LanguageConfig table?
graphify loads grammars two ways — a generic LanguageConfig table (`ts_module=...`)
AND bespoke per-language functions that do `import tree_sitter_go` etc.
(extract.py:5727/6071/6350/8386/9597). Listing installed modules captures BOTH,
so no grammar is silently dropped from the PyInstaller --hidden-import /
--collect-binaries set (risk R-GRAMMAR). graphifyy declares each grammar as a
hard dependency, so the installed set IS the intended grammar set.
"""
import json
import pkgutil
import sys

# Aggregate meta-packages graphify does not use individually.
AGGREGATES = {"tree_sitter_languages", "tree_sitter_language_pack"}

mods = sorted(
    m.name
    for m in pkgutil.iter_modules()
    if m.name.startswith("tree_sitter_") and m.name not in AGGREGATES
)

if not mods:
    print("error: no tree_sitter_* grammar modules installed", file=sys.stderr)
    raise SystemExit(2)

print(json.dumps(mods))
