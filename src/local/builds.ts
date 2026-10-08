import type { Platform } from "../types";
import type { BuildId } from "./pins";

const LIB_DIRS = ["/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/usr/lib64", "/usr/lib"];

/** Vulkan builds link libvulkan.so.1 dynamically and do not start without it. Checked by path, no ldconfig. */
export function findVulkanLib(exists: (p: string) => boolean): boolean {
  return LIB_DIRS.some((d) => exists(`${d}/libvulkan.so.1`));
}

/**
 * Which builds to install and run. darwin arm64 has one binary: its CPU fallback is the same
 * Metal build run with PARAKEET_DEVICE=cpu. On Linux the CPU build is always there as the fallback.
 */
export function planBuilds(o: {
  platform: Platform; arch: "x64" | "arm64"; vulkanLib: boolean; device: "auto" | "cpu";
}): { gpu: BuildId | null; cpu: BuildId | null } {
  const auto = o.device === "auto";
  if (o.platform === "darwin") {
    if (o.arch === "arm64") return auto ? { gpu: "macos-metal-arm64", cpu: null } : { gpu: null, cpu: "macos-metal-arm64" };
    return { gpu: null, cpu: "macos-cpu-x64" };
  }
  return { gpu: auto && o.vulkanLib ? `linux-vulkan-${o.arch}` : null, cpu: `linux-cpu-${o.arch}` };
}
