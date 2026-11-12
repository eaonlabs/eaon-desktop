/**
 * Stands in for the ELK layout library (electron.vite.config.ts aliases
 * `elkjs/lib/elk.bundled.js` to this). Mermaid's default layout does not use
 * it; only a diagram that asks for `layout: elk` does, and that diagram then
 * fails to draw and stays a code block. Leaving the real one out of the build
 * saves over 3 MB, and it is the one library in the build under the Eclipse
 * Public License.
 */
export default class ElkNotIncluded {
  constructor() {
    throw new Error('The ELK diagram layout is not included in Eaon.')
  }
}
