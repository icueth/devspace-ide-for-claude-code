"""PyInstaller entry point for the bundled graphify binary.

graphify's console_script is `graphify = graphify.__main__:main` (pyproject.toml:77).
PyInstaller needs a concrete script file to freeze, so we re-export main() here.

MULTIPROCESSING FIX (load-bearing): graphify parses code in parallel via
ProcessPoolExecutor (extract.py). In a frozen binary the default 'spawn' start
method RE-LAUNCHES this executable for each worker with `--multiprocessing-fork`
/ `-B`; those args fall through to graphify's argv parser ("unknown command
'-B'") and every worker dies — silently dropping the files it was parsing.
  * freeze_support() handles the Windows spawn re-exec path.
  * Forcing 'fork' on macOS/Linux avoids re-exec entirely (workers run the pool
    fn in a forked child; tree-sitter parsing is C-only so fork is safe here).
  * On Windows 'fork' is unavailable, so we keep spawn + freeze_support().
"""
import multiprocessing

if __name__ == "__main__":
    multiprocessing.freeze_support()
    try:
        multiprocessing.set_start_method("fork")
    except (RuntimeError, ValueError):
        # 'fork' unavailable (Windows) or start method already set — keep default.
        pass

    from graphify.__main__ import main

    raise SystemExit(main())
