import { ExternalLink, Heart } from 'lucide-react'
import { Card, Row, Section } from '../../ui'

/**
 * Settings → General → Credits. Who made Eaon and where, who helped, and what
 * it stands on. Contributors are from the repository's history
 * (github.com/eaonlabs/eaon-desktop/graphs/contributors); add a line here when
 * a new person's work is merged.
 */

interface Person {
  handle: string
  /** What they did, in a few words. */
  role: string
}

const PEOPLE: Person[] = [
  { handle: 'sanscreates', role: 'Creator and maintainer' },
  { handle: 'YoannDev90', role: 'Linux AppImage fixes' },
  { handle: 'morriszdweck', role: 'README and docs' }
]

interface Project {
  name: string
  url: string
  what: string
}

/** What Eaon is built on. OpenCode and llama.cpp are MIT-licensed; their notices are in NOTICE. */
const PROJECTS: Project[] = [
  { name: 'llama.cpp', url: 'https://github.com/ggml-org/llama.cpp', what: 'Runs your downloaded models' },
  { name: 'OpenCode', url: 'https://github.com/sst/opencode', what: 'Eaon CLI is a fork of it' },
  { name: 'Electron', url: 'https://www.electronjs.org', what: 'The app shell' },
  { name: 'React', url: 'https://react.dev', what: 'The interface' },
  { name: 'xterm.js', url: 'https://xtermjs.org', what: 'The ADE’s terminals' },
  { name: 'Model Context Protocol', url: 'https://modelcontextprotocol.io', what: 'Plugins and the control API' },
  { name: 'Hugging Face', url: 'https://huggingface.co', what: 'Where open models are downloaded from' }
]

const open = (url: string): void => void window.api.app.openExternal(url)

export function CreditsSection(): JSX.Element {
  return (
    <Section label="Credits">
      <div className="credits-hero">
        <p className="credits-hero__line">
          Made with
          <Heart className="credits-heart" size={20} strokeWidth={0} fill="currentColor" role="img" aria-label="love" />
          in California and New York
        </p>
        <p className="credits-hero__sub">Free software, under the GPL-3.0.</p>
      </div>

      <div className="credits-label">With thanks to</div>
      <Card>
        {PEOPLE.map((person) => (
          <Row
            key={person.handle}
            title={
              <span className="credits-person">
                <span className="credits-avatar" aria-hidden="true">
                  {person.handle.charAt(0).toUpperCase()}
                </span>
                {person.handle}
              </span>
            }
            description={person.role}
          >
            <button className="icon-btn" aria-label={`${person.handle} on GitHub`} onClick={() => open(`https://github.com/${person.handle}`)}>
              <ExternalLink size={15} strokeWidth={1.9} />
            </button>
          </Row>
        ))}
        <Row title="Want to be on this list?" description="Contributions are welcome. A pull request, a fix, or a better doc all count.">
          <button className="btn btn--ghost btn--sm" onClick={() => open('https://github.com/eaonlabs/eaon-desktop')}>
            Open the repository
            <ExternalLink size={13} strokeWidth={1.9} />
          </button>
        </Row>
      </Card>

      <div className="credits-label">Built on</div>
      <div className="credits-projects">
        {PROJECTS.map((project) => (
          <button key={project.name} className="credits-project" onClick={() => open(project.url)} title={project.url}>
            <span className="credits-project__name">{project.name}</span>
            <span className="credits-project__what">{project.what}</span>
          </button>
        ))}
      </div>
    </Section>
  )
}
