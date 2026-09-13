/**
 * Reading a GPU out of a renderer string, and deciding what to hand it.
 *
 * The strings below are the real thing — what Chrome, Firefox and Safari
 * actually report on those machines, ANGLE wrapper and shader model included.
 * That is the whole point of keeping the classification out of the browser: a
 * heuristic over vendor strings is exactly the kind of code that is wrong on
 * hardware the author does not own, and this is the only way to check it
 * against thirty machines at once.
 */

import { assert, suite } from "./harness";
import {
  GPU_CLASS,
  UNKNOWN_GPU,
  classifyGpu,
  gpuAntiAliasing,
  gpuCloudMarchScale,
  gpuModelName,
  type GpuCapabilities,
  type GpuClass,
} from "../render/gpuProfile";

/** A probe result for a machine that reports `renderer` and nothing unusual. */
function machine(
  renderer: string,
  overrides: Partial<GpuCapabilities> = {},
): GpuCapabilities {
  return {
    renderer,
    vendor: "",
    webgl2: true,
    maxSamples: 8,
    maxTextureSize: 16384,
    deviceMemoryGb: 8,
    hardwareConcurrency: 8,
    mobile: false,
    ...overrides,
  };
}

function classOf(renderer: string, overrides: Partial<GpuCapabilities> = {}): GpuClass {
  return classifyGpu(machine(renderer, overrides)).class;
}

