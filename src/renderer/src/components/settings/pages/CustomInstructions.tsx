import { useEffect, useRef, useState } from 'react'
import { INSTRUCTIONS_LIMIT } from '@shared/personalize'
import { Card, Section } from '../../ui'
import { usePersonalize } from './usePersonalize'
import './personalize.css'

/**
 * Settings → General → Custom instructions: one text box whose text is added
 * to the system prompt of every Chat message. Saved after a pause in typing
 * and when you leave the box; empty means nothing is added.
 */
export function CustomInstructions(): JSX.Element {
  const saved = usePersonalize()
  const kept = saved?.instructions ?? ''
  const [text, setText] = useState('')
  const loaded = useRef(false)
  const lastKept = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The first load, or a change made in another window while this box had nothing unsaved.
  useEffect(() => {
    if (!saved) return
    if (!loaded.current || text.trim() === lastKept.current) setText(saved.instructions)
    loaded.current = true
    lastKept.current = saved.instructions
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to what main sends, not to typing
  }, [saved])

  const save = (value: string): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (value.trim() !== lastKept.current) void window.api.personalize.setInstructions(value)
  }
  const change = (value: string): void => {
    setText(value)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => save(value), 800)
  }
  // Leaving the page with a change still waiting saves it.
  const latest = useRef(text)
  latest.current = text
  useEffect(
    () => () => {
      if (timer.current) save(latest.current)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on leaving only
    []
  )

  const pending = loaded.current && text.trim() !== kept
  const on = kept !== ''

  return (
    <Section label="Custom instructions">
      <Card>
        <div className="personal">
          <textarea
            aria-label="Custom instructions"
            className="input personal__area"
            rows={5}
            maxLength={INSTRUCTIONS_LIMIT}
            value={text}
            disabled={saved === null}
            placeholder="How Eaon should answer, or what it should know about you. For example: “Keep answers short. I work in TypeScript.”"
            onChange={(e) => change(e.target.value)}
            onBlur={() => save(text)}
          />
          <div className="personal__foot">
            <span>
              {on || pending
                ? 'Sent with every message you send in Chat, after the project’s instructions. Workers and scheduled tasks don’t get it.'
                : 'Off while this is empty. Whatever you write here is sent with every message you send in Chat.'}
            </span>
            <span className="personal__count">
              {pending ? 'Saving… ' : ''}
              {text.length} / {INSTRUCTIONS_LIMIT}
            </span>
          </div>
        </div>
      </Card>
    </Section>
  )
}
