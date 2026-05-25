---
name: brand-design-systems
description: "A library of 150 brand and aesthetic design systems (Apple, Stripe, Linear, Vercel, Notion, GitHub, Figma, Spotify, Tesla, and more, plus styles like brutalism, glassmorphism, neumorphism, editorial, minimal). Use when the user wants a UI to look like a brand, match a brand's style or vibe, or adopt a named aesthetic. Read references/<brand>.md for that brand's colors, typography, spacing, radii, and component style before generating any UI."
---

# Brand Design Systems

This skill ships a reference file per brand/aesthetic under `references/`. Each
file documents that system's visual theme, color palette, typography, spacing,
border radii, and component conventions.

## How to use

1. From the user's request, pick the matching brand or aesthetic from the
   table below.
2. **Read `references/<slug>.md`** for that system before writing any markup.
3. Apply its color tokens, type scale, spacing rhythm, radii, and component
   patterns consistently across the design.
4. If the user names a brand not listed, pick the closest match (e.g. another
   fintech, another developer-tools brand, or a generic aesthetic like
   `minimal` / `modern` / `editorial`) and say which you used.

This skill is typically driven by the `ui-design` orchestrator skill, which
produces a self-contained HTML preview. It can also be used standalone to
inform any UI work.

## Available systems

Read `references/<slug>.md` for the brand you want.

