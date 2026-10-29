import { execFile } from 'node:child_process'

/**
 * Calendar and Reminders on this Mac, through their scripting interface
 * (JavaScript for Automation via `osascript`). macOS asks the user once to
 * let Eaon control each app; until they allow it every call fails with a
 * message saying where to allow it.
 *
 * Values from the model only ever reach the script as JSON literals, never
 * as script text. `run` is injectable so tests needn't touch the real apps.
 */

export type ScriptRunner = (script: string) => Promise<string>

const TIMEOUT_MS = 45_000

export const runJxa: ScriptRunner = (script) =>
  new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const text = `${stderr || error.message}`
        if (/-1743|not allowed|Not authorized/i.test(text)) {
          reject(new Error('macOS hasn’t let Eaon use this app yet. Allow it in System Settings → Privacy & Security → Automation (or Calendars / Reminders), then try again.'))
        } else if (error.killed) reject(new Error('The app took too long to answer.'))
        else reject(new Error(text.replace(/^.*execution error: /s, '').trim().split('\n')[0] || 'The script failed.'))
        return
      }
      resolve(stdout.trim())
    })
  })

export interface CalendarEvent {
  title: string
  start: string
  end: string
  location: string
  calendar: string
  allDay: boolean
}

export interface Reminder {
  name: string
  due: string | null
  list: string
  completed: boolean
}

const lit = (value: unknown): string => JSON.stringify(value)

export function createHousehold(run: ScriptRunner = runJxa) {
  const json = async <T>(script: string): Promise<T> => {
    const out = await run(script)
    try {
      return JSON.parse(out || 'null') as T
    } catch {
      throw new Error(`Unexpected answer from the app: ${out.slice(0, 200)}`)
    }
  }

  return {
    /** Events from the start of `from`'s day for `days` days, soonest first. */
    async events(from: Date, days: number): Promise<CalendarEvent[]> {
      const start = new Date(from)
      start.setHours(0, 0, 0, 0)
      const end = new Date(start.getTime() + Math.max(1, Math.min(31, Math.round(days))) * 86_400_000)
      const list = await json<CalendarEvent[]>(`
        const Cal = Application('Calendar');
        const start = new Date(${lit(start.toISOString())}), end = new Date(${lit(end.toISOString())});
        const out = [];
        for (const c of Cal.calendars()) {
          let evs = [];
          try { evs = c.events.whose({ _and: [{ startDate: { _lessThan: end } }, { endDate: { _greaterThan: start } }] })() } catch (e) { continue }
          for (const e of evs) out.push({ title: e.summary() || '', start: e.startDate().toISOString(), end: e.endDate().toISOString(), location: e.location() || '', calendar: c.name(), allDay: e.alldayEvent() });
        }
        JSON.stringify(out)`)
      return (list ?? []).sort((a, b) => a.start.localeCompare(b.start))
    },

    /** Adds an event to `calendar` (by name), or to the first calendar that takes new events. */
    async addEvent(event: { title: string; start: Date; end: Date; location?: string; calendar?: string }): Promise<string> {
      if (!event.title.trim()) throw new Error('Give the event a title.')
      if (!(event.end > event.start)) throw new Error('The event has to end after it starts.')
      return run(`
        const Cal = Application('Calendar');
        const wanted = ${lit(event.calendar ?? '')};
        const cals = Cal.calendars().filter((c) => { try { return c.writable() } catch (e) { return true } });
        const cal = (wanted && cals.find((c) => c.name().toLowerCase() === wanted.toLowerCase())) || cals[0];
        if (!cal) throw new Error('There is no calendar to add to.');
        const ev = Cal.Event({ summary: ${lit(event.title)}, startDate: new Date(${lit(event.start.toISOString())}), endDate: new Date(${lit(event.end.toISOString())}), location: ${lit(event.location ?? '')} });
        cal.events.push(ev);
        'Added to ' + cal.name()`)
    },

    /** Reminders not yet done (or all of them, with `includeDone`), in every list or one. */
    async reminders(list?: string, includeDone = false): Promise<Reminder[]> {
      return (
        (await json<Reminder[]>(`
        const R = Application('Reminders');
        const wanted = ${lit(list ?? '')};
        const out = [];
        for (const l of R.lists()) {
          if (wanted && l.name().toLowerCase() !== wanted.toLowerCase()) continue;
          const items = ${includeDone ? 'l.reminders()' : 'l.reminders.whose({ completed: false })()'};
          for (const r of items.slice(0, 200)) { const due = r.dueDate(); out.push({ name: r.name(), due: due ? due.toISOString() : null, list: l.name(), completed: r.completed() }) }
        }
        JSON.stringify(out)`)) ?? []
      )
    },

    async addReminder(reminder: { name: string; due?: Date | null; list?: string; notes?: string }): Promise<string> {
      if (!reminder.name.trim()) throw new Error('Say what to be reminded of.')
      return run(`
        const R = Application('Reminders');
        const wanted = ${lit(reminder.list ?? '')};
        const list = (wanted && R.lists().find((l) => l.name().toLowerCase() === wanted.toLowerCase())) || R.defaultList();
        const props = { name: ${lit(reminder.name)}, body: ${lit(reminder.notes ?? '')} };
        ${reminder.due ? `props.dueDate = new Date(${lit(reminder.due.toISOString())});` : ''}
        list.reminders.push(R.Reminder(props));
        'Added to ' + list.name()`)
    },

    /** Ticks off the reminders called `name` (ignoring case) that aren't done yet. */
    async completeReminder(name: string): Promise<number> {
      const count = await run(`
        const R = Application('Reminders');
        const wanted = ${lit(name.trim().toLowerCase())};
        let n = 0;
        for (const l of R.lists()) for (const r of l.reminders.whose({ completed: false })()) if (r.name().toLowerCase() === wanted) { r.completed = true; n++ }
        String(n)`)
      return Number(count) || 0
    }
  }
}

export type Household = ReturnType<typeof createHousehold>
