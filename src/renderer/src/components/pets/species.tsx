import type { JSX, ReactNode } from 'react'
import type { PetMood, PetSpecies } from '@shared/pets'

/*
 * Hand-drawn pets on a shared 100×100 grid: ground at y≈91, body centred on
 * x=50, head roughly a 50-unit circle around y≈44. Keeping every species on
 * the same skeleton is what lets one stylesheet animate them all — the ears,
 * tail and head of each pivot on points named in user units — and what keeps
 * the family looking like a set rather than six clip-art finds.
 *
 * House style: a single darker outline in the body's own hue (never black, so
 * it reads on light and dark themes alike), a top-lit gradient on the main
 * fills, a cream accent patch, and the same glossy eyes, blush and mouths on
 * every face.
 */

export interface Colours {
  light: string
  base: string
  shade: string
  outline: string
}

/** Where the shared face sits on a species, and how it is coloured. */
export interface FaceSpec {
  /** x of the left and right eye. */
  eyes: [number, number]
  eyeY: number
  eyeRx: number
  eyeRy: number
  mouthY: number
  mouth: 'small' | 'cat' | 'wide' | 'none'
  blushY: number
  /** How far outside each eye the blush sits. */
  blushDx: number
  browY: number
  blush: string
  brow: string
}

export interface SpeciesArt {
  label: string
  /** One line for the gallery. */
  blurb: string
  colours: Colours
  face: FaceSpec
  /** Drawn behind the body: tails, wings, gills. `head` receives the face. */
  draw: (g: (id: string) => string, face: ReactNode, mood: PetMood) => JSX.Element
}

const INK = '#2a2233'

/* ------------------------------------------------------------------ helpers */

/** Mirror a path's x coordinates about x=50, for the right-hand ear/wing/gill. */
function mirror(d: string): string {
  // Paths here are written as absolute commands with comma/space separated
  // pairs, so every even-indexed number is an x.
  let index = 0
  return d.replace(/-?\d*\.?\d+/g, (n) => {
    const out = index % 2 === 0 ? String(Math.round((100 - Number(n)) * 100) / 100) : n
    index++
    return out
  })
}

const round = { strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const }

/* --------------------------------------------------------------------- fox */

