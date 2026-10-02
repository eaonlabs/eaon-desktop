import type { LibraryModel, LibraryVariant } from '@shared/modelLibrary'

/**
 * The curated local-model library. Every variant is a GGUF on Hugging Face
 * (plus a vision projector for models that see images), downloaded directly
 * and run by Eaon's own llama.cpp (`main/llama/`) — no Ollama. Repos, files
 * and sizes were read from the Hugging Face API (Sept 30 2026), preferring the
 * model's own org, then ggml-org, unsloth, LiquidAI, ibm-granite, bartowski.
 * `node scripts/verify-model-library.mjs` re-checks them.
 *
 * - `sizeBytes` is every file of the variant, projector included: what lands on disk.
 * - `released` is the date the model's first official artifact appeared.
 * - `recommended` tiers are curated rather than derived: the smallest tier is
 *   the model's minimum, and test/modelLibrary.test.ts checks every pick at
 *   least runs (fits or is tight) at its tier.
 */

const APACHE = { name: 'Apache 2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' }
const MIT = { name: 'MIT', url: 'https://opensource.org/license/mit' }
const OPENMDW = { name: 'OpenMDW 1.1', url: 'https://openmdw.ai/license/1-1/' }
const LFM = { name: 'LFM Open License 1.0', url: 'https://huggingface.co/LiquidAI/LFM2.5-8B-A1B/blob/main/LICENSE' }
const GEMMA_4 = { name: 'Apache 2.0', url: 'https://ai.google.dev/gemma/docs/gemma_4_license' }

/** One variant: the GGUF (plus any vision projector) Eaon downloads from the repo, and their total size. */
function hf(id: string, quant: string, repo: string, files: string[], sizeBytes: number): LibraryVariant {
  return { id, quant, sizeBytes, source: { kind: 'hf', repo, quant, files } }
}

