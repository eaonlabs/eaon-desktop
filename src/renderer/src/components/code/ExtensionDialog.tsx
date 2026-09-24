import { useEffect, useState, type JSX } from 'react'
import { Modal } from '../ui'
import { useCode } from './codeStore'
import type { EaonUiRequest } from '@shared/eaonCode'

/**
 * Eaon Code extensions can ask the user something mid-turn — pick an option,
 * confirm, type a value, edit text. Over RPC those arrive as
 * `extension_ui_request`s and the extension waits for the matching response,
 * so each one is shown as a dialog here, oldest first, and answered or
 * cancelled; a turn is never left blocked on a question nobody can see.
 */
export function ExtensionDialog(): JSX.Element | null {
  const request = useCode((s) => s.transcript.dialogs[0] ?? null)
  const respond = useCode((s) => s.respondDialog)
  if (!request) return null
  return <Dialog key={request.id} request={request} respond={respond} />
}

function Dialog({
  request,
  respond
}: {
  request: EaonUiRequest
  respond: ReturnType<typeof useCode.getState>['respondDialog']
}): JSX.Element {
  const [value, setValue] = useState(request.method === 'editor' ? (request.prefill ?? '') : '')
  const cancel = (): void => respond(request.id, { cancelled: true })

  // The extension resolves a timed-out dialog with its default on its own;
  // close ours at the same moment so the two never disagree.
  const timeout = 'timeout' in request ? request.timeout : undefined
  useEffect(() => {
    if (!timeout) return
    const timer = setTimeout(cancel, timeout)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeout])

  if (request.method === 'select') {
    return (
      <Modal open onClose={cancel} title={request.title} width={420} actions={<button className="btn btn--ghost" onClick={cancel}>Cancel</button>}>
        <div className="code-dialog__options">
          {request.options.map((option, index) => (
            <button key={option} className="code-dialog__option" autoFocus={index === 0} onClick={() => respond(request.id, { value: option })}>
              {option}
            </button>
          ))}
        </div>
      </Modal>
    )
  }

  if (request.method === 'confirm') {
    return (
      <Modal
        open
        onClose={() => respond(request.id, { confirmed: false })}
        title={request.title}
        width={420}
        actions={
          <>
            <button className="btn btn--ghost" onClick={() => respond(request.id, { confirmed: false })}>
              No
            </button>
            <button className="btn btn--accent" autoFocus onClick={() => respond(request.id, { confirmed: true })}>
              Yes
            </button>
          </>
        }
      >
        {request.message}
      </Modal>
    )
  }

  const multiline = request.method === 'editor'
  return (
    <Modal
      open
      onClose={cancel}
      title={request.title}
      width={multiline ? 560 : 420}
      actions={
        <>
          <button className="btn btn--ghost" onClick={cancel}>
            Cancel
          </button>
          <button className="btn btn--accent" onClick={() => respond(request.id, { value })}>
            Submit
          </button>
        </>
      }
    >
      {multiline ? (
        <textarea
          className="input code-dialog__editor"
          autoFocus
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
        />
      ) : (
        <input
          className="input"
          autoFocus
          value={value}
          placeholder={request.method === 'input' ? request.placeholder : undefined}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && respond(request.id, { value })}
          style={{ width: '100%' }}
        />
      )}
    </Modal>
  )
}