| Brand / aesthetic | Style |
| --- | --- |
| `agentic` | Conversational AI-first interface with minimal controls, clear outcomes, and delegated task flows for agentic workflows. |
| `airbnb` | Travel marketplace. Warm coral accent, photography-driven, rounded UI. |
| `airtable` | Spreadsheet-database hybrid. Colorful, friendly, structured data aesthetic. |
| `ant` | Structured, enterprise-focused design system emphasizing clarity, consistency, and efficiency for data-dense web applications. |
| `apple` | Consumer electronics. Premium white space, SF Pro, cinematic imagery. |
| `application` | App dashboard with purple-themed aesthetic, top-bar navigation, card-based layouts, and developer-first workflows. |
| `arc` | "The browser that browses for you." Translucent surfaces, gradient warmth, sidebar-first layout. |
| `artistic` | High-contrast, expressive style with creative typography and bold color choices for visually striking interfaces. |
| `atelier-zero` | A magazine-grade, collage-driven visual system: warm paper canvas, surreal |
| `bento` | Modular grid layout with card-like blocks, clear hierarchy, soft spacing, and subtle visual contrast for organized, scannable interfaces. |
| `binance` | Crypto exchange. Bold yellow accent on monochrome, trading-floor urgency. |
| `bmw-m` | Motorsport performance sub-brand. Near-black cockpit surfaces, BMW M tricolor accents, sharp engineering geometry. |
| `bmw` | Luxury automotive. Dark premium surfaces, precise German engineering aesthetic. |
| `bold` | Strong visual presence with heavyweight typography, high-contrast colors, and commanding layouts. |
| `brutalism` | Raw, anti-design aesthetic inspired by concrete architecture with unadorned elements, jarring layouts, and functional minimalism. |
| `bugatti` | Hypercar brand. Cinema-black canvas, monochrome austerity, monumental display type. |
| `cafe` | Cozy cafe-inspired interface with warm tones, soft typography, and clean layouts for a relaxed browsing experience. |
| `cal` | Open-source scheduling. Clean neutral UI, developer-oriented simplicity. |
| `canva` | Visual creation platform. Vivid purple-blue gradient, generous spacing, friendly geometry. |
| `cisco` | Enterprise infrastructure brand. Dark trust surfaces, Cisco Blue signal, technical clarity. |
| `claude` | Anthropic's AI assistant. Warm terracotta accent, clean editorial layout. |
| `clay` | Creative agency. Organic shapes, soft gradients, art-directed layout. |
| `claymorphism` | Soft, rounded 3D-like shapes mimicking malleable clay with playful, puffy elements and colorful surfaces. |
| `clean` | Simplicity-focused design with ample whitespace, legible typography, and a limited color palette to reduce visual clutter. |
| `clickhouse` | Fast analytics database. Yellow-accented, technical documentation style. |
| `cohere` | Enterprise AI platform. Vibrant gradients, data-rich dashboard aesthetic. |
| `coinbase` | Crypto exchange. Clean blue identity, trust-focused, institutional feel. |
| `colorful` | Vibrant, high-contrast palettes and gradients for engaging, memorable, and modern user experiences. |
| `composio` | Tool integration platform. Modern dark with colorful integration icons. |
| `contemporary` | Current-era minimalist design with bento grids, dark mode support, and high-performance accessible layouts. |
| `corporate` | Professional, brand-aligned design with structured grids, minimalist layouts, and consistent enterprise patterns. |
| `cosmic` | Futuristic sci-fi aesthetic with dark themes, vibrant neon accents, and immersive spatial elements. |
| `creative` | Playful, character-driven design with expressive typography and bold graphics for landing pages and creative projects. |
| `cursor` | AI-first code editor. Sleek dark interface, gradient accents. |
| `dashboard` | Dark-themed cloud-platform aesthetic with modular grids, glass-like panels, and strong data hierarchy for productivity dashboards. |
| `default` | A clean, product-oriented default. Use when the brief doesn't call for a |
| `discord` | Voice / chat platform. Deep blurple, dark-first surfaces, playful accent moments. |
| `dithered` | Dot-pattern rendering technique that simulates shades with a limited palette for nostalgic, retro, high-contrast visuals. |
| `doodle` | Hand-drawn, sketch-like style with doodles, handwritten fonts, and imperfect lines for a playful, informal feel. |
| `dramatic` | High-contrast, theatrical design with bold layouts, immersive visuals, and unconventional compositions that command attention. |
| `duolingo` | Language-learning platform. Bright owl green, chunky shadows, gamified joy. |
| `editorial` | Magazine-inspired editorial layout with refined serif typography, structured grids, and elegant reading experiences. |
| `elegant` | Graceful, refined aesthetic with delicate typography, minimal palettes, and polished layouts that exude sophistication. |
| `elevenlabs` | AI voice platform. Dark cinematic UI, audio-waveform aesthetics. |
| `energetic` | Dynamic, vibrant style with thick borders, geometric shapes, high-contrast colors, and expressive typography conveying motion and vitality. |
| `enterprise` | Clean, high-contrast enterprise design for data-driven workflows with intuitive drag-and-drop patterns and structured layouts. |
| `expo` | React Native platform. Dark theme, tight letter-spacing, code-centric. |
| `expressive` | Vibrant, personality-driven design with bold colors, playful graphics, and dynamic layouts that balance creativity with structure. |
| `fantasy` | Game-inspired fantasy aesthetic with bold, premium visuals, rich color palettes, and immersive thematic elements. |
| `ferrari` | Luxury automotive. Chiaroscuro editorial, Ferrari Red accents, cinematic black. |
| `figma` | Collaborative design tool. Vibrant multi-color, playful yet professional. |
| `flat` | Two-dimensional minimalist style with vibrant colors, clean typography, and no 3D effects for fast, user-friendly interfaces. |
| `framer` | Website builder. Bold black and blue, motion-first, design-forward. |
| `friendly` | Approachable, intuitive design with rounded elements, ample whitespace, and soft pastel color palettes. |
| `futuristic` | Forward-looking design with tech-inspired typography, modern layouts, and a sleek, innovation-driven aesthetic. |
| `github` | Code-forward platform. Functional density, blue-on-white precision, Primer foundations. |
| `glassmorphism` | Frosted glass effect with translucent layers, subtle blur, and luminous borders for depth and modern elegance. |
| `gradient` | Smooth color transitions and gradient-rich surfaces for modern, playful interfaces with visual depth. |
| `hashicorp` | Infrastructure automation. Enterprise-clean, black and white. |
| `hud` | Fighter jet / helicopter head-up display. Phosphor green on near-black, all-caps data overlays, angular geometry. Zero ambiguity at speed and altitude. |
| `huggingface` | ML community hub. Sunny yellow accent, monospace identity, cheerful and dense. |
| `ibm` | Enterprise technology. Carbon design system, structured blue palette. |
| `intercom` | Customer messaging. Friendly blue palette, conversational UI patterns. |
| `kami` | Editorial paper system: warm parchment canvas, ink-blue accent, serif-led hierarchy. Built for resumes, one-pagers, white papers, portfolios, slide decks — anything that should feel like high-quality print rather than UI. Multilingual by design (EN · zh-CN · ja). |
| `kraken` | Crypto trading. Purple-accented dark UI, data-dense dashboards. |
| `lamborghini` | Supercar brand. True black surfaces, gold accents, dramatic uppercase typography. |
| `levels` | Conversion-focused design that removes friction and guides users toward action through clarity, trust, and speed. |
| `linear-app` | Project management. Ultra-minimal, precise, purple accent. |
| `lingo` | Playful, minimal design with bright colors, rounded shapes, tactile 3D borders, and friendly illustrations for approachable interfaces. |
| `loom` | Loom async video. Purple primary, friendly surfaces, video-first layout. Clean and professional without being corporate. |
| `lovable` | AI full-stack builder. Playful gradients, friendly dev aesthetic. |
| `luxury` | High-end dark aesthetic with bold headings, monochromatic palette, and premium feel for luxury brand experiences. |
| `mastercard` | Global payments network. Warm cream canvas, orbital pill shapes, editorial warmth. |
| `material` | Google's Material Design with layered surfaces, dynamic theming, built-in motion, and responsive cross-platform patterns. |
| `meta` | Tech retail store. Photography-first, binary light/dark surfaces, Meta Blue CTAs. |
| `minimal` | Stripped-back design emphasizing whitespace, clean typography, and restrained color for maximum clarity and focus. |
| `minimax` | AI model provider. Bold dark interface with neon accents. |
| `mintlify` | Documentation platform. Clean, green-accented, reading-optimized. |
| `miro` | Visual collaboration. Bright yellow accent, infinite canvas aesthetic. |
| `mission-control` | Space/aerospace mission monitoring. Dark command center, amber telemetry, monospace precision. Functional clarity above all else. |
| `mistral-ai` | Open-weight LLM provider. French-engineered minimalism, purple-toned. |
| `modern` | Contemporary editorial style with serif typography, minimal palettes, and clean layouts for polished digital products. |
| `mongodb` | Document database. Green leaf branding, developer documentation focus. |
| `mono` | Monospace-driven, matrix-inspired design with high-contrast elements, compact density, and a hacker-chic aesthetic. |
| `neobrutalism` | Modern take on brutalism with bold borders, vivid accent colors, and raw, high-contrast layouts on warm surfaces. |
| `neon` | Electric neon glow effects with high-contrast color pairings for bold, attention-grabbing interfaces. |
| `neumorphism` | Soft, extruded UI elements with inner and outer shadows on monochromatic surfaces for a tactile, embedded look. |
| `nike` | Athletic retail. Monochrome UI, massive uppercase type, full-bleed photography. |
| `notion` | All-in-one workspace. Warm minimalism, serif headings, soft surfaces. |
| `nvidia` | GPU computing. Green-black energy, technical power aesthetic. |
| `ollama` | Run LLMs locally. Terminal-first, monochrome simplicity. |
| `openai` | Calm, near-monochrome system anchored in deep teal-black with generous white space and editorial typography. |
| `opencode-ai` | AI coding platform. Developer-centric dark theme. |
| `pacman` | Retro arcade-inspired design with pixel fonts, dotted borders, playful high-contrast colors, and 8-bit game aesthetics. |
| `paper` | Paper-textured, print-inspired design with minimal colors, clean serif/sans typography, and tactile surface qualities. |
| `perplexity` | Conversational AI search engine. Deep-dark canvas, sharp typography, single violet accent, dense information hierarchy. |
| `perspective` | Spatial depth design with isometric views, vanishing points, and layered elements that guide attention through 3D-like realism. |
| `pinterest` | Visual discovery. Red accent, masonry grid, image-first. |
| `playstation` | Gaming console retail. Three-surface channel layout, quiet-authority display type, cyan hover-scale. |
| `posthog` | Product analytics. Playful hedgehog branding, developer-friendly dark UI. |
| `premium` | Apple-inspired premium aesthetic with precise spacing, modern typography, and a refined, polished visual language. |
| `professional` | Polished, business-ready design with modern typography, structured layouts, and a trustworthy visual identity. |
| `publication` | Print-inspired visual language for books, magazines, and reports with editorial grids and expressive typography. |
| `raycast` | Productivity launcher. Sleek dark chrome, vibrant gradient accents. |
| `refined` | Carefully curated, modern minimal style with elegant serif typography and understated, sophisticated palettes. |
| `renault` | French automotive. Vibrant aurora gradients, NouvelR typography, bold energy. |
| `replicate` | Run ML models via API. Clean white canvas, code-forward. |
| `resend` | Email API. Minimal dark theme, monospace accents. |
| `retro` | Throwback design with vintage-inspired typography, high-contrast retro palettes, and nostalgic visual elements. |
| `revolut` | Digital banking. Sleek dark interface, gradient cards, fintech precision. |
| `runwayml` | AI video generation. Cinematic dark UI, media-rich layout. |
| `sanity` | Headless CMS. Red accent, content-first editorial layout. |
| `sentry` | Error monitoring. Dark dashboard, data-dense, pink-purple accent. |
| `shadcn` | Shadcn/ui-inspired design with minimal, clean components, monochrome palette, and utility-first patterns. |
| `shopify` | E-commerce platform. Dark-first cinematic, neon green accent, ultra-light type. |
| `simple` | Straightforward, no-frills design with clean typography, neutral colors, and intuitive layouts that stay out of the way. |
| `skeumorphism` | Real-world mimicry with textured surfaces, 3D effects, and familiar physical metaphors for intuitive digital interfaces. |
| `slack` | Workplace communication platform. Aubergine-primary, multi-accent logo palette, light surfaces with dark sidebar, warm and approachable. |
| `sleek` | Modern minimalist aesthetic with clean lines, intentional color palette, subtle interactions, and consistent spacing. |
| `spacex` | Space technology. Stark black and white, full-bleed imagery, futuristic. |
| `spacious` | Generous whitespace, consistent padding, and grid-based layouts for clean, readable, and breathing interfaces. |
| `spotify` | Music streaming. Vibrant green on dark, bold type, album-art-driven. |
| `starbucks` | Global coffee retail brand. Four-tier green system, warm cream canvas, full-pill buttons. |
| `storytelling` | Narrative-driven design using visuals, copy, and interaction to guide users through engaging, emotionally resonant journeys. |
| `stripe` | Payment infrastructure. Signature purple gradients, weight-300 elegance. |
| `supabase` | Open-source Firebase alternative. Dark emerald theme, code-first. |
| `superhuman` | Fast email client. Premium dark UI, keyboard-first, purple glow. |
| `tesla` | Electric automotive. Radical subtraction, full-viewport photography, near-zero UI. |
| `tetris` | Classic block-game inspired design with playful colors, bold display fonts, and compact, high-energy layouts. |
| `theverge` | Tech editorial media. Acid-mint and ultraviolet accents, Manuka display, rave-flyer story tiles. |
| `together-ai` | Open-source AI infrastructure. Technical, blueprint-style design. |
| `totality-festival` | Surface: web |
| `trading-terminal` | Bloomberg-style financial trading terminal. Dark-only, data-dense, cyan/coral buy/sell signals. Everything readable at a glance from two meters away. |
| `uber` | Mobility platform. Bold black and white, tight type, urban energy. |
| `urdu` | Editorial / Personal / Publication |
| `vercel` | Frontend deployment. Black and white precision, Geist font. |
| `vibrant` | Lively, colorful design with bold playful typography, warm accents, and dynamic visual energy. |
| `vintage` | 1950s-1990s nostalgia with skeuomorphic touches, grainy textures, retro color palettes, and pixel-style typography. |
| `vodafone` | Global telecom brand. Monumental uppercase display, Vodafone Red chapter bands. |
| `voltagent` | AI agent framework. Void-black canvas, emerald accent, terminal-native. |
| `warm-editorial` | A serif-led magazine aesthetic. Terracotta accent on warm off-white paper — |
| `warp` | Modern terminal. Dark IDE-like interface, block-based command UI. |
| `webex` | Collaboration platform. Momentum typography, blue action system, multi-user accent spectrum. |
| `webflow` | Visual web builder. Blue-accented, polished marketing site aesthetic. |
| `wechat` | Brand visual language for WeChat Mini Programs, official accounts, and open ecosystem extensions. |
| `wired` | Tech magazine. Paper-white broadsheet density, custom serif display, mono kickers, ink-blue links. |
| `wise` | Money transfer. Bright green accent, friendly and clear. |
| `x-ai` | Elon Musk's AI lab. Stark monochrome, futuristic minimalism. |
| `xiaohongshu` | Lifestyle UGC social platform. Singular brand red, generous radius, content-first. |
| `zapier` | Automation platform. Warm orange, friendly illustration-driven. |

_150 systems total. Each row maps to `references/<slug>.md`._
