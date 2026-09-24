import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MAX_RECENTS = 8

/**
 * Recently opened project folders, in their own small file under userData
 * rather than in settings: the list is the Code tab's alone, and keeping it
 * out of the shared Settings type means no other feature has to carry it.
 */
export class RecentFolders {
  constructor(private readonly file: string) {}

  static at(userData: string): RecentFolders {
    return new RecentFolders(join(userData, 'store', 'eaon-code.json'))
  }

  list(): string[] {
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as { recentFolders?: unknown }
      return Array.isArray(value.recentFolders)
        ? value.recentFolders.filter((entry): entry is string => typeof entry === 'string')
        : []
    } catch {
      return []
    }
  }

  /** Moves `folder` to the front. Folders that no longer exist drop off. */
  add(folder: string): string[] {
    const next = [folder, ...this.list().filter((entry) => entry !== folder)]
      .filter((entry) => existsSync(entry))
      .slice(0, MAX_RECENTS)
    this.save(next)
    return next
  }

  remove(folder: string): string[] {
    const next = this.list().filter((entry) => entry !== folder)
    this.save(next)
    return next
  }

  private save(recentFolders: string[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ recentFolders }, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }
}