const fox: SpeciesArt = {
  label: 'Fox',
  blurb: 'Quick, curious, and very proud of its tail.',
  colours: { light: '#f8ae67', base: '#ee8a3f', shade: '#d46b25', outline: '#86411a' },
  face: {
    eyes: [39.5, 60.5],
    eyeY: 44.5,
    eyeRx: 3.4,
    eyeRy: 4.2,
    mouthY: 57.6,
    mouth: 'small',
    blushY: 51.5,
    blushDx: 5.5,
    browY: 37.8,
    blush: '#ff8f8f',
    brow: '#86411a'
  },
  draw: (g, face) => {
    const c = fox.colours
    const cream = '#fff4e6'
    const dark = '#4d2f25'
    const earL = 'M29 38 C 27 28, 27.5 18, 30.5 11.5 C 37 15, 42.5 20.5, 46 27 Z'
    const earInL = 'M31.6 32.5 C 30.8 26, 31 20.5, 32.6 16.4 C 36.4 19.2, 39.6 22.6, 41.8 26.4 Z'
    return (
      <>
        <g className="pet-tail" style={{ transformOrigin: '60px 84px' }}>
          <path
            d="M58 87 C 72 91, 89 85, 91 69 C 92.5 57, 87 46.5, 79.5 42 C 82 52, 80.5 62, 73 68.5 C 67.5 73, 62 76.5, 57 80 Z"
            fill={g('main')}
            stroke={c.outline}
            strokeWidth={2}
            {...round}
          />
          <path
            d="M79.5 42 C 84.5 45, 89.4 50, 91.2 57 C 87.6 58.6, 83.4 58, 80.9 55.6 C 81.2 50.8, 80.7 46.2, 79.5 42 Z"
            fill={cream}
          />
          <path
            d="M58 87 C 72 91, 89 85, 91 69 C 92.5 57, 87 46.5, 79.5 42"
            fill="none"
            stroke={c.outline}
            strokeWidth={2}
            {...round}
          />
        </g>
        <g className="pet-body">
          <ellipse cx={36.5} cy={84.5} rx={6.5} ry={6.2} fill={c.shade} stroke={c.outline} strokeWidth={2} />
          <ellipse cx={63.5} cy={84.5} rx={6.5} ry={6.2} fill={c.shade} stroke={c.outline} strokeWidth={2} />
          <path
            d="M35.5 90 C 31.5 82, 32.5 68, 41 62 L 59 62 C 67.5 68, 68.5 82, 64.5 90 Z"
            fill={g('main')}
            stroke={c.outline}
            strokeWidth={2}
            {...round}
          />
          <path d="M43 63 C 43.5 72, 46 80, 50 84.5 C 54 80, 56.5 72, 57 63 Z" fill={cream} />
          <ellipse cx={43.5} cy={89.4} rx={5.3} ry={3.3} fill={dark} stroke={c.outline} strokeWidth={1.6} />
          <ellipse cx={56.5} cy={89.4} rx={5.3} ry={3.3} fill={dark} stroke={c.outline} strokeWidth={1.6} />
        </g>
        <g className="pet-head" style={{ transformOrigin: '50px 62px' }}>
          <g className="pet-ear pet-ear--l" style={{ transformOrigin: '37px 32px' }}>
            <path d={earL} fill={g('main')} stroke={c.outline} strokeWidth={2} {...round} />
            <path d={earInL} fill={dark} />
          </g>
          <g className="pet-ear pet-ear--r" style={{ transformOrigin: '63px 32px' }}>
            <path d={mirror(earL)} fill={g('main')} stroke={c.outline} strokeWidth={2} {...round} />
            <path d={mirror(earInL)} fill={dark} />
          </g>
          <path
            d="M50 23 C 63 23, 72.5 30, 74.8 40 C 75.8 45, 77.8 50, 81 54 C 74 57.5, 67.5 63.5, 50 64 C 32.5 63.5, 26 57.5, 19 54 C 22.2 50, 24.2 45, 25.2 40 C 27.5 30, 37 23, 50 23 Z"
            fill={g('main')}
            stroke={c.outline}
            strokeWidth={2}
            {...round}
          />
          <path
            d="M20 54.2 C 24.5 50.6, 30 48.8, 36 49.8 C 42 50.8, 46.5 53.6, 50 57 C 53.5 53.6, 58 50.8, 64 49.8 C 70 48.8, 75.5 50.6, 80 54.2 C 73.5 57.6, 67.2 63.1, 50 63.4 C 32.8 63.1, 26.5 57.6, 20 54.2 Z"
            fill={cream}
          />
          <ellipse cx={42} cy={30.5} rx={7} ry={3.2} fill="#fff" opacity={0.2} transform="rotate(-16 42 30.5)" />
          {face}
          <path
            d="M47.2 53.4 C 48.4 52.3, 51.6 52.3, 52.8 53.4 C 52.6 55, 51.1 56.3, 50 56.3 C 48.9 56.3, 47.4 55, 47.2 53.4 Z"
            fill={dark}
          />
        </g>
      </>
    )
  }
}

/* --------------------------------------------------------------------- cat */