export const LIBRARY: LibraryModel[] = [
  // ---- The three the user asked for by name ----
  {
    id: 'minicpm5-2b',
    name: 'MiniCPM5 2B',
    org: 'OpenBMB',
    family: 'MiniCPM5',
    params: '2.5B',
    paramsB: 2.52,
    description:
      'OpenBMB’s on-device model with switchable deep thinking. OpenBMB reports it leading the 2B class and holding up against 4B models on coding, math, tool use and long context.',
    categories: ['small', 'general'],
    capabilities: ['tools', 'reasoning', 'coding'],
    contextLength: 131_072,
    license: APACHE,
    released: '2026-09-05',
    links: { huggingFace: 'openbmb/MiniCPM5-2B' },
    variants: [
      hf('q4_k_m', 'Q4_K_M', 'openbmb/MiniCPM5-2B-GGUF', ['MiniCPM5-2B-Q4_K_M.gguf'], 1_561_318_368),
      hf('q8_0', 'Q8_0', 'openbmb/MiniCPM5-2B-GGUF', ['MiniCPM5-2B-Q8_0.gguf'], 2_679_710_688)
    ],
    recommended: [
      { ramGB: 8, variant: 'q4_k_m' },
      { ramGB: 16, variant: 'q8_0' }
    ],
    featured: true
  },
  {
    id: 'k2-horizon-7b',
    name: 'K2 Horizon 7B',
    org: 'MBZUAI IFM',
    family: 'K2 Horizon',
    params: '7B',
    paramsB: 9.0,
    description:
      'A fully open 7B-core dense model — weights, training data and recipe all public — with a 512K context and reasoning, coding and tool use merged in from specialist RL experts.',
    categories: ['reasoning', 'coding', 'general'],
    capabilities: ['tools', 'reasoning', 'coding'],
    contextLength: 524_288,
    license: APACHE,
    released: '2026-09-01',
    links: { huggingFace: 'IFM/K2-Horizon-7B' },
    variants: [
      hf('q4_k_m', 'Q4_K_M', 'IFM/K2-Horizon-7B-GGUF', ['K2-Horizon-7B-Q4_K_M.gguf'], 5_592_217_984),
      hf('q8_0', 'Q8_0', 'IFM/K2-Horizon-7B-GGUF', ['K2-Horizon-7B-Q8_0.gguf'], 9_573_964_160)
    ],
    recommended: [
      { ramGB: 16, variant: 'q4_k_m' },
      { ramGB: 24, variant: 'q8_0' }
    ],
    featured: true,
    // Upstream llama.cpp can't load 'k2-horizon' until ggml-org/llama.cpp#29535
    // merges; Eaon's build carries that PR (native/llama-fork.json). Drop this
    // once the base commit includes it.
    requires: { pull: 29535, architecture: 'k2-horizon' }
  },
  {
    id: 'qwen3.8-27b',
    name: 'Qwen3.8 27B',
    org: 'Qwen',
    family: 'Qwen3.8',
    params: '27B',
    paramsB: 27.8,
    description:
      'The newest Qwen generation as a dense 27B: a native vision-language model with switchable thinking, aimed at coding, research and long multi-step agent work.',
    categories: ['general', 'coding', 'reasoning', 'vision'],
    capabilities: ['tools', 'vision', 'reasoning', 'coding'],
    contextLength: 262_144,
    license: APACHE,
    released: '2026-08-05',
    links: { huggingFace: 'Qwen/Qwen3.8-27B' },
    variants: [
      hf('ud-q3_k_xl', 'UD-Q3_K_XL', 'unsloth/Qwen3.8-27B-GGUF', ['Qwen3.8-27B-UD-Q3_K_XL.gguf', 'mmproj-F16.gguf'], 14_074_000_992),
      hf('q4_k_m', 'Q4_K_M', 'unsloth/Qwen3.8-27B-GGUF', ['Qwen3.8-27B-UD-Q4_K_M.gguf', 'mmproj-F16.gguf'], 17_392_047_712),
      hf('q8_0', 'Q8_0', 'unsloth/Qwen3.8-27B-GGUF', ['Qwen3.8-27B-Q8_0.gguf', 'mmproj-F16.gguf'], 29_974_693_536)
    ],
    recommended: [
      { ramGB: 24, variant: 'ud-q3_k_xl' },
      { ramGB: 32, variant: 'q4_k_m' },
      { ramGB: 48, variant: 'q8_0' }
    ],
    featured: true
  },

  // ---- General ----
  {
    id: 'gemma-4-12b',
    name: 'Gemma 4 12B',
    org: 'Google DeepMind',
    family: 'Gemma 4',
    params: '12B',
    paramsB: 12.0,
    description:
      'The mid-size Gemma 4: one encoder-free model that takes text, images and audio directly, with configurable reasoning and a 256K context.',
    categories: ['general', 'vision'],
    capabilities: ['tools', 'vision', 'reasoning'],
    contextLength: 262_144,
    license: GEMMA_4,
    released: '2026-05-23',
    links: { huggingFace: 'google/gemma-4-12B-it' },
    variants: [
      hf('qat', 'QAT Q4', 'unsloth/gemma-4-12B-it-qat-GGUF', ['gemma-4-12B-it-qat-UD-Q4_K_XL.gguf', 'mmproj-F16.gguf'], 6_891_472_640),
      hf('q4_k_m', 'Q4_K_M', 'unsloth/gemma-4-12b-it-GGUF', ['gemma-4-12b-it-Q4_K_M.gguf', 'mmproj-F16.gguf'], 7_296_977_280),
      hf('q8_0', 'Q8_0', 'unsloth/gemma-4-12b-it-GGUF', ['gemma-4-12b-it-Q8_0.gguf', 'mmproj-F16.gguf'], 12_844_763_520)
    ],
    recommended: [
      { ramGB: 16, variant: 'qat' },
      { ramGB: 24, variant: 'q8_0' }
    ]
  },
  {
    id: 'muse-glimmer-30b',
    name: 'Muse Glimmer 30B',
    org: 'Meta',
    family: 'Muse',
    params: '30B',
    paramsB: 29.8,
    description:
      'Meta Superintelligence Lab’s local agent model, distilled from Muse Spark and tuned for precise tool calls, long tasks and recovering when a step fails. Reads images too.',
    categories: ['general', 'coding', 'vision'],
    capabilities: ['tools', 'vision', 'reasoning', 'coding'],
    contextLength: 131_072,
    license: APACHE,
    released: '2026-08-09',
    links: { huggingFace: 'meta-models/Muse-Glimmer-30B' },
    variants: [
      hf('q4_k_m', 'Q4_K_M', 'lmstudio-community/Muse-Glimmer-30B-GGUF', ['Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf', 'mmproj-Muse-Glimmer-30B-Q4_K_M.gguf'], 18_157_012_832),
      hf('q8_0', 'Q8_0', 'unsloth/Muse-Glimmer-30B-GGUF', ['Muse-Glimmer-30B-Q8_0.gguf', 'mmproj-Muse-Glimmer-30B-Q8_0.gguf'], 31_664_643_072)
    ],
    recommended: [
      { ramGB: 24, variant: 'q4_k_m' },
      { ramGB: 48, variant: 'q8_0' }
    ]
  },
  {
    id: 'granite-4.2-8b',
    name: 'Granite 4.2 8B',
    org: 'IBM',
    family: 'Granite 4.2',
    params: '8B',
    paramsB: 8.8,
    description:
      'IBM’s enterprise model, now with thinking you can set to full, low or off. Multilingual, and dependable at tool calls and structured JSON.',
    categories: ['general', 'reasoning'],
    capabilities: ['tools', 'reasoning', 'coding'],
    contextLength: 131_072,
    license: APACHE,
    released: '2026-08-07',
    links: { huggingFace: 'ibm-granite/granite-4.2-8b' },
    variants: [
      hf('q4_k_m', 'Q4_K_M', 'ibm-granite/granite-4.2-8b-GGUF', ['granite-4.2-8b-Q4_K_M.gguf'], 5_347_917_952),
      hf('q8_0', 'Q8_0', 'ibm-granite/granite-4.2-8b-GGUF', ['granite-4.2-8b-Q8_0.gguf'], 9_345_613_952)
    ],
    recommended: [
      { ramGB: 16, variant: 'q4_k_m' },
      { ramGB: 24, variant: 'q8_0' }
    ]
  },
  {
    id: 'qwen3.5-9b',
    name: 'Qwen3.5 9B',
    org: 'Qwen',
    family: 'Qwen3.5',
    params: '9B',
    paramsB: 9.7,
    description:
      'A widely used 9B all-rounder from the Qwen3.5 family: reads images, thinks when asked and has a 256K context. The base several newer 9B models are built on.',
    categories: ['general', 'vision'],
    capabilities: ['tools', 'vision', 'reasoning'],
    contextLength: 262_144,
    license: APACHE,
    released: '2026-02-27',
    links: { huggingFace: 'Qwen/Qwen3.5-9B' },
    variants: [
      hf('q4_k_m', 'Q4_K_M', 'unsloth/Qwen3.5-9B-GGUF', ['Qwen3.5-9B-Q4_K_M.gguf', 'mmproj-F16.gguf'], 6_598_688_544),
      hf('q8_0', 'Q8_0', 'unsloth/Qwen3.5-9B-GGUF', ['Qwen3.5-9B-Q8_0.gguf', 'mmproj-F16.gguf'], 10_445_668_128)
    ],
    recommended: [
      { ramGB: 16, variant: 'q4_k_m' },
      { ramGB: 24, variant: 'q8_0' }
    ]
  },

  // ---- Reasoning ----
  {
    id: 'mimo-v2.6-distill-9b',
    name: 'MiMo V2.6 Distill 9B',
    org: 'Xiaomi MiMo',
    family: 'MiMo V2.6',
    params: '9B',
    paramsB: 9.4,
    description:
      'Xiaomi’s MiMo-V2.6 agent skills distilled into Qwen3.5-9B: coding, general agent tasks, visual coding and security work. Released as an open research checkpoint.',
    categories: ['reasoning', 'coding', 'vision'],
    capabilities: ['tools', 'vision', 'reasoning', 'coding'],
    contextLength: 262_144,
    license: MIT,
    released: '2026-09-21',
    links: { huggingFace: 'XiaomiMiMo/MiMo-V2.6-Distill-Qwen-9B' },
    variants: [
      hf(
        'q4_k_m',
        'Q4_K_M',
        'bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF',
        ['MiMo-V2.6-Distill-Qwen-9B-Q4_K_M.gguf', 'mmproj-MiMo-V2.6-Distill-Qwen-9B-f16.gguf'],
        6_759_215_168
      ),
      hf(
        'q8_0',
        'Q8_0',
        'bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF',
        ['MiMo-V2.6-Distill-Qwen-9B-Q8_0.gguf', 'mmproj-MiMo-V2.6-Distill-Qwen-9B-f16.gguf'],
        10_464_145_472
      )
    ],
    recommended: [
      { ramGB: 16, variant: 'q4_k_m' },
      { ramGB: 24, variant: 'q8_0' }
    ]
  },
  {
    id: 'gemma-4-26b-a4b',
    name: 'Gemma 4 26B A4B',
    org: 'Google DeepMind',
    family: 'Gemma 4',
    params: '26B-A4B',
    paramsB: 25.8,
    description:
      'Gemma 4’s mixture-of-experts model: 26B parameters with about 4B active per token, so it answers far faster than a dense model its size. Reads images.',
    categories: ['reasoning', 'general', 'vision'],
    capabilities: ['tools', 'vision', 'reasoning', 'coding'],
    contextLength: 262_144,
    license: GEMMA_4,
    released: '2026-03-11',
    links: { huggingFace: 'google/gemma-4-26B-A4B-it' },
    variants: [
      hf('qat', 'QAT Q4', 'unsloth/gemma-4-26B-A4B-it-qat-GGUF', ['gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf', 'mmproj-F16.gguf'], 15_442_105_888),
      hf('q4_k_m', 'Q4_K_M', 'unsloth/gemma-4-26B-A4B-it-GGUF', ['gemma-4-26B-A4B-it-UD-Q4_K_M.gguf', 'mmproj-F16.gguf'], 18_140_600_512),
      hf('q8_0', 'Q8_0', 'unsloth/gemma-4-26B-A4B-it-GGUF', ['gemma-4-26B-A4B-it-Q8_0.gguf', 'mmproj-F16.gguf'], 28_052_920_512)
    ],
    recommended: [
      { ramGB: 24, variant: 'qat' },
      { ramGB: 32, variant: 'q4_k_m' },
      { ramGB: 48, variant: 'q8_0' }
    ]
  },
  {
    id: 'nemotron-3.5-lightning',
    name: 'Nemotron 3.5 Lightning',
    org: 'NVIDIA',
    family: 'Nemotron 3.5',
    params: '30B-A3B',
    paramsB: 31.6,
    description:
      'NVIDIA’s hybrid mixture-of-experts for always-on agents: 3B active parameters and a 1M-token context, with open weights, training data and recipes.',
    categories: ['reasoning', 'general'],
    capabilities: ['tools', 'reasoning', 'coding'],
    contextLength: 1_048_576,
    license: OPENMDW,
    released: '2026-08-01',
    links: { huggingFace: 'nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16' },
    variants: [
      hf('q4_k_m', 'Q4_K_M', 'unsloth/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF', ['NVIDIA-Nemotron-3.5-Lightning-30B-A3B-UD-Q4_K_M.gguf'], 25_266_255_936),
      hf('q8_0', 'Q8_0', 'ggml-org/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF', ['NVIDIA-Nemotron-3.5-Lightning-30B-A3B-Q8_0.gguf'], 33_585_495_616)
    ],
    recommended: [
      { ramGB: 32, variant: 'q4_k_m' },
      { ramGB: 64, variant: 'q8_0' }
    ]
  },

  // ---- Coding ----
  {
    id: 'ornith-1.5-9b',
    name: 'Ornith 1.5 9B',
    org: 'Ornith AI',
    family: 'Ornith',
    params: '9B',
    paramsB: 9.7,
    description:
      'Trained with a self-improvement loop that generates its own tasks, harnesses and solutions, building on Ornith 1.0’s focus on agentic coding. Reads images.',
    categories: ['coding', 'vision'],
    capabilities: ['vision', 'reasoning', 'coding'],
    contextLength: 262_144,
    license: MIT,
    released: '2026-08-18',
    links: { huggingFace: 'ornith-ai/Ornith-1.5-9B' },
    variants: [
      hf('q4_k_m', 'Q4_K_M', 'ornith-ai/Ornith-1.5-9B-GGUF', ['Ornith-1.5-9B-Q4_K_M.gguf', 'mmproj-Ornith-1.5-9B-BF16.gguf'], 6_701_795_488),
      hf(
        'q8_0',
        'Q8_0',
        'ornith-ai/Ornith-1.5-9B-GGUF',
        ['Ornith-1.5-9B-Q8_0.gguf', 'mmproj-Ornith-1.5-9B-BF16.gguf'],
        10_707_765_056
      )
    ],
    recommended: [
      { ramGB: 16, variant: 'q4_k_m' },
      { ramGB: 24, variant: 'q8_0' }
    ]
  },
  {
    id: 'north-mini-code-1.0',
    name: 'North Mini Code 1.0',
    org: 'Cohere',
    family: 'North',
    params: '30B-A3B',
    paramsB: 30.5,
    description:
      'Cohere’s first model for developers: a 30B mixture-of-experts with 3B active, built for code generation, agentic software engineering and terminal work.',
    categories: ['coding'],
    capabilities: ['tools', 'reasoning', 'coding'],
    contextLength: 262_144,
    license: APACHE,
    released: '2026-06-05',
    links: { huggingFace: 'CohereLabs/North-Mini-Code-1.0' },
    variants: [
      hf('ud-q3_k_xl', 'UD-Q3_K_XL', 'unsloth/North-Mini-Code-1.0-GGUF', ['North-Mini-Code-1.0-UD-Q3_K_XL.gguf'], 14_343_037_024),
      hf('q4_k_m', 'Q4_K_M', 'unsloth/North-Mini-Code-1.0-GGUF', ['North-Mini-Code-1.0-UD-Q4_K_M.gguf'], 19_203_186_784),
      hf('q8_0', 'Q8_0', 'unsloth/North-Mini-Code-1.0-GGUF', ['North-Mini-Code-1.0-Q8_0.gguf'], 32_437_264_480)
    ],
    recommended: [
      { ramGB: 24, variant: 'ud-q3_k_xl' },
      { ramGB: 32, variant: 'q4_k_m' },
      { ramGB: 48, variant: 'q8_0' }
    ]
  },
  {
    id: 'laguna-xs-2.1',
    name: 'Laguna XS 2.1',
    org: 'Poolside',
    family: 'Laguna',
    params: '33B-A3B',
    paramsB: 33.4,
    description:
      'Poolside’s agentic coding model for local machines: a 33B mixture-of-experts with 3B active, tuned for long-horizon repository and terminal tasks.',
    categories: ['coding'],
    capabilities: ['tools', 'reasoning', 'coding'],
    contextLength: 262_144,
    license: OPENMDW,
    released: '2026-06-20',
    links: { huggingFace: 'poolside/Laguna-XS-2.1' },
    variants: [
      hf('q3_k_m', 'Q3_K_M', 'bartowski/Laguna-XS-2.1-GGUF', ['Laguna-XS-2.1-Q3_K_M.gguf'], 15_575_904_128),
      hf('q4_k_m', 'Q4_K_M', 'poolside/Laguna-XS-2.1-GGUF', ['Laguna-XS-2.1-Q4_K_M.gguf'], 20_274_300_032),
      hf('q8_0', 'Q8_0', 'bartowski/Laguna-XS-2.1-GGUF', ['Laguna-XS-2.1-Q8_0.gguf'], 35_597_116_800)
    ],
    recommended: [
      { ramGB: 24, variant: 'q3_k_m' },
      { ramGB: 32, variant: 'q4_k_m' },
      { ramGB: 64, variant: 'q8_0' }
    ]
  },

  // ---- Vision ----
  {
    id: 'minicpm-v-4.6',
    name: 'MiniCPM-V 4.6',
    org: 'OpenBMB',
    family: 'MiniCPM-V',
    params: '1.3B',
    paramsB: 1.3,
    description:
      'A pocket-sized vision model (SigLIP2 with Qwen3.5-0.8B) for single-image, multi-image and video understanding, light enough to run on a phone.',
    categories: ['vision', 'small'],
    capabilities: ['vision'],
    contextLength: 262_144,
    license: APACHE,
    released: '2026-04-13',
    links: { huggingFace: 'openbmb/MiniCPM-V-4.6' },
    variants: [
      hf('q4_k_m', 'Q4_K_M', 'openbmb/MiniCPM-V-4.6-gguf', ['MiniCPM-V-4_6-Q4_K_M.gguf', 'mmproj-model-f16.gguf'], 1_637_848_448),
      hf('q8_0', 'Q8_0', 'openbmb/MiniCPM-V-4.6-gguf', ['MiniCPM-V-4_6-Q8_0.gguf', 'mmproj-model-f16.gguf'], 1_920_338_560)
    ],
    recommended: [
      { ramGB: 8, variant: 'q4_k_m' },
      { ramGB: 16, variant: 'q8_0' }
    ]
  },

  // ---- Small & fast ----
  {
    id: 'gemma-4-e2b',
    name: 'Gemma 4 E2B',
    org: 'Google DeepMind',
    family: 'Gemma 4',
    params: 'E2B',
    paramsB: 5.1,
    description:
      'The smallest Gemma 4, built for phones and laptops: about 2B effective parameters, yet it still takes images and audio as well as text.',
    categories: ['small', 'vision'],
    capabilities: ['tools', 'vision', 'reasoning'],
    contextLength: 131_072,
    license: GEMMA_4,
    released: '2026-03-02',
    links: { huggingFace: 'google/gemma-4-E2B-it' },
    variants: [
      hf('qat', 'QAT Q4', 'unsloth/gemma-4-E2B-it-qat-GGUF', ['gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf', 'mmproj-F16.gguf'], 3_606_025_056),
      hf('q4_k_m', 'Q4_K_M', 'unsloth/gemma-4-E2B-it-GGUF', ['gemma-4-E2B-it-Q4_K_M.gguf', 'mmproj-F16.gguf'], 4_092_392_352)
    ],
    recommended: [
      { ramGB: 8, variant: 'qat' },
      { ramGB: 16, variant: 'q4_k_m' }
    ]
  },
  {
    id: 'lfm2.5-8b-a1b',
    name: 'LFM2.5 8B-A1B',
    org: 'Liquid AI',
    family: 'LFM2.5',
    params: '8B-A1.5B',
    paramsB: 8.3,
    description:
      'Liquid AI’s on-device mixture-of-experts: 8.3B total with 1.5B active, built for fast, reliable tool calling and instruction following on ordinary laptops.',
    categories: ['small', 'general'],
    capabilities: ['tools', 'reasoning'],
    contextLength: 128_000,
    license: LFM,
    released: '2026-05-24',
    links: { huggingFace: 'LiquidAI/LFM2.5-8B-A1B' },
    variants: [
      hf('q4_k_m', 'Q4_K_M', 'LiquidAI/LFM2.5-8B-A1B-GGUF', ['LFM2.5-8B-A1B-Q4_K_M.gguf'], 5_155_564_768),
      hf('q8_0', 'Q8_0', 'LiquidAI/LFM2.5-8B-A1B-GGUF', ['LFM2.5-8B-A1B-Q8_0.gguf'], 9_010_195_680)
    ],
    recommended: [
      { ramGB: 8, variant: 'q4_k_m' },
      { ramGB: 16, variant: 'q8_0' }
    ]
  },
  {
    id: 'lfm2.5-2.6b',
    name: 'LFM2.5 2.6B',
    org: 'Liquid AI',
    family: 'LFM2.5',
    params: '2.6B',
    paramsB: 2.7,
    description:
      'A hybrid 2.6B model with agentic post-training and a 128K context. Liquid measures 220 tokens/s on an M5 Max while using under 2.5 GB of memory.',
    categories: ['small'],
    capabilities: ['tools'],
    contextLength: 131_072,
    license: LFM,
    released: '2026-07-28',
    links: { huggingFace: 'LiquidAI/LFM2.5-2.6B' },
    variants: [
      hf('q4_k_m', 'Q4_K_M', 'LiquidAI/LFM2.5-2.6B-GGUF', ['LFM2.5-2.6B-Q4_K_M.gguf'], 1_674_455_040),
      hf('q8_0', 'Q8_0', 'LiquidAI/LFM2.5-2.6B-GGUF', ['LFM2.5-2.6B-Q8_0.gguf'], 2_874_779_648)
    ],
    recommended: [
      { ramGB: 8, variant: 'q4_k_m' },
      { ramGB: 16, variant: 'q8_0' }
    ]
  },
  {
    id: 'qwen3.5-4b',
    name: 'Qwen3.5 4B',
    org: 'Qwen',
    family: 'Qwen3.5',
    params: '4B',
    paramsB: 4.7,
    description:
      'The 4B Qwen3.5: small enough for an 8 GB machine yet still multimodal, with thinking and a 256K context.',
    categories: ['small', 'vision'],
    capabilities: ['tools', 'vision', 'reasoning'],
    contextLength: 262_144,
    license: APACHE,
    released: '2026-02-27',
    links: { huggingFace: 'Qwen/Qwen3.5-4B' },
    variants: [
      hf('q4_k_m', 'Q4_K_M', 'unsloth/Qwen3.5-4B-GGUF', ['Qwen3.5-4B-Q4_K_M.gguf', 'mmproj-F16.gguf'], 3_413_361_504),
      hf('q8_0', 'Q8_0', 'unsloth/Qwen3.5-4B-GGUF', ['Qwen3.5-4B-Q8_0.gguf', 'mmproj-F16.gguf'], 5_154_827_104)
    ],
    recommended: [
      { ramGB: 8, variant: 'q4_k_m' },
      { ramGB: 16, variant: 'q8_0' }
    ]
  },
  {
    id: 'granite-4.2-3b',
    name: 'Granite 4.2 3B',
    org: 'IBM',
    family: 'Granite 4.2',
    params: '3B',
    paramsB: 3.7,
    description:
      'IBM’s compact Granite 4.2 with the same thinking modes, tool calling and structured output as the 8B, sized for 8 GB machines.',
    categories: ['small'],
    capabilities: ['tools', 'reasoning'],
    contextLength: 131_072,
    license: APACHE,
    released: '2026-08-07',
    links: { huggingFace: 'ibm-granite/granite-4.2-3b' },
    variants: [
      hf('q4_k_m', 'Q4_K_M', 'ibm-granite/granite-4.2-3b-GGUF', ['granite-4.2-3b-Q4_K_M.gguf'], 2_244_011_552),
      hf('q8_0', 'Q8_0', 'ibm-granite/granite-4.2-3b-GGUF', ['granite-4.2-3b-Q8_0.gguf'], 3_892_651_552)
    ],
    recommended: [
      { ramGB: 8, variant: 'q4_k_m' },
      { ramGB: 16, variant: 'q8_0' }
    ]
  },

  // ---- Embeddings ----
  {
    id: 'lfm2.5-embedding-350m',
    name: 'LFM2.5 Embedding 350M',
    org: 'Liquid AI',
    family: 'LFM2.5',
    params: '350M',
    paramsB: 0.35,
    description:
      'A bidirectional 350M embedding model for fast multilingual and cross-lingual search across 11 languages; a drop-in replacement in a RAG pipeline.',
    categories: ['embedding'],
    capabilities: ['embedding'],
    contextLength: 512,
    license: LFM,
    released: '2026-05-05',
    links: { huggingFace: 'LiquidAI/LFM2.5-Embedding-350M' },
    variants: [
      hf('q8_0', 'Q8_0', 'LiquidAI/LFM2.5-Embedding-350M-GGUF', ['LFM2.5-Embedding-350M-Q8_0.gguf'], 379_216_640),
      hf('q4_k_m', 'Q4_K_M', 'LiquidAI/LFM2.5-Embedding-350M-GGUF', ['LFM2.5-Embedding-350M-Q4_K_M.gguf'], 229_311_232)
    ],
    recommended: [{ ramGB: 8, variant: 'q8_0' }]
  },
  {
    id: 'embeddinggemma-300m',
    name: 'EmbeddingGemma 300M',
    org: 'Google DeepMind',
    family: 'Gemma',
    params: '300M',
    paramsB: 0.3,
    description:
      'Google’s compact text embedding model for search, retrieval and clustering, small enough to run on a phone.',
    categories: ['embedding'],
    capabilities: ['embedding'],
    contextLength: 2048,
    license: { name: 'Gemma Terms of Use', url: 'https://ai.google.dev/gemma/terms' },
    released: '2025-09-04',
    links: { huggingFace: 'google/embeddinggemma-300m' },
    variants: [
      hf('q8_0', 'Q8_0', 'ggml-org/embeddinggemma-300M-GGUF', ['embeddinggemma-300M-Q8_0.gguf'], 333_590_944),
      hf('qat-q8_0', 'QAT Q8_0', 'ggml-org/embeddinggemma-300m-qat-q8_0-GGUF', ['embeddinggemma-300m-qat-Q8_0.gguf'], 328_577_056)
    ],
    recommended: [{ ramGB: 8, variant: 'q8_0' }]
  },
  {
    id: 'qwen3-embedding-0.6b',
    name: 'Qwen3 Embedding 0.6B',
    org: 'Qwen',
    family: 'Qwen3 Embedding',
    params: '0.6B',
    paramsB: 0.6,
    description:
      'The smallest Qwen3 embedding model: retrieval across 100+ languages, programming languages included, with a 32K input window.',
    categories: ['embedding'],
    capabilities: ['embedding'],
    contextLength: 32_768,
    license: APACHE,
    released: '2025-06-03',
    links: { huggingFace: 'Qwen/Qwen3-Embedding-0.6B' },
    variants: [hf('q8_0', 'Q8_0', 'Qwen/Qwen3-Embedding-0.6B-GGUF', ['Qwen3-Embedding-0.6B-Q8_0.gguf'], 639_150_592)],
    recommended: [{ ramGB: 8, variant: 'q8_0' }]
  }
]

export function findLibraryModel(id: string): LibraryModel | undefined {
  return LIBRARY.find((m) => m.id === id)
}
