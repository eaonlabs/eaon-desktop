/**
 * A worker's body: the shape its face is drawn in. The eyes are the same on
 * every body; each shape says where they sit and how big they are, so a heart
 * keeps its eyes in its lobes and a star in its middle.
 *
 * Paths are on the face's 100×100 grid. Shapes that are easier to compute
 * than to write out (the flower, the star) are built once at load.
 */

export type WorkerShape = 'pebble' | 'blob' | 'bun' | 'capsule' | 'ghost' | 'gumdrop' | 'flower' | 'gem' | 'star' | 'heart'

export interface ShapeSpec {
  id: WorkerShape
  label: string
  /** The body's outline. */
  path: string
  /** Eye centres, left then right, and the eyes' size against the round body's. */
  eyes: { x: [number, number]; y: number; scale: number }
}

const round = (n: number): string => (Math.round(n * 100) / 100).toString()

/** A circle with `bumps` scallops round its edge: each bump an arc bulging out between two points on the rim. */
function scalloped(bumps: number, radius: number): string {
  const points = Array.from({ length: bumps }, (_, i) => {
    const angle = (i / bumps) * Math.PI * 2 - Math.PI / 2
    return [50 + Math.cos(angle) * radius, 50 + Math.sin(angle) * radius]
  })
  const chord = 2 * radius * Math.sin(Math.PI / bumps)
  const bulge = round(chord * 0.56)
  let d = `M ${round(points[0][0])} ${round(points[0][1])}`
  for (let i = 1; i <= bumps; i++) {
    const [x, y] = points[i % bumps]
    d += ` A ${bulge} ${bulge} 0 0 1 ${round(x)} ${round(y)}`
  }
  return `${d} Z`
}

/** A star with `points` points whose tips and dips are rounded with quadratic curves. */
function softStar(points: number, outer: number, inner: number, cy = 52): string {
  const vertices: [number, number][] = []
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner
    const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2
    vertices.push([50 + Math.cos(angle) * r, cy + Math.sin(angle) * r])
  }
  const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const start = mid(vertices[vertices.length - 1], vertices[0])
  let d = `M ${round(start[0])} ${round(start[1])}`
  vertices.forEach((v, i) => {
    const next = mid(v, vertices[(i + 1) % vertices.length])
    d += ` Q ${round(v[0])} ${round(v[1])} ${round(next[0])} ${round(next[1])}`
  })
  return `${d} Z`
}

export const WORKER_SHAPES: ShapeSpec[] = [
  { id: 'pebble', label: 'Pebble', path: 'M 50 0 A 50 50 0 1 1 49.99 0 Z', eyes: { x: [33.3, 66.7], y: 40, scale: 1 } },
  {
    id: 'blob',
    label: 'Blob',
    path: 'M 52 4 C 80 2 98 22 96 50 C 94 76 78 96 50 96 C 22 96 2 80 4 52 C 6 22 24 6 52 4 Z',
    eyes: { x: [34, 66], y: 42, scale: 0.98 }
  },
  {
    id: 'bun',
    label: 'Bun',
    path: 'M 50 4 C 86 4 96 14 96 50 C 96 86 86 96 50 96 C 14 96 4 86 4 50 C 4 14 14 4 50 4 Z',
    eyes: { x: [33, 67], y: 42, scale: 1 }
  },
  {
    id: 'capsule',
    label: 'Capsule',
    path: 'M 16 34 A 34 34 0 0 1 84 34 L 84 66 A 34 34 0 0 1 16 66 Z',
    eyes: { x: [37, 63], y: 40, scale: 0.86 }
  },
  {
    id: 'ghost',
    label: 'Ghost',
    path:
      'M 8 50 A 42 42 0 0 1 92 50 L 92 90 Q 85 99 78 90 Q 71 81 64 90 Q 57 99 50 90 Q 43 81 36 90 Q 29 99 22 90 Q 15 81 8 90 Z',
    eyes: { x: [35, 65], y: 46, scale: 0.92 }
  },
  {
    id: 'gumdrop',
    label: 'Gumdrop',
    path: 'M 8 90 C 2 58 20 6 50 6 C 80 6 98 58 92 90 Q 50 99 8 90 Z',
    eyes: { x: [36, 64], y: 52, scale: 0.9 }
  },
  { id: 'flower', label: 'Flower', path: scalloped(9, 41), eyes: { x: [35, 65], y: 46, scale: 0.86 } },
  {
    id: 'gem',
    label: 'Gem',
    path: 'M 50 4 Q 56 4 60 9 L 93 44 Q 98 50 93 56 L 60 91 Q 56 96 50 96 Q 44 96 40 91 L 7 56 Q 2 50 7 44 L 40 9 Q 44 4 50 4 Z',
    eyes: { x: [38, 62], y: 46, scale: 0.78 }
  },
  { id: 'star', label: 'Star', path: softStar(5, 52, 30), eyes: { x: [40, 60], y: 50, scale: 0.64 } },
  {
    id: 'heart',
    label: 'Heart',
    path: 'M 50 94 C 22 74 3 58 3 35 C 3 18 15 6 30 6 C 40 6 47 12 50 20 C 53 12 60 6 70 6 C 85 6 97 18 97 35 C 97 58 78 74 50 94 Z',
    eyes: { x: [32, 68], y: 38, scale: 0.86 }
  }
]

export const DEFAULT_SHAPE: WorkerShape = 'pebble'

const BY_ID = new Map(WORKER_SHAPES.map((s) => [s.id, s]))

export function shapeSpec(shape: string | undefined | null): ShapeSpec {
  return BY_ID.get(shape as WorkerShape) ?? BY_ID.get(DEFAULT_SHAPE)!
}

export function isWorkerShape(value: unknown): value is WorkerShape {
  return typeof value === 'string' && BY_ID.has(value as WorkerShape)
}