const cat: SpeciesArt = {
  label: 'Cat',
  blurb: 'Slate-grey, unbothered, secretly delighted to see you.',
  colours: { light: '#a4abbd', base: '#7e879b', shade: '#646c80', outline: '#3d4354' },
  face: {
    eyes: [39.8, 60.2],
    eyeY: 45,
    eyeRx: 3.6,
    eyeRy: 4.5,
    mouthY: 55.2,
    mouth: 'cat',
    blushY: 52,
    blushDx: 5.2,
    browY: 38,
    blush: '#ff9aa8',
    brow: '#3d4354'
  },
  draw: (g, face) => {
    const c = cat.colours
    const cream = '#f7f3ee'
    const pink = '#f4a7b3'
    const earL = 'M27.5 37 C 26.5 28.5, 27 20.5, 29.6 13.6 C 35.8 16, 41 20.6, 44.6 26.4 Z'
    const earInL = 'M30.5 32.6 C 30 26.6, 30.6 21.8, 32.2 18.2 C 35.8 20.2, 38.6 23, 40.6 26.2 Z'
    const tail = 'M61 87 C 76 90.5, 86.5 82, 85 70 C 84 62, 88 55.5, 93 57'
    return (
      <>
        <g className="pet-tail" style={{ transformOrigin: '61px 86px' }}>
          <path d={tail} fill="none" stroke={c.outline} strokeWidth={10.4} {...round} />
          <path d={tail} fill="none" stroke={c.base} strokeWidth={6.4} {...round} />
          <path d="M86.2 61 C 87.8 58, 90 56.6, 93 57" fill="none" stroke={c.shade} strokeWidth={6.4} {...round} />
        </g>
        <g className="pet-body">
          <ellipse cx={37} cy={84.5} rx={6.4} ry={6.2} fill={c.shade} stroke={c.outline} strokeWidth={2} />
          <ellipse cx={63} cy={84.5} rx={6.4} ry={6.2} fill={c.shade} stroke={c.outline} strokeWidth={2} />
          <path
            d="M36 90 C 32 81, 34 68, 42 63 L 58 63 C 66 68, 68 81, 64 90 Z"
            fill={g('main')}
            stroke={c.outline}
            strokeWidth={2}
            {...round}
          />
          <path d="M44 64 C 44 73.5, 46.2 81.5, 50 85.5 C 53.8 81.5, 56 73.5, 56 64 Z" fill={cream} />
          <ellipse cx={44} cy={89.4} rx={4.8} ry={3.2} fill={cream} stroke={c.outline} strokeWidth={1.6} />
          <ellipse cx={56} cy={89.4} rx={4.8} ry={3.2} fill={cream} stroke={c.outline} strokeWidth={1.6} />
        </g>
        <g className="pet-head" style={{ transformOrigin: '50px 63px' }}>
          <g className="pet-ear pet-ear--l" style={{ transformOrigin: '36px 31px' }}>
            <path d={earL} fill={g('main')} stroke={c.outline} strokeWidth={2} {...round} />
            <path d={earInL} fill={pink} />
          </g>
          <g className="pet-ear pet-ear--r" style={{ transformOrigin: '64px 31px' }}>
            <path d={mirror(earL)} fill={g('main')} stroke={c.outline} strokeWidth={2} {...round} />
            <path d={mirror(earInL)} fill={pink} />
          </g>
          <path
            d="M50 24 C 64.5 24, 75.5 32, 75.5 45 C 75.5 56.5, 64.5 64, 50 64 C 35.5 64, 24.5 56.5, 24.5 45 C 24.5 32, 35.5 24, 50 24 Z"
            fill={g('main')}
            stroke={c.outline}
            strokeWidth={2}
            {...round}
          />
          <g stroke={c.shade} strokeWidth={2.2} {...round}>
            <path d="M50 25.8 L 50 31" />
            <path d="M44.6 26.8 L 45.6 30.8" />
            <path d="M55.4 26.8 L 54.4 30.8" />
          </g>
          <ellipse cx={42} cy={31.5} rx={6.5} ry={3} fill="#fff" opacity={0.18} transform="rotate(-16 42 31.5)" />
          <ellipse cx={50} cy={55.4} rx={8.8} ry={5.6} fill={cream} />
          <g stroke={c.outline} strokeWidth={0.9} opacity={0.5} {...round}>
            <path d="M37.5 54.6 L 28 53" />
            <path d="M37.8 57 L 28.6 58.6" />
            <path d="M62.5 54.6 L 72 53" />
            <path d="M62.2 57 L 71.4 58.6" />
          </g>
          {face}
          <path d="M47.9 51.6 L 52.1 51.6 L 50 54 Z" fill={pink} stroke={pink} strokeWidth={1.2} {...round} />
        </g>
      </>
    )
  }
}

/* ----------------------------------------------------------------- axolotl */

