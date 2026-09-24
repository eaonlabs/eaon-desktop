import { useState, type JSX } from 'react'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Segmented, Switch } from '../../ui'
import { PetSprite } from '../../pets/PetSprite'
import { SPECIES } from '../../pets/species'
import { isSpecies, PET_SPECIES, type PetMood, type PetSize } from '@shared/pets'

const MOODS: { value: PetMood; label: string }[] = [
  { value: 'idle', label: 'Idle' },
  { value: 'thinking', label: 'Thinking' },
  { value: 'working', label: 'Working' },
  { value: 'happy', label: 'Happy' },
  { value: 'concerned', label: 'Worried' },
  { value: 'asleep', label: 'Asleep' },
  { value: 'petted', label: 'Petted' }
]

export function PetsPage(): JSX.Element {
  const pets = useApp((s) => s.settings?.pets)
  const patchSettings = useApp((s) => s.patchSettings)
  const [mood, setMood] = useState<PetMood>('idle')
  if (!pets) return <></>

  const species = isSpecies(pets.species) ? pets.species : 'fox'
  const set = (patch: Partial<typeof pets>): void => void patchSettings({ pets: patch })

  return (
    <>
      <h1 className="settings__h1">Pets</h1>

      <Section>
        <Card>
          <Row
            title="Show a pet"
            description="A small companion in the corner of the window. It thinks while Eaon replies, gets busy while tools run and dozes off when things go quiet."
          >
            <Switch label="Show a pet" checked={pets.enabled} onChange={(enabled) => set({ enabled })} />
          </Row>
        </Card>
      </Section>

      <Section label="Moods">
        <div className="pet-stage">
          <div className="pet-stage__pet">
            <PetSprite species={species} mood={mood} />
          </div>
          <Segmented value={mood} options={MOODS} onChange={setMood} />
        </div>
      </Section>

      <Section label="Species">
        <div className="pet-gallery">
          {PET_SPECIES.map((id) => (
            <button
              key={id}
              type="button"
              className="pet-card"
              data-active={species === id || undefined}
              aria-pressed={species === id}
              onClick={() => set({ species: id })}
            >
              <span className="pet-card__pet">
                <PetSprite species={id} mood="idle" />
              </span>
              <span className="pet-card__name">{SPECIES[id].label}</span>
              <span className="pet-card__blurb">{SPECIES[id].blurb}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section label="Your pet">
        <Card>
          <Row title="Name" description="Shown when you hover over your pet">
            <input
              className="input"
              style={{ width: 160 }}
              value={pets.name}
              maxLength={24}
              placeholder={SPECIES[species].label}
              spellCheck={false}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Row>
          <Row title="Size">
            <Segmented<PetSize>
              value={pets.size}
              onChange={(size) => set({ size })}
              options={[
                { value: 'small', label: 'Small' },
                { value: 'medium', label: 'Medium' },
                { value: 'large', label: 'Large' }
              ]}
            />
          </Row>
          <Row
            title="Float on desktop"
            description="Keep your pet on top of every window, even while Eaon is in the background. Clicks pass through everywhere except the pet."
          >
            <Switch
              label="Float on desktop"
              checked={pets.desktop}
              dimmed={!pets.enabled}
              onChange={(desktop) => set({ desktop })}
            />
          </Row>
        </Card>
      </Section>
    </>
  )
}
