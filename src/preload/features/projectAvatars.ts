import { ipcRenderer } from 'electron'

/** Renderer bridge for projects' pictures (main/features/projectAvatars.ts). Exposed as `window.api.projectAvatars`. */
export const projectAvatarsApi = {
  /** The picture of whoever owns the folder's repository on GitHub, GitLab, Codeberg or Bitbucket, as a data: URL; null when there's none. */
  get: (folder: string): Promise<string | null> => ipcRenderer.invoke('project-avatars:get', folder)
}
