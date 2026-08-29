import { MCP_CATALOG } from '@shared/mcpCatalog'

/** Static catalogue backing the plugin directory and skills pages. */

export interface PluginEntry {
  id: string
  name: string
  description: string
  /** `managed` entries are provisioned by a workspace admin, not installed by hand. */
  access: 'install' | 'managed'
  category: 'core' | 'featured' | 'productivity' | 'more'
}

/**
 * The plugin list every surface shows. Derived from the MCP catalog rather than
 * hand-maintained: this used to be six local document tools (Documents, PDF,
 * Spreadsheets, Presentations, Template Creator, Visualize) that were never
 * wired to anything, and keeping a second list beside the real catalog is how
 * the two drift apart.
 */
export const CORE_PLUGINS: PluginEntry[] = MCP_CATALOG.map((entry) => ({
  id: entry.id,
  name: entry.displayName,
  description: entry.summary,
  access: 'install',
  category: 'core'
}))

export const DIRECTORY: PluginEntry[] = [
  { id: 'gmail', name: 'Gmail', description: 'Read and manage Gmail', access: 'managed', category: 'featured' },
  { id: 'github', name: 'GitHub', description: 'Triage PRs, issues, CI, and publish releases', access: 'install', category: 'featured' },
  { id: 'google-drive', name: 'Google Drive', description: 'Work across Drive, Docs, Sheets, and Slides', access: 'managed', category: 'featured' },
  { id: 'google-calendar', name: 'Google Calendar', description: 'Manage Google Calendar events and invites', access: 'managed', category: 'featured' },
  { id: 'notion', name: 'Notion', description: 'Notion workflows for specs, docs, and databases', access: 'install', category: 'featured' },
  { id: 'slack', name: 'Slack', description: 'Read and manage Slack', access: 'install', category: 'featured' },

  { id: 'granola', name: 'Granola', description: 'Add your meeting context', access: 'install', category: 'productivity' },
  { id: 'fireflies', name: 'Fireflies', description: 'Search meeting transcripts', access: 'install', category: 'productivity' },
  { id: 'outlook-calendar', name: 'Outlook Calendar', description: 'Manage Microsoft Outlook calendars', access: 'install', category: 'productivity' },
  { id: 'plaud', name: 'Plaud', description: 'Retrieve insights from Plaud', access: 'install', category: 'productivity' },

  { id: 'outlook-email', name: 'Outlook Email', description: 'Read and manage Outlook mail', access: 'install', category: 'more' },
  { id: 'canva', name: 'Canva', description: 'Design and edit Canva documents', access: 'install', category: 'more' }
]

export const ALL_PLUGINS = [...CORE_PLUGINS, ...DIRECTORY]

export interface SkillEntry {
  id: string
  name: string
  description: string
}

const skill = (name: string, description: string): SkillEntry => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  name,
  description
})

