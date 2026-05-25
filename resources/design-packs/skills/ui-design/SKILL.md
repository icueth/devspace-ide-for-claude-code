---
name: ui-design
description: "Orchestrates UI and page design. Use when the user asks to design a page, screen, UI, landing page, dashboard, login flow, pricing page, invoice, resume, FAQ, article, slide deck, social card, or any web layout; to make it look like a brand (Apple, Stripe, Linear, Vercel, Notion, ...); or to build a mockup, prototype, wireframe, or HTML preview. Picks a matching layout skill, optionally adopts a brand design system, then writes a single self-contained HTML file to <project>/.devspace/preview/ so DevSpace can preview it."
---

# UI Design Orchestrator

You are designing a **standalone, single-file HTML page** that DevSpace will
render in its **HTML Preview** tab. This skill coordinates the bundled design
skills and brand design systems and ends by **writing one `.html` file** to a
specific location.

## The output contract (read this first)

- Produce **exactly one self-contained `.html` file**. Inline all CSS in a
  `<style>` tag. JavaScript, if any, goes inline in a `<script>` tag.
- **No build step, no framework, no React, no bundler, no `npm install`.**
  Plain HTML + CSS (+ optional vanilla JS). Tailwind is allowed **only via the
  Play CDN** (`<script src="https://cdn.tailwindcss.com"></script>`). Web
  fonts via Google Fonts `<link>` are fine. Do not reference any local asset.
- **Write the file with the Write tool** to:

  ```
  <project>/.devspace/preview/<kebab-name>.html
  ```

  where `<project>` is the absolute path of the current project/workspace and
  `<kebab-name>` describes the page (e.g. `saas-landing.html`,
  `analytics-dashboard.html`, `acme-invoice.html`). Create the
  `.devspace/preview/` directory if it does not exist.
- After writing, **tell the user the file will appear automatically in the
  HTML Preview tab** — DevSpace watches that directory and opens/refreshes the
  preview on its own. They do not need to run anything.

## Workflow

### 1. Pick a layout skill

Choose the bundled design skill that best matches what the user wants and read
its `SKILL.md` for layout structure, sections, and patterns. Available layout
/ page-design skills include:

| Skill | Use for |
| --- | --- |
| `frontend-design` | General production UI / web pages with strong typographic + layout discipline |
| `web-design-guidelines` | Baseline web page quality rules (spacing, hierarchy, contrast) |
| `web-artifacts-builder` | Rich interactive single-page web artifacts |
| `platform-design` | App/platform shells: nav, sidebars, dense product UI, dashboards |
| `ui-skills` / `ui-ux-pro-max` | Component-level UI patterns and polish |
| `login-flow` | Auth screens: sign-in / sign-up / reset flows |
| `faq-page` | FAQ / help / support pages |
| `resume-modern` | Resume / CV layouts |
| `article-magazine` | Long-form editorial / magazine article pages |
| `data-report` | Data-heavy report pages and metric summaries |
| `frame-data-chart-nyt` | Editorial data charts (NYT-style) |
| `poster-hero` | Hero / poster / marketing landing heroes |
| `release-notes-one-pager` | Release notes / changelog one-pagers |
| `social-x-post-card`, `social-reddit-card`, `social-spotify-card`, `card-twitter`, `card-xiaohongshu` | Social media cards |
| `deck-swiss-international`, `deck-open-slide-canvas`, `deck-guizang-editorial`, `slides`, `frontend-slides` | Slide decks / presentations |
| `doc`, `doc-kami-parchment` | Document layouts |

If none fits exactly, pick the closest and adapt. The user's wording ("a
dashboard", "a pricing page", "a mobile app screen") drives the choice.

### 2. Optionally adopt a brand design system

If the user wants it to **look like a specific brand** ("make it look like
Apple", "match Stripe's style", "Linear-style", "Vercel vibes"), invoke the
**`brand-design-systems`** skill and read `references/<brand>.md` for that
brand's colors, typography, spacing, radii, and component style. Apply those
tokens consistently. If no brand is named, choose a clean, modern default and
keep it internally consistent.

### 3. Produce the HTML

- **Self-contained**: everything inline. The file must render correctly when
  opened directly with no server and no network beyond allowed CDNs.
- **Responsive**: include `<meta name="viewport" content="width=device-width,
  initial-scale=1">` and layouts that work from ~360px to desktop.
- **Accessible**: semantic HTML (`<header>`, `<nav>`, `<main>`, `<button>`,
  headings in order), `alt` text on images, labels on form controls, visible
  focus states, and sufficient color contrast (WCAG AA).
- Use placeholder content that reads realistically; for images, use a neutral
  inline SVG or a public placeholder service rather than local files.

### 4. Write it and hand off

Write to `<project>/.devspace/preview/<kebab-name>.html`, then tell the user:

> Saved to `.devspace/preview/<kebab-name>.html` — it will open automatically
> in the **HTML Preview** tab. Ask me to tweak it and I'll update the file in
> place (the preview refreshes on its own).

## Rules

- One file, standalone HTML only. **Never** scaffold a React/Vite/Next app for
  a preview — that is explicitly not what this is.
- Always write under `.devspace/preview/`. Never write the preview elsewhere.
- Keep iterating in the **same file** when the user asks for changes, so the
  preview tab refreshes rather than spawning duplicates.
