import type { LibraryModel, LibraryVariant } from '@shared/modelLibrary'

/**
 * The curated local-model library, researched against the live Hugging Face
 * and Ollama registries in September 2026. Every repo, file, tag, size and
 * digest here was read from those registries, not remembered —
 * `node scripts/verify-model-library.mjs` re-checks all of them, so run it
 * whenever you touch this file.
 *
 * - `sizeBytes` is the whole pull: every manifest layer, vision projector
 *   included, which is what actually lands on disk.
 * - Ollama `digest` is the first 12 hex chars of the manifest's sha256, the ID
 *   `ollama list` prints. It lets the page recognise a model the user pulled
 *   under a different tag.
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

function ollama(id: string, quant: string, tag: string, digest: string, sizeBytes: number): LibraryVariant {
  return { id, quant, sizeBytes, source: { kind: 'ollama', tag, digest } }
}

function hf(id: string, quant: string, repo: string, files: string[], sizeBytes: number, pullQuant = quant): LibraryVariant {
  return { id, quant, sizeBytes, source: { kind: 'hf', repo, quant: pullQuant, files } }
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
      hf('q4_k_m', 'Q4_K_M', 'openbmb/MiniCPM5-2B-GGUF', ['MiniCPM5-2B-Q4_K_M.gguf'], 1_561_319_197),
      hf('q8_0', 'Q8_0', 'openbmb/MiniCPM5-2B-GGUF', ['MiniCPM5-2B-Q8_0.gguf'], 2_679_711_517)
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
      hf('q4_k_m', 'Q4_K_M', 'IFM/K2-Horizon-7B-GGUF', ['K2-Horizon-7B-Q4_K_M.gguf'], 5_592_218_900),
      hf('q8_0', 'Q8_0', 'IFM/K2-Horizon-7B-GGUF', ['K2-Horizon-7B-Q8_0.gguf'], 9_573_965_076)
    ],
    recommended: [
      { ramGB: 16, variant: 'q4_k_m' },
      { ramGB: 24, variant: 'q8_0' }
    ],
    featured: true,
    // Checked by pulling IFM/K2-Horizon-0.9B-GGUF (same architecture) into
    // Ollama 0.30.4: the pull succeeds, loading fails with "unknown model
    // architecture: 'k2-horizon'". IFM's GGUF card says llama.cpp support is
    // an open pull request. Remove this once a released Ollama loads it.
    unsupported:
      'Ollama can’t load the K2 Horizon architecture yet — llama.cpp support is still an open pull request. The GGUF files are published and ready once it lands.'
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
    links: { huggingFace: 'Qwen/Qwen3.8-27B', ollama: 'qwen3.8' },
    variants: [
      hf(
        'ud-q3_k_xl',
        'UD-Q3_K_XL',
        'unsloth/Qwen3.8-27B-GGUF',
        ['Qwen3.8-27B-UD-Q3_K_XL.gguf', 'mmproj-BF16.gguf'],
        14_077_541_042
      ),
      ollama('q4_k_m', 'Q4_K_M + MTP', 'qwen3.8:27b', '22130167c4c2', 17_741_872_154),
      ollama('q8_0', 'Q8_0', 'qwen3.8:27b-q8_0', '8f5fb6b71ea0', 29_978_242_050)
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
    links: { huggingFace: 'google/gemma-4-12B-it', ollama: 'gemma4' },
    variants: [
      ollama('qat', 'QAT Q4', 'gemma4:12b-it-qat', '38044be4f923', 7_151_003_754),
      ollama('q4_k_m', 'Q4_K_M', 'gemma4:12b', '4eb23ef187e2', 7_556_508_396),
      ollama('q8_0', 'Q8_0', 'gemma4:12b-it-q8_0', '41c402fdddc2', 12_844_772_074)
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
    links: { huggingFace: 'meta-models/Muse-Glimmer-30B', ollama: 'muse-glimmer' },
    variants: [
      ollama('q4_k_m', 'Q4_K_M', 'muse-glimmer:30b', 'de878ce33ad8', 18_157_010_252),
      ollama('q8_0', 'Q8_0', 'muse-glimmer:30b-q8_0', '6ffafcdbd728', 31_013_287_242)
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
    links: { huggingFace: 'ibm-granite/granite-4.2-8b', ollama: 'granite4.2' },
    variants: [
      ollama('q4_k_m', 'Q4_K_M', 'granite4.2:8b', 'f586c02fdecd', 5_347_929_757),
      ollama('q8_0', 'Q8_0', 'granite4.2:8b-q8_0', '62837636dd31', 9_345_625_755)
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
    links: { huggingFace: 'Qwen/Qwen3.5-9B', ollama: 'qwen3.5' },
    variants: [
      ollama('q4_k_m', 'Q4_K_M', 'qwen3.5:9b', '6488c96fa5fa', 6_594_474_711),
      ollama('q8_0', 'Q8_0', 'qwen3.5:9b-q8_0', '441ec31e4d2a', 10_699_928_277)
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
        6_759_216_058
      ),
      hf(
        'q8_0',
        'Q8_0',
        'bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF',
        ['MiMo-V2.6-Distill-Qwen-9B-Q8_0.gguf', 'mmproj-MiMo-V2.6-Distill-Qwen-9B-f16.gguf'],
        10_464_146_362
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
    links: { huggingFace: 'google/gemma-4-26B-A4B-it', ollama: 'gemma4' },
    variants: [
      ollama('qat', 'QAT Q4', 'gemma4:26b-a4b-it-qat', '2dd70431afed', 15_634_199_946),
      ollama('q4_k_m', 'Q4_K_M + MTP', 'gemma4:26b', '08ae7ec1744b', 18_604_148_513),
      ollama('q8_0', 'Q8_0', 'gemma4:26b-a4b-it-q8_0', '6bfaf9a8cb37', 28_052_911_389)
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
    links: { huggingFace: 'nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16', ollama: 'nemotron-3.5-lightning' },
    variants: [
      ollama('q4_k_m', 'Q4_K_M', 'nemotron-3.5-lightning:30b', 'e7a64ff15fb1', 25_430_749_387),
      ollama('q8_0', 'Q8_0', 'nemotron-3.5-lightning:30b-a3b-q8_0', '9983b24ee511', 35_004_652_745)
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
    links: { huggingFace: 'ornith-ai/Ornith-1.5-9B', ollama: 'ornith-1.5' },
    variants: [
      ollama('q4_k_m', 'Q4_K_M', 'ornith-1.5:9b', 'e5df7dcdd8a2', 6_550_813_657),
      hf(
        'q8_0',
        'Q8_0',
        'ornith-ai/Ornith-1.5-9B-GGUF',
        ['Ornith-1.5-9B-Q8_0.gguf', 'mmproj-Ornith-1.5-9B-BF16.gguf'],
        10_707_765_951
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
    links: { huggingFace: 'CohereLabs/North-Mini-Code-1.0', ollama: 'north-mini-code-1.0' },
    variants: [
      hf('ud-q3_k_xl', 'UD-Q3_K_XL', 'unsloth/North-Mini-Code-1.0-GGUF', ['North-Mini-Code-1.0-UD-Q3_K_XL.gguf'], 14_343_037_929),
      ollama('q4_k_m', 'Q4_K_M', 'north-mini-code-1.0:q4_K_M', 'd8b269ad5c7c', 18_593_967_008),
      ollama('q8_0', 'Q8_0', 'north-mini-code-1.0:q8_0', 'b6c144236e03', 32_437_275_550)
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
    links: { huggingFace: 'poolside/Laguna-XS-2.1', ollama: 'laguna-xs-2.1' },
    variants: [
      hf('q3_k_m', 'Q3_K_M', 'bartowski/Laguna-XS-2.1-GGUF', ['Laguna-XS-2.1-Q3_K_M.gguf'], 15_575_904_899),
      ollama('q4_k_m', 'Q4_K_M', 'laguna-xs-2.1:q4_K_M', '0175be1e57f4', 20_274_303_147),
      ollama('q8_0', 'Q8_0', 'laguna-xs-2.1:q8_0', 'a249c0765c04', 35_597_119_657)
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
    links: { huggingFace: 'openbmb/MiniCPM-V-4.6', ollama: 'minicpm-v4.6' },
    variants: [
      ollama('q4_k_m', 'Q4_K_M', 'minicpm-v4.6:1b', 'e95583acac77', 1_637_848_812),
      ollama('q8_0', 'Q8_0', 'minicpm-v4.6:q8_0', 'ceb4ec05ddf6', 1_920_338_922)
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
    links: { huggingFace: 'google/gemma-4-E2B-it', ollama: 'gemma4' },
    variants: [
      ollama('qat', 'QAT Q4', 'gemma4:e2b-it-qat', '07ea59a47401', 4_336_358_185),
      ollama('q4_k_m', 'Q4_K_M', 'gemma4:e2b', '7fbdbf8f5e45', 7_162_405_886)
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
    links: { huggingFace: 'LiquidAI/LFM2.5-8B-A1B', ollama: 'lfm2.5' },
    variants: [
      ollama('q4_k_m', 'Q4_K_M', 'lfm2.5:8b', '9cf756159fc2', 5_156_075_525),
      ollama('q8_0', 'Q8_0', 'lfm2.5:8b-a1b-q8_0', '4fa3787050ca', 9_010_706_435)
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
      hf('q4_k_m', 'Q4_K_M', 'LiquidAI/LFM2.5-2.6B-GGUF', ['LFM2.5-2.6B-Q4_K_M.gguf'], 1_674_466_581),
      hf('q8_0', 'Q8_0', 'LiquidAI/LFM2.5-2.6B-GGUF', ['LFM2.5-2.6B-Q8_0.gguf'], 2_874_791_189)
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
    links: { huggingFace: 'Qwen/Qwen3.5-4B', ollama: 'qwen3.5' },
    variants: [
      ollama('q4_k_m', 'Q4_K_M', 'qwen3.5:4b', '2a654d98e6fb', 3_389_983_735),
      ollama('q8_0', 'Q8_0', 'qwen3.5:4b-q8_0', '8722f47c2791', 5_279_294_453)
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
    links: { huggingFace: 'ibm-granite/granite-4.2-3b', ollama: 'granite4.2' },
    variants: [
      ollama('q4_k_m', 'Q4_K_M', 'granite4.2:3b', '40577dc168a3', 2_244_023_965),
      ollama('q8_0', 'Q8_0', 'granite4.2:3b-q8_0', 'f8163a0ed616', 3_892_663_963)
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
      hf('q8_0', 'Q8_0', 'LiquidAI/LFM2.5-Embedding-350M-GGUF', ['LFM2.5-Embedding-350M-Q8_0.gguf'], 379_228_180),
      hf('q4_k_m', 'Q4_K_M', 'LiquidAI/LFM2.5-Embedding-350M-GGUF', ['LFM2.5-Embedding-350M-Q4_K_M.gguf'], 229_322_772)
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
    links: { huggingFace: 'google/embeddinggemma-300m', ollama: 'embeddinggemma' },
    variants: [
      ollama('bf16', 'BF16', 'embeddinggemma:300m', '85462619ee72', 621_875_917),
      ollama('qat-q8_0', 'QAT Q8_0', 'embeddinggemma:300m-qat-q8_0', 'e84a7acc2394', 338_023_149)
    ],
    recommended: [{ ramGB: 8, variant: 'bf16' }]
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
    links: { huggingFace: 'Qwen/Qwen3-Embedding-0.6B', ollama: 'qwen3-embedding' },
    variants: [ollama('q8_0', 'Q8_0', 'qwen3-embedding:0.6b', 'ac6da0dfba84', 639_150_858)],
    recommended: [{ ramGB: 8, variant: 'q8_0' }]
  }
]

export function findLibraryModel(id: string): LibraryModel | undefined {
  return LIBRARY.find((m) => m.id === id)
}