const axolotl: SpeciesArt = {
  label: 'Axolotl',
  blurb: 'Permanently smiling. Regrows its patience daily.',
  colours: { light: '#fdcadd', base: '#f6a8c6', shade: '#e585ab', outline: '#a8466f' },
  face: {
    eyes: [37, 63],
    eyeY: 46.5,
    eyeRx: 3.2,
    eyeRy: 3.9,
    mouthY: 53.6,
    mouth: 'wide',
    blushY: 52.4,
    blushDx: 5,
    browY: 40.5,
    blush: '#ff7fa6',
    brow: '#a8466f'
  },
  draw: (g, face) => {
    const c = axolotl.colours
    const gill = '#e4679a'
    const gillLight = '#f591ba'
    const belly = '#ffe1ec'
    const fronds = ['M27 38.5 Q 20 33 15.5 26', 'M24.5 45 Q 17 44 10.5 40.5', 'M25.5 51.5 Q 18 54.5 12 57']
    const frond = (d: string, key: string): JSX.Element => (
      <g key={key}>
        <path d={d} fill="none" stroke={c.outline} strokeWidth={8.2} {...round} />
        <path d={d} fill="none" stroke={gill} strokeWidth={5.2} {...round} />
        <path d={d} fill="none" stroke={gillLight} strokeWidth={1.8} {...round} />
      </g>
    )
    return (
      <>
        <g className="pet-tail" style={{ transformOrigin: '60px 82px' }}>
          <path
            d="M58 86 C 70 89.5, 84.5 87, 92.5 76 C 86 76.8, 80 75.6, 74.5 71.5 C 70.5 76, 64 79, 58 80 Z"
            fill={gillLight}
            stroke={c.outline}
            strokeWidth={2}
            {...round}
          />
        </g>
        <g className="pet-body">
          <path
            d="M35 90 C 31 81, 34 69, 42 65 L 58 65 C 66 69, 69 81, 65 90 Z"
            fill={g('main')}
            stroke={c.outline}
            strokeWidth={2}
            {...round}
          />
          <path d="M42.5 67 C 42.5 77, 45.5 84.5, 50 87 C 54.5 84.5, 57.5 77, 57.5 67 Z" fill={belly} />
          <ellipse cx={42.5} cy={89.3} rx={4.6} ry={3.1} fill={c.base} stroke={c.outline} strokeWidth={1.6} />
          <ellipse cx={57.5} cy={89.3} rx={4.6} ry={3.1} fill={c.base} stroke={c.outline} strokeWidth={1.6} />
        </g>
        <g className="pet-head" style={{ transformOrigin: '50px 64px' }}>
          <g className="pet-ear pet-ear--l pet-gills" style={{ transformOrigin: '26px 46px' }}>
            {fronds.map((d, i) => frond(d, `l${i}`))}
          </g>
          <g className="pet-ear pet-ear--r pet-gills" style={{ transformOrigin: '74px 46px' }}>
            {fronds.map((d, i) => frond(mirror(d), `r${i}`))}
          </g>
          <path
            d="M50 28.5 C 67.5 28.5, 79 36.5, 79 47.2 C 79 57.8, 67 64.6, 50 64.6 C 33 64.6, 21 57.8, 21 47.2 C 21 36.5, 32.5 28.5, 50 28.5 Z"
            fill={g('main')}
            stroke={c.outline}
            strokeWidth={2}
            {...round}
          />
          <ellipse cx={40} cy={34.5} rx={8} ry={3.2} fill="#fff" opacity={0.26} transform="rotate(-10 40 34.5)" />
          <g fill={c.shade} opacity={0.7}>
            <circle cx={45.5} cy={33.2} r={0.95} />
            <circle cx={50} cy={32} r={1.1} />
            <circle cx={54.5} cy={33.2} r={0.95} />
          </g>
          {face}
        </g>
      </>
    )
  }
}

/* --------------------------------------------------------------------- owl */

