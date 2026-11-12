/** Live scenes drawn in characters behind the chat (components/ChatScene.tsx). */
export const CHAT_SCENES = ['off', 'sunburst', 'drift', 'koi', 'jellyfish', 'fireflies', 'moonlit'] as const
export type ChatScene = (typeof CHAT_SCENES)[number]

export const CHAT_SCENE_LABELS: Record<ChatScene, string> = {
  off: 'Off',
  sunburst: 'Sunburst',
  drift: 'Cloud drift',
  koi: 'Koi pond',
  jellyfish: 'Jellyfish',
  fireflies: 'Fireflies',
  moonlit: 'Moonlit'
}