export function runGpuTests(): void {
  suite("gpu: the card is read out of the string", () => {
    assert(
      gpuModelName(
        "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)",
      ) === "NVIDIA GeForce RTX 4070",
      "the ANGLE wrapper, the vendor and the shader model come off",
    );
    assert(
      gpuModelName("ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917), Direct3D11)") ===
        "Intel(R) UHD Graphics 620",
      "so does a PCI id",
    );
    assert(
      gpuModelName("AMD Radeon Pro 5500M OpenGL Engine") === "AMD Radeon Pro 5500M",
      "a bare macOS string keeps the card and loses the engine",
    );
    assert(
      gpuModelName(
        "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
      ) === "Vulkan 1.3.0 (SwiftShader Device (Subzero))",
      "and what is stripped out takes its brackets and its spacing with it",
    );
    assert(gpuModelName("   ") === "", "and nothing is still nothing");
  });

  suite("gpu: what kind of thing is drawing", () => {
    assert(
      classOf("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))") ===
        GPU_CLASS.Software,
      "SwiftShader is not a GPU",
    );
    assert(
      classOf("Mesa/X.org, llvmpipe (LLVM 15.0.7, 256 bits)") === GPU_CLASS.Software,
      "neither is llvmpipe",
    );
    assert(
      classOf("Adreno (TM) 740", { mobile: true }) === GPU_CLASS.Mobile,
      "a phone part is a phone part",
    );
    assert(
      classOf("ANGLE (Intel, Intel(R) UHD Graphics 620, Direct3D11)") ===
        GPU_CLASS.Integrated,
      "Intel UHD is integrated",
    );
    assert(
      classOf("ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, Direct3D11)") ===
        GPU_CLASS.Integrated,
      "and so is Iris Xe, which is the best of them and still shares the bus",
    );
    assert(
      classOf("ANGLE (AMD, AMD Radeon(TM) Graphics, Direct3D11)") ===
        GPU_CLASS.Integrated,
      "an unnamed Radeon is the APU in a Ryzen laptop",
    );
    assert(
      classOf("ANGLE (AMD, AMD Radeon RX Vega 8 Graphics, Direct3D11)") ===
        GPU_CLASS.Integrated,
      "and so is a single-digit Vega, whatever the RX in front of it says",
    );
    assert(
      classOf("ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti Direct3D11 vs_5_0 ps_5_0)") ===
        GPU_CLASS.Discrete,
      "a card of its own is discrete even when it is a small one",
    );
    assert(
      classOf("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)") ===
        GPU_CLASS.Enthusiast,
      "and the upper half of a generation has room to spare",
    );
    assert(
      classOf("ANGLE (AMD, AMD Radeon RX 7900 XTX, Direct3D11)") ===
        GPU_CLASS.Enthusiast,
      "which AMD numbers the same way",
    );
    assert(
      classOf("ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics, Direct3D11)") ===
        GPU_CLASS.Discrete,
      "Intel's discrete line is read before Intel's integrated one",
    );
    assert(
      classOf("ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)") ===
        GPU_CLASS.Enthusiast,
      "an M-series Pro is desktop-class",
    );
    assert(
      classOf("Apple GPU") === GPU_CLASS.Discrete,
      "and a Mac that masks the part is still an Apple Silicon Mac",
    );
    assert(
      classOf("Apple GPU", { mobile: true }) === GPU_CLASS.Mobile,
      "while the same string on an iPad is a phone part",
    );
    assert(
      classOf("WebKit WebGL") === GPU_CLASS.Unknown,
      "a browser that will not say is not guessed at",
    );
  });

  suite("gpu: the preset that follows from it", () => {
    assert(
      classifyGpu(machine("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)"))
        .quality === "ultra",
      "a card with room to spare is given the top preset",
    );
    assert(
      classifyGpu(machine("ANGLE (Intel, Intel(R) UHD Graphics 620, Direct3D11)"))
        .quality === "medium",
      "integrated graphics get the middle one",
    );
    assert(
      classifyGpu(machine("Mesa/X.org, llvmpipe (LLVM 15.0.7, 256 bits)")).quality ===
        "low",
      "and a CPU drawing the frame gets the bottom one",
    );
    assert(
      classifyGpu(UNKNOWN_GPU).quality === "medium",
      "a machine that could not be probed at all is not gambled on",
    );
    assert(
      classifyGpu(machine("WebKit WebGL", { deviceMemoryGb: null })).quality === "high",
      "but a masked renderer on a machine that reads as a desktop is",
    );
    assert(
      classifyGpu(machine("WebKit WebGL", { hardwareConcurrency: 4 })).quality ===
        "medium",
      "and a masked renderer on four cores is not",
    );
  });

  suite("gpu: and the pilot is told what was found", () => {
    assert(
      classifyGpu(
        machine("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)"),
      ).note ===
        "NVIDIA GeForce RTX 4070 — a discrete GPU with room to spare. The world is drawn at Ultra.",
      "the card by name, what kind of thing it is, and what follows from it",
    );
    assert(
      classifyGpu(machine("WebKit WebGL", { hardwareConcurrency: 4 })).note ===
        "A GPU the browser will not name. The world is drawn at Medium.",
      "and a browser that will not say so is not quoted back as though it had",
    );
  });

  suite("gpu: the memory the world is held in", () => {
    const tight = classifyGpu(
      machine("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)", {
        deviceMemoryGb: 4,
      }),
    );
    assert(
      tight.quality === "high",
      "Ultra's gigabyte and a half of tile cache is not asked of a 4 GB machine",
    );
    assert(
      tight.note.includes("4 GB"),
      "and the pilot is told that is why, not left to wonder",
    );
    assert(
      classifyGpu(
        machine("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)", {
          deviceMemoryGb: 2,
        }),
      ).quality === "medium",
      "and less again on a machine with two",
    );
    assert(
      classifyGpu(
        machine("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)", {
          deviceMemoryGb: null,
        }),
      ).quality === "ultra",
      "a browser that does not report memory is not assumed to be short of it",
    );
    assert(
      classifyGpu(
        machine("ANGLE (Intel, Intel(R) UHD Graphics 620, Direct3D11)", {
          webgl2: false,
          maxSamples: 0,
        }),
      ).quality === "low",
      "and a context that cannot do WebGL 2 drops to the bottom whatever it is",
    );
  });

  suite("gpu: what the card is actually handed", () => {
    const asked = { msaaSamples: 2, fxaa: true };

    const enthusiast = classifyGpu(
      machine("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)"),
    );
    const strong = gpuAntiAliasing(asked, enthusiast);
    assert(
      strong.msaaSamples === 4,
      "a discrete card is asked for four hardware samples rather than two",
    );
    assert(
      !strong.fxaa,
      "and the full-screen FXAA pass comes off, because four samples do its job",
    );

    const integrated = gpuAntiAliasing(
      asked,
      classifyGpu(machine("ANGLE (Intel, Intel(R) UHD Graphics 620, Direct3D11)")),
    );
    assert(
      integrated.msaaSamples === 2 && integrated.fxaa,
      "integrated graphics keep the preset's two samples and the cheap pass",
    );

    const software = gpuAntiAliasing(
      asked,
      classifyGpu(machine("Mesa/X.org, llvmpipe (LLVM 15.0.7, 256 bits)")),
    );
    assert(
      software.msaaSamples === 1 && !software.fxaa,
      "a software rasteriser is asked for neither",
    );

    const capped = gpuAntiAliasing(
      asked,
      classifyGpu(
        machine("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)", {
          maxSamples: 2,
        }),
      ),
    );
    assert(
      capped.msaaSamples === 2 && capped.fxaa,
      "and nothing is asked for more samples than the context says it has",
    );

    assert(
      gpuAntiAliasing({ msaaSamples: 1, fxaa: false }, enthusiast).msaaSamples === 1,
      "a preset that asked for no anti-aliasing is not given some anyway",
    );
    assert(
      gpuAntiAliasing(asked, classifyGpu(UNKNOWN_GPU)).msaaSamples === 2,
      "an unidentified GPU is handed exactly what the preset asked for",
    );
  });

  suite("gpu: how much framebuffer the cloud march gets", () => {
    const enthusiast = classifyGpu(
      machine("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)"),
    );
    assert(
      gpuCloudMarchScale(0.7, enthusiast) === 1,
      "a card with headroom marches at the full framebuffer",
    );
    assert(
      gpuCloudMarchScale(0.5, classifyGpu(machine("ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti Direct3D11 vs_5_0 ps_5_0)"))) === 0.7,
      "a smaller card gets part of the way there",
    );
    assert(
      gpuCloudMarchScale(0.4, enthusiast) === 0.4,
      "but Low asked for cheap clouds on purpose and keeps them",
    );
    assert(
      gpuCloudMarchScale(0.7, classifyGpu(machine("Adreno (TM) 740", { mobile: true }))) ===
        0.35,
      "and a phone marches at a third whatever the preset asked for",
    );
    assert(
      gpuCloudMarchScale(0.5, classifyGpu(UNKNOWN_GPU)) === 0.5,
      "an unidentified GPU is left exactly where the preset put it",
    );
  });
}
