import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Plugin } from 'vite';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
const prodDeps = Object.keys(pkg.dependencies ?? {});

// node-pty is a native addon; must stay external at runtime.
const bundledDeps = prodDeps.filter((d) => d !== 'node-pty');

// Stub native .node addon imports so Rollup doesn't choke on them.
function nativeModuleStub(): Plugin {
  const STUB_ID = '\0native-stub';
  return {
    name: 'native-module-stub',
    resolveId(source) {
      if (source.endsWith('.node')) return STUB_ID;
      return null;
    },
    load(id) {
      if (id === STUB_ID) return 'export default {}';
      return null;
    },
  };
}

export default defineConfig({
  main: {
    plugins: [nativeModuleStub()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    resolve: {
      alias: {
        '@main': resolve(__dirname, 'src/main'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@preload': resolve(__dirname, 'src/preload'),
      },
    },
    // electron-vite's MainBuildOptions type omits `sourcemap` / `outDir`,
    // which the underlying vite BuildOptions accepts at runtime. Suppress
    // the typecheck on the first offending property so we keep the runtime
    // behavior without losing strictness elsewhere.
    build: {
      externalizeDeps: {
        exclude: bundledDeps,
      },
      // @ts-expect-error vite BuildOptions superset
      sourcemap: false,
      minify: 'esbuild',
      reportCompressedSize: false,
      outDir: 'dist-electron/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          // UV_THREADPOOL_SIZE must be set before native modules load.
          // High value prevents deadlocks when many PTYs + fs watchers coexist.
          banner: `if(!process.env.UV_THREADPOOL_SIZE){process.env.UV_THREADPOOL_SIZE='24'}`,
        },
      },
    },
  },
  preload: {
    resolve: {
      alias: {
        '@preload': resolve(__dirname, 'src/preload'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      // @ts-expect-error vite BuildOptions superset
      outDir: 'dist-electron/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
        output: {
          format: 'cjs',
          // .cjs because package.json has "type": "module" and Electron loads
          // preload through Node's CJS loader.
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    optimizeDeps: {
      include: ['@codemirror/language-data'],
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    plugins: [react()],
    build: {
      // Source maps are expensive and only useful for dev-tools debugging in
      // production. Skip them — saves ~5MB in the DMG.
      // @ts-expect-error vite BuildOptions superset
      sourcemap: false,
      target: 'esnext',
      cssCodeSplit: true,
      reportCompressedSize: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
        output: {
          // Split the 3.8MB monolith into cacheable vendor bundles so the
          // renderer can parse/compile them in parallel on cold start.
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined;
            // Strict path anchors — otherwise `react-markdown` matches `react`
            // and `@radix-ui` transitively pulls its react import back into the
            // react chunk, producing a circular-chunk warning.
            if (id.includes('/react-dom/') || id.includes('/scheduler/') || /\/react\/(?!-|dom|is)/.test(id)) {
              return 'react-vendor';
            }
            if (id.includes('@codemirror/lang-')) return 'cm-langs';
            if (id.includes('@codemirror/language-data')) return 'cm-langs';
            if (id.includes('@codemirror/merge')) return 'cm-merge';
            if (id.includes('@codemirror/')) return 'cm-core';
            if (id.includes('@xterm/')) return 'xterm';
            if (
              id.includes('react-markdown') ||
              id.includes('remark-') ||
              id.includes('rehype-') ||
              id.includes('micromark') ||
              id.includes('/unified/') ||
              id.includes('mdast') ||
              id.includes('hast')
            ) {
              return 'md';
            }
            if (id.includes('highlight.js')) return 'hljs';
            if (id.includes('@radix-ui/')) return 'radix';
            if (id.includes('lucide-react')) return 'icons';
            if (id.includes('zustand')) return 'state';
            return undefined;
          },
        },
      },
    },
  },
});
