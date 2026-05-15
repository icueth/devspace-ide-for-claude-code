# Bundled `uv` for MemPalace install

This directory is populated at build time by `scripts/fetch-uv.mjs`. Layout:

```
mempalace-uv/
  darwin-arm64/uv
  darwin-x64/uv
  win32-x64/uv.exe
  linux-x64/uv
```

`uv` is a single-file Python package manager from Astral
(<https://github.com/astral-sh/uv>). devspace ships it so the Memory
settings tab can install the `mempalace` Python package without the user
having Python pre-installed (uv provisions an isolated tool environment).

Run `node scripts/fetch-uv.mjs` once before `pnpm dist:mac` — the build
will fail otherwise because `extraResources` references this path.
