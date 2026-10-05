import { app } from 'electron'
import { store } from './store'
import { backupDocs, readDoc, shapeOf, sweepTempFiles, writeDocSync } from './storeFiles'
import { migrateScheduledRuns } from './features/scheduler/migrate'

/**
 * Versioned changes to the shape of saved data, run once each, in order, at
 * startup before anything reads the store.
 *
 * `store/store-meta.json` records the version the profile is at. A migration
 * that rewrites user data names the files it touches, and they are copied to
 * `store/backups/` first. One that fails is logged and stops the run there —
 * the version stays where it was, so it is tried again next launch — but
 * never stops Eaon from starting. A profile written by a newer Eaon (a
 * version above this one's) is left alone: nothing here knows its shape.
 *
 * Every migration must also be safe to run on data it has already migrated:
 * going back to an older Eaon and forward again brings back the old shape.
 * The loaders tolerate both shapes for the same reason.
 */

export interface Migration {
  version: number
  name: string
  /** Store documents it rewrites; backed up before it runs. */
  files: string[]
  run: () => void
}

const META = 'store-meta.json'

interface StoreMeta {
  schema?: number
  /** The app version that last moved the schema forward. */
  by?: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'workspaces',
    files: ['workspaces.json', 'settings.json', 'chats.json', 'projects.json'],
    run: () => store.migrateWorkspaces()
  },
  {
    version: 2,
    name: 'scheduled-runs',
    files: ['scheduled-tasks.json', 'scheduled-runs.json'],
    run: () => migrateScheduledRuns()
  }
]

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

export function runMigrations(migrations: Migration[] = MIGRATIONS, appVersion = app.getVersion()): { from: number; to: number } {
  const meta = readDoc<StoreMeta>(META, shapeOf<StoreMeta>({}))
  const from = typeof meta.schema === 'number' && Number.isFinite(meta.schema) ? meta.schema : 0
  const latest = migrations.at(-1)?.version ?? 0
  if (from > latest) {
    console.warn(`[migrations] this profile is at schema ${from}, newer than this Eaon (${latest}); leaving it as it is`)
    return { from, to: from }
  }
  let at = from
  for (const migration of migrations) {
    if (migration.version <= at) continue
    backupDocs(`before-${migration.name}`, migration.files)
    try {
      migration.run()
    } catch (error) {
      console.error(`[migrations] ${migration.name} failed; will try again next launch:`, error)
      break
    }
    at = migration.version
    writeDocSync(META, { ...meta, schema: at, by: appVersion })
  }
  return { from, to: at }
}

/**
 * Startup: clear a crashed write's temp files, run what migrations are due,
 * then the repairs that run every launch (a chat pointing at a project that
 * is gone; see `migrateWorkspaces`).
 */
export function prepareStore(): void {
  sweepTempFiles()
  runMigrations()
  store.migrateWorkspaces()
}
