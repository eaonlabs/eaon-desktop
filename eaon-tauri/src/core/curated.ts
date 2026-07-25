// Typed access to the curated Ollama catalog (assets/CuratedOllamaModels.json)
// — the hand-picked model library the Models page renders, same data as the
// Mac app's CuratedOllamaModels. The JSON is pure data; this module is its
// contract: the shapes, the categories in the JSON's own display order, and
// the RAM fit heuristic the download buttons badge with.

import catalog from "../assets/CuratedOllamaModels.json";
import type { FitVerdict } from "./types";

export type { FitVerdict } from "./types";

/** One curated model card. */
export interface CuratedModel {
  /** The Ollama tag to pull, e.g. "qwen3.6" or "llama4:maverick". */
  name: string;
  /** One-line pitch shown under the name. */
  blurb: string;
  /** Pre-formatted "≈24 GB" label (kept alongside sizeBytes so display
   *  never drifts from what the curator wrote). */
  approxSize: string;
  sizeBytes: number;
  /** Key into brand.ts's CATALOG_BRANDS — null for entries with no mark. */
  brand: string | null;
  category: string;
  isNew?: boolean;
}

/** One category section, in catalog display order. */
export interface CuratedCategory {
  name: string;
  models: CuratedModel[];
}

// The JSON boundary: the file's real shape is exactly this — verified
// against the data (categoryOrder: 14 names, models: 100 entries).
const data: { categoryOrder: string[]; models: CuratedModel[] } = catalog;

/** Every curated model, in the JSON's own order. */
export const CURATED_MODELS: CuratedModel[] = data.models;

/** Categories grouped and ordered per the JSON's categoryOrder. A category a
 *  model names that the order list forgot is appended, never dropped — a
 *  curation typo shouldn't silently hide models from the library. */
export const CURATED_CATEGORIES: CuratedCategory[] = (() => {
  const order = [...data.categoryOrder];
  for (const model of data.models) {
    if (!order.includes(model.category)) order.push(model.category);
  }
  return order
    .map((name) => ({ name, models: data.models.filter((m) => m.category === name) }))
    .filter((c) => c.models.length > 0);
})();

/** RAM-resident GGUF rule of thumb: the whole weights file sits in memory
 *  next to the OS and the KV cache, so ≤55% of total RAM runs comfortably,
 *  ≤80% runs but strains under load, beyond that it thrashes. "unknown"
 *  when either side is zero/absent — never guess a verdict from bad data. */
export function estimateFit(sizeBytes: number, totalMemBytes: number): FitVerdict {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return "unknown";
  if (!Number.isFinite(totalMemBytes) || totalMemBytes <= 0) return "unknown";
  const ratio = sizeBytes / totalMemBytes;
  if (ratio <= 0.55) return "fits";
  if (ratio <= 0.8) return "tight";
  return "too-big";
}
