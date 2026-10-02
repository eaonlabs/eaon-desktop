/**
 * Where a skill was found. Personal skills live in the home folder and follow
 * the user everywhere; project skills live in the Work folder and only exist
 * while that folder is open. Eaon reads Claude Code's folders too, so skills
 * written for one work in the other.
 */
export type SkillSource = 'eaon' | 'claude' | 'project-eaon' | 'project-claude'

export interface SkillInfo {
  /** From the SKILL.md frontmatter, falling back to the folder name. Also the id. */
  name: string
  description: string
  source: SkillSource
  /** The skill's folder. */
  dir: string
  /** Absolute path of its SKILL.md. */
  path: string
  /** Skills Eaon installed or created live in ~/.eaon/skills and can be removed from the app. */
  removable: boolean
}

export interface SkillDraft {
  name: string
  description: string
  /** The instructions: the SKILL.md body below the frontmatter. */
  body: string
}
