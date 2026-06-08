"""Run a frozen graphify binary against the language fixture and fail if any
bundled grammar silently dropped (returns no nodes / 'not installed' error).

Usage:  python scripts/graphify/validate_langs.py <graphify-binary> <fixture-dir>
Exit 0 on success; non-zero with a per-language report on failure.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

EXT_TO_LANG = {
    ".py": "python", ".js": "javascript", ".ts": "typescript", ".go": "go",
    ".rs": "rust", ".rb": "ruby", ".php": "php", ".java": "java",
    ".c": "c", ".cpp": "cpp", ".cs": "c_sharp", ".kt": "kotlin",
    ".scala": "scala", ".swift": "swift", ".lua": "lua", ".sh": "bash",
}


def main() -> int:
    binary, fixture = sys.argv[1], Path(sys.argv[2])
    expected = {EXT_TO_LANG[p.suffix] for p in fixture.iterdir()
                if p.suffix in EXT_TO_LANG}

    with tempfile.TemporaryDirectory() as out:
        proc = subprocess.run(
            [binary, "extract", str(fixture), "--out", out, "--no-cluster"],
            capture_output=True, text=True,
            env={**os.environ, "GRAPHIFY_QUERY_LOG_DISABLE": "1"},
        )
        combined = proc.stdout + proc.stderr
        if "not installed" in combined:
            print(f"FAIL: a grammar reported 'not installed':\n{combined}", file=sys.stderr)
            return 1

        graph_path = Path(out) / "graphify-out" / "graph.json"
        if not graph_path.is_file():
            print(f"FAIL: no graph.json produced. exit={proc.returncode}\n{combined}",
                  file=sys.stderr)
            return 1

        graph = json.loads(graph_path.read_text())
        node_count = len(graph.get("nodes", []))
        if node_count == 0:
            print(f"FAIL: graph has zero nodes.\n{combined}", file=sys.stderr)
            return 1

    print(f"OK: extracted {node_count} nodes across {len(expected)} languages: "
          f"{', '.join(sorted(expected))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
