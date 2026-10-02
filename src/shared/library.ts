/** What `library:stat` reports for one attached file. */
export interface LibraryFileStat {
  path: string
  exists: boolean
  size: number
  /** Last-modified time in ms; 0 when the file is gone. */
  modified: number
  directory: boolean
}
