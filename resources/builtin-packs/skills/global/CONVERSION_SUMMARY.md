# Gemini Skills to Claude Code Global Skills Conversion

## Conversion Summary

**Date:** March 16, 2026
**Source:** `/Users/icue/.gemini/antigravity/skills`
**Destination:** `/Users/icue/.claude/skills/global`
**Total Skills Converted:** 112

## What Was Converted

All Gemini agency skills have been successfully converted to Claude Code global skills format with the following transformations:

### Frontmatter Changes

**Original Gemini Format:**
```yaml
---
name: agency-frontend-developer
description: Expert frontend developer specializing in...
risk: low
source: community
date_added: '2026-03-14'
---
```

**New Claude Code Format:**
```yaml
---
name: frontend-developer
description: Expert frontend developer specializing in...
tools: Glob, Grep, LS, Read, Edit, Write, WebFetch, WebSearch, BashOutput
model: sonnet
---
```

### Key Transformations

1. **Naming Convention**: Removed `agency-` prefix from skill names
2. **Added Tools**: Inferred appropriate tools based on skill type:
   - Development skills: `Glob, Grep, LS, Read, Edit, Write, WebFetch, WebSearch, BashOutput`
   - Testing/QA skills: `Glob, Grep, LS, Read, WebFetch, WebSearch, BashOutput`
   - Marketing skills: `WebFetch, WebSearch, Read, Write, Edit`
   - Business/Project skills: `WebFetch, WebSearch, Read, Write, Edit, Bash`
   - And many more category-specific toolsets

3. **Added Model**: Set default model to `sonnet` for all skills
4. **Preserved Content**: All original skill content, guidelines, examples, and workflows remain intact

## Skill Categories Converted

### Engineering & Development (40+ skills)
- Frontend/Backend/Full-Stack development
- Mobile app development (iOS, Android, cross-platform)
- Game development (Unity, Unreal, Godot, Roblox)
- Embedded firmware engineering
- DevOps & infrastructure
- AI/ML engineering

### Design & UX (10+ skills)
- UI/UX design and architecture
- Visual storytelling
- Technical art
- Level design
- XR/VR/AR development

### Marketing & Social Media (20+ skills)
- Social media strategy (TikTok, Instagram, Twitter, LinkedIn)
- Content creation and curation
- SEO/SEM specialists
- Paid media campaigns
- Platform-specific experts (WeChat, Bilibili, Xiaohongshu, etc.)

### Business & Operations (15+ skills)
- Project management
- Finance tracking
- Sales analytics
- Workflow optimization
- Studio operations

### Testing & Quality (10+ skills)
- Code testing and QA
- Security auditing
- Accessibility testing
- Performance benchmarking
- Compliance auditing

### Specialized Domains (15+ skills)
- Blockchain & smart contracts
- Legal compliance
- Cultural intelligence
- Inclusive design
- Data engineering
- MLOps

## How to Use These Skills

### In Claude Code

These skills are now available as global skills in Claude Code. You can invoke them using the slash command syntax:

```
/<skill-name>
```

Examples:
- `/frontend-developer` - Invoke the frontend developer skill
- `/ai-engineer` - Invoke the AI/ML engineering skill
- `/embedded-firmware-engineer` - Invoke the embedded firmware skill

### Available Skills (Complete List)

1. accessibility-auditor
2. accounts-payable-agent
3. ad-creative-strategist
4. agentic-identity-trust-architect
5. agents-orchestrator
6. ai-engineer
7. analytics-reporter
8. api-tester
9. app-store-optimizer
10. autonomous-optimization-architect
11. backend-architect
12. baidu-seo-specialist
13. behavioral-nudge-engine
14. bilibili-content-strategist
15. blockchain-security-auditor
16. brand-guardian
17. carousel-growth-engine
18. china-e-commerce-operator
19. compliance-auditor
20. content-creator
21. cultural-intelligence-strategist
22. data-analytics-reporter
23. data-consolidation-agent
24. data-engineer
25. developer-advocate
26. devops-automator
27. embedded-firmware-engineer
28. evidence-collector
29. executive-summary-generator
30. experiment-tracker
31. feedback-synthesizer
32. finance-tracker
33. frontend-developer
34. game-audio-engineer
35. game-designer
36. godot-gameplay-scripter
37. godot-multiplayer-engineer
38. godot-shader-developer
39. growth-hacker
40. identity-graph-operator
41. image-prompt-engineer
42. incident-response-commander
43. inclusive-visuals-specialist
44. infrastructure-maintainer
45. instagram-curator
46. jira-workflow-steward
47. kuaishou-strategist
48. legal-compliance-checker
49. level-designer
50. lsp-index-engineer
51. macos-spatial-metal-engineer
52. mobile-app-builder
53. model-qa-specialist
54. narrative-designer
55. paid-media-auditor
56. paid-social-strategist
57. performance-benchmarker
58. ppc-campaign-strategist
59. programmatic-display-buyer
60. project-shepherd
61. rapid-prototyper
62. reality-checker
63. reddit-community-builder
64. report-distribution-agent
65. roblox-avatar-creator
66. roblox-experience-designer
67. roblox-systems-scripter
68. sales-data-extraction-agent
69. search-query-analyst
70. security-engineer
71. senior-developer
72. senior-project-manager
73. seo-specialist
74. social-media-strategist
75. solidity-smart-contract-engineer
76. sprint-prioritizer
77. studio-operations
78. studio-producer
79. support-responder
80. technical-artist
81. technical-writer
82. terminal-integration-specialist
83. test-results-analyzer
84. threat-detection-engineer
85. tiktok-strategist
86. tool-evaluator
87. tracking-measurement-specialist
88. trend-researcher
89. twitter-engager
90. ui-designer
91. unity-architect
92. unity-editor-tool-developer
93. unity-multiplayer-engineer
94. unity-shader-graph-artist
95. unreal-multiplayer-architect
96. unreal-systems-engineer
97. unreal-technical-artist
98. unreal-world-builder
99. ux-architect
100. ux-researcher
101. visionos-spatial-engineer
102. visual-storyteller
103. wechat-mini-program-developer
104. wechat-official-account-manager
105. whimsy-injector
106. workflow-optimizer
107. xiaohongshu-specialist
108. xr-cockpit-interaction-specialist
109. xr-immersive-developer
110. xr-interface-architect
111. zhihu-strategist
112. zk-steward

## Conversion Script

The conversion was performed using `/Users/icue/convert_gemini_skills.py`, which:

1. Parses Gemini skill SKILL.md files
2. Extracts frontmatter and body content
3. Transforms to Claude Code skill format
4. Infers appropriate toolsets based on skill category
5. Removes the `agency-` prefix from skill names
6. Adds Claude Code-specific metadata (model, tools)

## Notes

- All original content from Gemini skills is preserved
- Tool assignments are inferred based on skill categories and may need adjustment for specific use cases
- Skills are organized in individual directories within `/Users/icue/.claude/skills/global/`
- Each skill maintains its complete documentation, workflows, and examples

## Next Steps

1. **Test Skills**: Verify each skill works as expected in Claude Code
2. **Adjust Tools**: Fine-tune tool assignments for specific skills if needed
3. **Add Custom Skills**: Create new Claude Code-specific skills in this directory
4. **Documentation**: Consider adding a README.md for each skill category

## Support

For issues or questions about the conversion, refer to the original conversion script or the Claude Code documentation.

---

**Conversion completed successfully on March 16, 2026**