const owl: SpeciesArt = {
  label: 'Owl',
  blurb: 'Wise-looking. Mostly just thinking about snacks.',
  colours: { light: '#b98a64', base: '#9b6b4c', shade: '#7c5236', outline: '#4c3020' },
  face: {
    eyes: [40, 60],
    eyeY: 43.5,
    eyeRx: 4.3,
    eyeRy: 5,
    mouthY: 0,
    mouth: 'none',
    blushY: 52,
    blushDx: 4.2,
    browY: 35.6,
    blush: '#ff9d8a',
    brow: '#4c3020'
  },
  draw: (g, face) => {
    const c = owl.colours
    const disc = '#f8e9d4'
    const belly = '#efd8ba'
    const beak = '#f2a93b'
    const tuftL = 'M27 32 C 24 26, 22 19.5, 22.5 13 C 28.5 16.5, 33.5 21.5, 36.5 26.5 Z'
    const wingL = 'M21.6 50 C 14.6 58, 15 72.5, 24.5 82.5 C 28.5 74, 29.4 62, 27.2 52 Z'
    const chevron = (x: number, y: number): JSX.Element => (
      <path key={`${x}-${y}`} d={`M${x - 2.3} ${y - 1} L ${x} ${y + 1.1} L ${x + 2.3} ${y - 1}`} />
    )
    return (
      <>
        <g className="pet-body">
          <ellipse cx={43} cy={90.2} rx={4.2} ry={2.3} fill={beak} stroke="#b56f14" strokeWidth={1.4} />
          <ellipse cx={57} cy={90.2} rx={4.2} ry={2.3} fill={beak} stroke="#b56f14" strokeWidth={1.4} />
          <path
            d="M50 20 C 69.5 20, 80.5 35, 80.5 55.5 C 80.5 75.5, 68 89.5, 50 89.5 C 32 89.5, 19.5 75.5, 19.5 55.5 C 19.5 35, 30.5 20, 50 20 Z"
            fill={g('main')}
            stroke={c.outline}
            strokeWidth={2}
            {...round}
          />
          <path d="M33.5 63 C 34 55, 66 55, 66.5 63 C 66.5 76.5, 60 86, 50 86 C 40 86, 33.5 76.5, 33.5 63 Z" fill={belly} />
          <g fill="none" stroke={c.shade} strokeWidth={1.3} opacity={0.75} {...round}>
            {chevron(44, 66)}
            {chevron(56, 66)}
            {chevron(50, 71.5)}
            {chevron(43.5, 77)}
            {chevron(56.5, 77)}
          </g>
          <g className="pet-wing pet-wing--l" style={{ transformOrigin: '25px 52px' }}>
            <path d={wingL} fill={c.shade} stroke={c.outline} strokeWidth={2} {...round} />
          </g>
          <g className="pet-wing pet-wing--r" style={{ transformOrigin: '75px 52px' }}>
            <path d={mirror(wingL)} fill={c.shade} stroke={c.outline} strokeWidth={2} {...round} />
          </g>
        </g>
        <g className="pet-head" style={{ transformOrigin: '50px 60px' }}>
          <g className="pet-ear pet-ear--l" style={{ transformOrigin: '31px 28px' }}>
            <path d={tuftL} fill={c.shade} stroke={c.outline} strokeWidth={2} {...round} />
          </g>
          <g className="pet-ear pet-ear--r" style={{ transformOrigin: '69px 28px' }}>
            <path d={mirror(tuftL)} fill={c.shade} stroke={c.outline} strokeWidth={2} {...round} />
          </g>
          <path
            d="M50 36.4 C 46.5 32.5, 43 31, 39.5 31 C 32.2 31, 27.2 36.6, 27.2 43.6 C 27.2 50.8, 32.6 56, 39.6 56 C 44 56, 47.6 54, 50 51 C 52.4 54, 56 56, 60.4 56 C 67.4 56, 72.8 50.8, 72.8 43.6 C 72.8 36.6, 67.8 31, 60.5 31 C 57 31, 53.5 32.5, 50 36.4 Z"
            fill={disc}
            stroke={c.outline}
            strokeWidth={1.4}
            strokeOpacity={0.35}
          />
          <ellipse cx={39} cy={27} rx={6} ry={2.6} fill="#fff" opacity={0.18} transform="rotate(-14 39 27)" />
          {face}
          <path
            d="M46.8 49 C 48.4 47.9, 51.6 47.9, 53.2 49 L 50 55.2 Z"
            fill={beak}
            stroke="#b56f14"
            strokeWidth={1.2}
            {...round}
          />
        </g>
      </>
    )
  }
}

/* ------------------------------------------------------------------- slime */

