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
  /**
   * Syncing while Eaon is closed (main/features/toknJob.ts):
   * - on: Eaon's job runs tokn on the computer's own schedule.
   * - off: turned off, tracking the CLIs is off, or tokn isn't linked yet.
   * - tokn: tokn already runs on its own schedule (`tokn autosync on`).
   * - paused: `tokn autosync off` turned automatic syncing off in a terminal.
   * - approval: macOS holds Eaon's background item until it's allowed in
   *   System Settings → General → Login Items.
   * - unavailable: not on this computer (the Linux AppImage).
   * - failed: the operating system didn't take the job; `error` says how.
   *
   * `everyMinutes`: how often tokn publishes at most (its own setting, 90 unless changed).
   */
  background: { state: 'on' | 'off' | 'tokn' | 'paused' | 'approval' | 'unavailable' | 'failed'; error: string | null; everyMinutes: number }
}