export const SKILLS: SkillEntry[] = [
  skill('Animation Vocabulary', 'Reverse-lookup glossary that turns a vague description of a web animation into its exact term'),
  skill('Apple Design', "Apple's approach to interface design and fluid, physical motion, translated for the web"),
  skill('Banner Design', 'Design banners for social media, ads, website heroes, creative assets, and print'),
  skill('Better Accessibility', 'Focus, keyboard, ARIA, forms and screen readers'),
  skill('Better Colors', 'OKLCH palettes, contrast and theming'),
  skill('Better Interface', 'Cross-discipline interface review'),
  skill('Better Layout', 'Structure, grouping, alignment and adaptive layout'),
  skill('Better Typography', 'Web typography from fonts to spacing and wrapping'),
  skill('Better UI', 'Design engineering details for polished interfaces'),
  skill('Better Writing', 'UX writing, interface copy and microcopy'),
  skill('Brand', 'Brand voice, visual identity, messaging frameworks, asset management'),
  skill('Brandkit', 'Premium brand-kit image generation for high-end identity boards'),
  skill('Algorithmic Art', 'Generative art with seeded randomness and parameter exploration'),
  skill('Canvas Design', 'Posters and static art as PNG or PDF documents'),
  skill('Captions Overlay', 'Caption models for talking-head and launch video'),
  skill('Changelog Video', 'Turn a weekly changelog into a finished branded video'),
  skill('Context Optimization', 'Context engineering and harness design for agent systems'),
  skill('Dataviz', 'Charts, dashboards and visualization systems that read as one design'),
  skill('Design', 'Brand identity, design tokens, UI styling and logo generation'),
  skill('Design Lab', 'Generate and compare five distinct UI directions'),
  skill('Design System', 'Token architecture, component specs and slide generation'),
  skill('Design Taste Frontend', 'Anti-template frontend for landing pages and portfolios'),
  skill('Emil Design Eng', 'UI polish, component design and the invisible details'),
  skill('Embedded Captions', 'Cinematic captions embedded behind the subject'),
  skill('Faceless Explainer', 'Turn arbitrary text into a faceless explainer video'),
  skill('Figma', 'Import Figma assets, tokens and components into a composition'),
  skill('Find Skills', 'Discover and install skills that extend the assistant'),
  skill('Frontend Design', 'Distinctive, intentional visual direction for new UI'),
  skill('Frontend UI Engineering', 'Production-quality, accessible, responsive interfaces'),
  skill('Full Output Enforcement', 'Complete code generation with no placeholder patterns'),
  skill('General Video', 'Author or edit a custom composition when no workflow fits'),
  skill('GPT Taste', 'Editorial typography, bento grids and scroll-driven motion'),
  skill('High End Visual Design', 'The spacing, shadows and structure that read as expensive'),
  skill('Hyperframes', 'Entry point for any video, animation or motion graphic'),
  skill('Image To Code', 'Generate the design image first, then implement it faithfully'),
  skill('Industrial Brutalist UI', 'Raw structure, heavy rules and monospace detailing'),
  skill('Media Use', 'Source, process and place media inside a composition'),
  skill('Minimalist UI', 'Warm monochrome, typographic contrast, flat bento grids'),
  skill('Motion Doctrine', 'The rules that keep motion coherent across a piece'),
  skill('Motion Graphics', 'Short unnarrated motion-first units and animated titles'),
  skill('Music To Video', 'Build a composition driven by an audio track'),
  skill('Oversized Cursor', 'Cursor-led product demos and walkthroughs'),
  skill('PR To Video', 'Turn a pull request into a narrated walkthrough'),
  skill('Product Launch Video', 'Promo and product tour built from a real site'),
  skill('Redesign Existing Projects', 'Audit-first redesign of an existing interface'),
  skill('Remotion To Hyperframes', 'Port a Remotion project into the composition format'),
  skill('Seam Craft', 'Velocity-matched seams and transitions between shots'),
  skill('Skill Creator', 'Create, edit, evaluate and benchmark skills'),
  skill('Slides', 'Strategic HTML presentations with charts and design tokens'),
  skill('Slideshow', 'Sequence stills into a paced, musical slideshow'),
  skill('Stitch Design Taste', 'Cohesive multi-screen product design direction'),
  skill('Systematic Debugging', 'Work a bug from symptom to root cause before fixing'),
  skill('Talking Head Recut', 'Recut talking-head footage into a tighter edit'),
  skill('Theme Factory', 'Generate complete light and dark theme pairs'),
  skill('Threejs Animation', 'Keyframe, skeletal and morph-target animation in Three.js'),
  skill('UI Styling', 'Accessible component systems with tokens and dark mode'),
  skill('UI UX Pro Max', 'Styles, palettes, font pairings and UX guidelines'),
  skill('Using Superpowers', 'Compose multiple skills into one workflow'),
  skill('Web Artifacts Builder', 'Self-contained interactive pages and tools'),
  skill('Security Review', 'Review a change for security-relevant defects')
]

export const SKILL_COUNT = SKILLS.length
