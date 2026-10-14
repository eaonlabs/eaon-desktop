/**
 * The tokn command (github.com/toknlabs/Tokn), which ships inside Eaon:
 * what Settings and the setup show about it. See main/features/toknCli.ts.
 */
export interface ToknCliStatus {
  /** The version that ships inside Eaon; null in a build without it. */
  version: string | null
  /**
   * The `tokn` a terminal runs: Eaon's (a small launcher Eaon wrote), or
   * another one found first (from npm), which Eaon leaves alone. Null when
   * there is none.
   */
  command: { kind: 'eaon' | 'other'; path: string } | null
  /**
   * The folder Eaon's launcher is in, when the user's terminal doesn't look
   * there, so `tokn` won't be found until it is added to PATH.
   */
  needsPath: string | null
  /** The Tokn account the command is linked to. */
  linked: { handle: string } | null
  /** Linking it, or its last hourly sync. */
  activity: { state: 'idle' | 'linking' | 'syncing'; at: number | null; error: string | null }
}