const slime: SpeciesArt = {
  label: 'Slime',
  blurb: 'Squishy, cheerful, grows a little sprout when content.',
  colours: { light: '#b2f3d7', base: '#6fdcb1', shade: '#3dbd8f', outline: '#237f60' },
  face: {
    eyes: [40.8, 59.2],
    eyeY: 64,
    eyeRx: 3.4,
    eyeRy: 4.3,
    mouthY: 71.8,
    mouth: 'small',
    blushY: 70.4,
    blushDx: 5,
    browY: 57.2,
    blush: '#ff8fa3',
    brow: '#237f60'
  },
  draw: (g, face) => {
    const c = slime.colours
    const leaf = '#63c46a'
    const leafDark = '#2f8a48'
    return (
      <>
        <g className="pet-head" style={{ transformOrigin: '50px 91px' }}>
          <g className="pet-ear pet-sprout" style={{ transformOrigin: '50px 41px' }}>
            <path d="M50 42 C 50 38, 50.6 34.6, 51.8 31.4" fill="none" stroke={leafDark} strokeWidth={2.2} {...round} />
            <path
              d="M51.2 33.4 C 46.4 33.6, 43 30.8, 42 26.6 C 46.8 25.8, 50.2 28.6, 51.2 33.4 Z"
              fill={leaf}
              stroke={leafDark}
              strokeWidth={1.5}
              {...round}
            />
            <path
              d="M51.8 32 C 55 28.6, 59.2 27.6, 63 29.2 C 60.4 33.2, 55.8 34.2, 51.8 32 Z"
              fill={leaf}
              stroke={leafDark}
              strokeWidth={1.5}
              {...round}
            />
          </g>
          <path
            d="M16.5 87.5 C 14.5 70, 27.5 41.5, 50 40 C 72.5 41.5, 85.5 70, 83.5 87.5 C 83.2 91.2, 79.5 92.4, 74.6 91.6 C 67 90.4, 60 92.4, 50 92.4 C 40 92.4, 33 90.4, 25.4 91.6 C 20.5 92.4, 16.8 91.2, 16.5 87.5 Z"
            fill={g('main')}
            stroke={c.outline}
            strokeWidth={2}
            {...round}
          />
          <ellipse cx={50} cy={80} rx={25} ry={9} fill="#fff" opacity={0.14} />
          <ellipse cx={32.5} cy={56.5} rx={6.4} ry={3.2} fill="#fff" opacity={0.75} transform="rotate(-38 32.5 56.5)" />
          <circle cx={27.4} cy={64.4} r={1.7} fill="#fff" opacity={0.65} />
          {face}
        </g>
      </>
    )
  }
}

/* ------------------------------------------------------------------ dragon */

