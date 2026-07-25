// A one-channel event bus so ChatHome's suggestion chips (and anything else)
// can prefill the composer without prop drilling through ChatView. The
// composer subscribes on mount; setComposerDraft replaces its draft text.

type DraftListener = (text: string) => void;

const listeners = new Set<DraftListener>();

/** Replace the composer's draft text and focus it. */
export function setComposerDraft(text: string): void {
  for (const listener of listeners) listener(text);
}

/** Subscribe to draft replacements; returns an unsubscribe function. */
export function onComposerDraft(listener: DraftListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
