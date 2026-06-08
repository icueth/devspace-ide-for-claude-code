"""PyInstaller entry point for the bundled graphify binary.

graphify's console_script is `graphify = graphify.__main__:main` (pyproject.toml:77).
PyInstaller needs a concrete script file to freeze, so we re-export main() here.
`raise SystemExit(main())` works whether main() returns an exit code or None.
"""
from graphify.__main__ import main

raise SystemExit(main())
