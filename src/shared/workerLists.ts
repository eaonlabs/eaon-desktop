/** A shared household list (groceries, supplies, chores) — see main/features/workers/lists.ts. */
export interface HouseholdListItem {
  id: string
  text: string
  done: boolean
  /** Who added it: "You" or a worker's name. */
  by: string
  at: number
}

export interface HouseholdList {
  id: string
  name: string
  items: HouseholdListItem[]
  updatedAt: number
}

export const MAX_LISTS = 30
export const MAX_LIST_ITEMS = 200