const dragon: SpeciesArt = {
  label: 'Dragon',
  blurb: 'Tiny, fierce, has never once set anything on fire.',
  colours: { light: '#ab9ef5', base: '#8b7aea', shade: '#6d5bd0', outline: '#41338f' },
  face: {
    eyes: [40, 60],
    eyeY: 43.8,
    eyeRx: 3.6,
    eyeRy: 4.4,
    mouthY: 57,
    mouth: 'small',
    blushY: 50.6,
    blushDx: 5.4,
    browY: 37,
    blush: '#ff94b8',
    brow: '#41338f'
  },
  draw: (g, face) => {
    const c = dragon.colours
    const belly = '#ffe7c0'
    const bellyLine = '#eecb90'
    const horn = '#ffe2a6'
    const hornLine = '#c99a45'
    const wing = '#bdb1fb'
    const tail = 'M61 87 C 75 90.5, 87.5 84.5, 88 72'
    const wingL =
      'M38.5 64 C 31 55.5, 21 51.5, 12 54.5 C 14.6 57.6, 15.2 61, 14.6 64.4 C 18.2 62.6, 21.4 63.6, 23 66.2 C 25.6 64.6, 28.6 65.6, 30 68.4 C 32.8 67.2, 35.8 67.8, 38.5 69.5 Z'
    const hornL = 'M37 30 C 34.6 25, 34 19, 36.6 13.4 C 39.6 18, 42.6 23, 43.6 27.6 Z'
    const frillL = 'M26.6 43.4 C 22 40.6, 17.8 40.6, 15.2 43.4 C 18.8 45, 21.4 47.6, 26.4 49.2 Z'
    return (
      <>
        <g className="pet-tail" style={{ transformOrigin: '61px 86px' }}>
          <path d={tail} fill="none" stroke={c.outline} strokeWidth={10.4} {...round} />
          <path d={tail} fill="none" stroke={c.base} strokeWidth={6.4} {...round} />
          <path
            d="M88 60.6 C 90.6 63.6, 93.8 66.8, 93.8 70.6 C 91.2 70.2, 89.6 70.8, 88 72.8 C 86.4 70.8, 84.8 70.2, 82.2 70.6 C 82.2 66.8, 85.4 63.6, 88 60.6 Z"
            fill={c.shade}
            stroke={c.outline}
            strokeWidth={2}
            {...round}
          />
        </g>
        <g className="pet-wing pet-wing--l" style={{ transformOrigin: '38px 65px' }}>
          <path d={wingL} fill={wing} stroke={c.outline} strokeWidth={2} {...round} />
          <g stroke={c.base} strokeWidth={1.2} {...round}>
            <path d="M37.5 65 L 14.6 64" />
            <path d="M37.5 66.2 L 23 66" />
            <path d="M37.5 67.4 L 30 68.2" />
          </g>
        </g>
        <g className="pet-wing pet-wing--r" style={{ transformOrigin: '62px 65px' }}>
          <path d={mirror(wingL)} fill={wing} stroke={c.outline} strokeWidth={2} {...round} />
          <g stroke={c.base} strokeWidth={1.2} {...round}>
            <path d={mirror('M37.5 65 L 14.6 64')} />
            <path d={mirror('M37.5 66.2 L 23 66')} />
            <path d={mirror('M37.5 67.4 L 30 68.2')} />
          </g>
        </g>
        <g className="pet-body">
          <ellipse cx={37} cy={84.5} rx={6.4} ry={6.2} fill={c.shade} stroke={c.outline} strokeWidth={2} />
          <ellipse cx={63} cy={84.5} rx={6.4} ry={6.2} fill={c.shade} stroke={c.outline} strokeWidth={2} />
          <path
            d="M36 90 C 32 81, 34 68, 42 63 L 58 63 C 66 68, 68 81, 64 90 Z"
            fill={g('main')}
            stroke={c.outline}
            strokeWidth={2}
            {...round}
          />
          <path d="M43 64.5 C 42.5 74, 45 83, 50 87 C 55 83, 57.5 74, 57 64.5 Z" fill={belly} />
          <g fill="none" stroke={bellyLine} strokeWidth={1.3} {...round}>
            <path d="M44 70 Q 50 71.6 56 70" />
            <path d="M44.6 76 Q 50 77.6 55.4 76" />
            <path d="M46.4 82 Q 50 83.2 53.6 82" />
          </g>
          <ellipse cx={44} cy={89.4} rx={4.8} ry={3.2} fill={c.base} stroke={c.outline} strokeWidth={1.6} />
          <ellipse cx={56} cy={89.4} rx={4.8} ry={3.2} fill={c.base} stroke={c.outline} strokeWidth={1.6} />
        </g>
        <g className="pet-head" style={{ transformOrigin: '50px 62px' }}>
          <g className="pet-ear pet-ear--l" style={{ transformOrigin: '38px 28px' }}>
            <path d={hornL} fill={horn} stroke={hornLine} strokeWidth={1.8} {...round} />
          </g>
          <g className="pet-ear pet-ear--r" style={{ transformOrigin: '62px 28px' }}>
            <path d={mirror(hornL)} fill={horn} stroke={hornLine} strokeWidth={1.8} {...round} />
          </g>
          <path d={frillL} fill={wing} stroke={c.outline} strokeWidth={1.8} {...round} />
          <path d={mirror(frillL)} fill={wing} stroke={c.outline} strokeWidth={1.8} {...round} />
          <path
            d="M50 24 C 64 24, 74 32, 74 44 C 74 56, 64 63, 50 63 C 36 63, 26 56, 26 44 C 26 32, 36 24, 50 24 Z"
            fill={g('main')}
            stroke={c.outline}
            strokeWidth={2}
            {...round}
          />
          <ellipse cx={42} cy={30.5} rx={6.6} ry={3} fill="#fff" opacity={0.2} transform="rotate(-16 42 30.5)" />
          <ellipse cx={50} cy={53.6} rx={9.4} ry={5.8} fill={c.light} opacity={0.9} />
          <circle cx={47.2} cy={52.2} r={0.95} fill={c.outline} />
          <circle cx={52.8} cy={52.2} r={0.95} fill={c.outline} />
          {face}
        </g>
      </>
    )
  }
}

export const SPECIES: Record<PetSpecies, SpeciesArt> = { fox, cat, axolotl, owl, slime, dragon }

/* -------------------------------------------------------------------- face */

