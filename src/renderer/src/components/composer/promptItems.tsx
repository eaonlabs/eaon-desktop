import { Bookmark } from 'lucide-react'
import { previewOf } from '@shared/savedPrompts'
import { usePrompts } from '../../state/prompts'
import type { SuggestItem } from './SuggestMenu'

/**
 * The prompt library in the "/" menu: one entry that opens the library, and
 * (once a word is typed after "/") each saved prompt by name. Picking a prompt puts its text in the box in
 * place of the typed "/word", for the user to finish and send; it never
 * sends anything on its own.
 */
export function savedPromptItems(openLibrary: () => void, query: string): SuggestItem[] {
  const list = usePrompts.getState().list
  return [
    {
      id: 'prompts',
      title: 'Saved prompts',
      keywords: 'prompt library templates saved snippets browse',
      section: 'Saved prompts',
      icon: <Bookmark size={16} strokeWidth={1.8} />,
      hint: list.length ? undefined : 'None yet',
      run: openLibrary
    },
    // Each prompt only once something is typed, so the menu without a word stays the short list of commands.
    ...(query.trim() ? list : []).map(
      (prompt): SuggestItem => ({
        id: `prompt:${prompt.id}`,
        title: prompt.name,
        keywords: 'saved prompt',
        section: 'Saved prompts',
        description: previewOf(prompt.text, 90),
        icon: <Bookmark size={16} strokeWidth={1.8} />,
        insert: prompt.text
      })
    )
  ]
}
