/** Live scenes drawn in characters behind the chat (components/ChatScene.tsx). */
export const CHAT_SCENES = ['off', 'aurora', 'lagoon', 'drift', 'koi', 'jellyfish', 'boats', 'fireflies', 'moonlit', 'sunburst'] as const
export type ChatScene = (typeof CHAT_SCENES)[number]

export const CHAT_SCENE_LABELS: Record<ChatScene, string> = {
  off: 'Off',
  aurora: 'Aurora',
  lagoon: 'Honu Lagoon',
  drift: 'Cloud Drift',
  koi: 'Koi Pond',
  jellyfish: 'Jellyfish',
  boats: 'Paper Boats',
  fireflies: 'Fireflies',
  moonlit: 'Moonlit',
  sunburst: 'Sunburst'
}

/** What a new install shows behind the chat. */
export const DEFAULT_CHAT_SCENE: ChatScene = 'aurora'