/** Glossy eyes, brows, mouth and blush, drawn the same way on every species. */
export function Face({ spec, mood }: { spec: FaceSpec; mood: PetMood }): JSX.Element {
  const [lx, rx] = spec.eyes
  const { eyeY: y, eyeRx: erx, eyeRy: ery } = spec
  const closedHappy = mood === 'happy' || mood === 'petted'
  const asleep = mood === 'asleep'
  const squint = mood === 'working' ? 0.82 : mood === 'concerned' ? 0.92 : 1

  const eye = (x: number, key: string): JSX.Element => {
    if (closedHappy)
      return (
        <path
          key={key}
          d={`M${x - erx} ${y + 1.2} Q ${x} ${y - ery * 1.15} ${x + erx} ${y + 1.2}`}
          fill="none"
          stroke={INK}
          strokeWidth={2.1}
          strokeLinecap="round"
        />
      )
    if (asleep)
      return (
        <path
          key={key}
          d={`M${x - erx} ${y} Q ${x} ${y + ery * 0.95} ${x + erx} ${y}`}
          fill="none"
          stroke={INK}
          strokeWidth={2}
          strokeLinecap="round"
        />
      )
    return (
      <g key={key} className="pet-eye">
        <ellipse cx={x} cy={y} rx={erx} ry={ery * squint} fill={INK} />
        <g className="pet-look">
          <circle cx={x + erx * 0.34} cy={y - ery * 0.36 * squint} r={erx * 0.42} fill="#fff" />
          <circle cx={x - erx * 0.36} cy={y + ery * 0.4 * squint} r={erx * 0.18} fill="#fff" opacity={0.8} />
        </g>
      </g>
    )
  }

  const brows = (): JSX.Element | null => {
    if (mood !== 'working' && mood !== 'concerned') return null
    // Working: inner ends down — determined. Concerned: inner ends up — worried.
    const tilt = mood === 'working' ? 1.4 : -1.6
    const b = spec.browY
    return (
      <g fill="none" stroke={spec.brow} strokeWidth={1.9} strokeLinecap="round">
        <path d={`M${lx - 3.6} ${b - tilt} L ${lx + 3} ${b + tilt}`} />
        <path d={`M${rx + 3.6} ${b - tilt} L ${rx - 3} ${b + tilt}`} />
      </g>
    )
  }

  const mouth = (): JSX.Element | null => {
    if (spec.mouth === 'none') return null
    const m = spec.mouthY
    const w = spec.mouth === 'wide' ? 1.7 : 1
    const line = { fill: 'none', stroke: INK, strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
    if (closedHappy)
      return (
        <g>
          <path d={`M${50 - 3.4 * w} ${m - 0.6} Q 50 ${m + 5.6} ${50 + 3.4 * w} ${m - 0.6} Z`} fill={INK} strokeLinejoin="round" stroke={INK} strokeWidth={1} />
          <ellipse cx={50} cy={m + 2.5} rx={1.9 * w} ry={1.1} fill="#ff8aa1" />
        </g>
      )
    if (asleep) return <ellipse cx={50} cy={m + 0.8} rx={1.3} ry={1.1} fill={INK} opacity={0.85} />
    if (mood === 'concerned')
      return <path d={`M${50 - 3 * w} ${m + 1.4} Q ${50 - 1.5 * w} ${m - 0.4} 50 ${m + 1} Q ${50 + 1.5 * w} ${m + 2.4} ${50 + 3 * w} ${m + 0.8}`} {...line} />
    if (mood === 'thinking') return <path d={`M${50 - 1.6 * w} ${m + 1} Q 50.6 ${m - 0.2} ${50 + 2.6 * w} ${m + 0.4}`} {...line} />
    if (mood === 'working')
      return (
        <g>
          <ellipse cx={50 + 1.6 * w} cy={m + 1.5} rx={1.3} ry={1.2} fill="#ff8aa1" />
          <path d={`M${50 - 2.4 * w} ${m + 0.6} L ${50 + 2.4 * w} ${m + 0.6}`} {...line} />
        </g>
      )
    if (spec.mouth === 'cat')
      return <path d={`M46 ${m} Q 48 ${m + 2.6} 50 ${m} Q 52 ${m + 2.6} 54 ${m}`} {...line} />
    return <path d={`M${50 - 2.8 * w} ${m} Q 50 ${m + 2.6} ${50 + 2.8 * w} ${m}`} {...line} />
  }

  const blush = mood === 'petted' || mood === 'happy' ? 0.85 : 0.5
  return (
    <g className="pet-face">
      <ellipse cx={lx - spec.blushDx} cy={spec.blushY} rx={3.6} ry={2.1} fill={spec.blush} opacity={blush} />
      <ellipse cx={rx + spec.blushDx} cy={spec.blushY} rx={3.6} ry={2.1} fill={spec.blush} opacity={blush} />
      {brows()}
      <g className="pet-eyes">
        {eye(lx, 'l')}
        {eye(rx, 'r')}
      </g>
      {mouth()}
    </g>
  )
}
