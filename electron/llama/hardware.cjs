'use strict';

const os = require('node:os');

const GB = 1024 ** 3;

// Machine facts we can trust everywhere: total RAM, core count, platform.
// GPU VRAM is intentionally NOT read here — the backend (node-llama-cpp)
// reports it, because OS-level queries are unreliable (e.g. Windows WMI
// AdapterRAM under-reports modern NVIDIA cards).
function hardwareProfile() {
  const totalRamGB = os.totalmem() / GB;
  return {
    totalRamGB: Number(totalRamGB.toFixed(1)),
    freeRamGB: Number((os.freemem() / GB).toFixed(1)),
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0]?.model?.trim() || 'unknown',
    platform: process.platform,
  };
}

// Decide how to place a model on this machine. Pure function so it can be
// unit-tested without loading the native backend.
//
//   vramGB      usable VRAM reported by the backend, 0 when CPU-only
//   modelGB     GGUF file size on disk (a good proxy for the weight footprint)
//   useGPU      'auto' | 'true' | 'false'   (settings are stored as strings)
//   nGpuLayers  explicit layer override, or ''/null for auto (-1 = all layers)
//   cpuCount    logical CPU count, for thread sizing
//
// Returns { useGPU, nGpuLayers, nThreads, tier, rationale }.
function chooseGpuOffload({
  vramGB = 0,
  modelGB = 0,
  useGPU = 'auto',
  nGpuLayers = '',
  cpuCount = 4,
} = {}) {
  const vram = Number(vramGB) || 0;
  const model = Number(modelGB) || 0;
  const threads = Math.max(2, Math.min(Number(cpuCount) || 4, 8));

  const forceOff = useGPU === 'false' || useGPU === false;
  const forceOn = useGPU === 'true' || useGPU === true;
  const override = nGpuLayers === '' || nGpuLayers == null ? null : Number(nGpuLayers);

  if (forceOff || vram <= 0) {
    return {
      useGPU: false,
      nGpuLayers: 0,
      nThreads: threads,
      tier: 'cpu',
      rationale: forceOff
        ? 'GPU disabled by settings; running on CPU.'
        : 'No GPU VRAM reported by the engine; running fully on CPU.',
    };
  }

  if (override !== null && Number.isFinite(override)) {
    const layers = override < 0 ? -1 : Math.max(1, Math.round(override));
    return {
      useGPU: true,
      nGpuLayers: layers,
      nThreads: threads,
      tier: 'override',
      rationale: `Using the user-specified ${override < 0 ? 'full' : layers} GPU layer offload.`,
    };
  }

  if (forceOn) {
    return {
      useGPU: true,
      nGpuLayers: -1,
      nThreads: threads,
      tier: 'full',
      rationale: 'GPU forced on by settings; full offload.',
    };
  }

  // High VRAM: the whole model (plus a margin for the KV cache) fits on the GPU.
  if (model > 0 && vram >= model * 1.2) {
    return {
      useGPU: true,
      nGpuLayers: -1,
      nThreads: threads,
      tier: 'full',
      rationale: 'VRAM comfortably holds the whole model; full offload.',
    };
  }

  // Medium VRAM: offload as many layers as the VRAM budget allows and let the
  // rest fall back to system RAM. We budget ~80% of VRAM for weights and scale
  // the estimated layer count of a 7-8B model (~32 layers) by relative size.
  if (vram >= Math.max(4, model * 0.4)) {
    const estLayers = Math.max(
      8,
      Math.min(40, Math.round(((vram * 0.8) / Math.max(0.5, model)) * 32)),
    );
    return {
      useGPU: true,
      nGpuLayers: estLayers,
      nThreads: threads,
      tier: 'partial',
      rationale: `Partial offload of ~${estLayers} layers; the rest stays in system RAM.`,
    };
  }

  return {
    useGPU: false,
    nGpuLayers: 0,
    nThreads: threads,
    tier: 'cpu',
    rationale: 'Not enough VRAM for a useful offload; staying on CPU.',
  };
}

module.exports = { hardwareProfile, chooseGpuOffload };
