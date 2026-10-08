import { expect, test } from "bun:test";
import { findVulkanLib, planBuilds } from "../../src/local/builds";

const cases = [
  // platform, arch, vulkanLib, device -> gpu, cpu
  ["darwin", "arm64", false, "auto", "macos-metal-arm64", null],
  ["darwin", "arm64", false, "cpu", null, "macos-metal-arm64"],
  ["darwin", "x64", false, "auto", null, "macos-cpu-x64"],
  ["darwin", "x64", false, "cpu", null, "macos-cpu-x64"],
  ["linux", "x64", true, "auto", "linux-vulkan-x64", "linux-cpu-x64"],
  ["linux", "x64", true, "cpu", null, "linux-cpu-x64"],
  ["linux", "x64", false, "auto", null, "linux-cpu-x64"],
  ["linux", "x64", false, "cpu", null, "linux-cpu-x64"],
  ["linux", "arm64", true, "auto", "linux-vulkan-arm64", "linux-cpu-arm64"],
  ["linux", "arm64", true, "cpu", null, "linux-cpu-arm64"],
  ["linux", "arm64", false, "auto", null, "linux-cpu-arm64"],
  ["linux", "arm64", false, "cpu", null, "linux-cpu-arm64"],
] as const;

for (const [platform, arch, vulkanLib, device, gpu, cpu] of cases) {
  test(`planBuilds ${platform} ${arch} lib=${vulkanLib} device=${device} -> gpu ${gpu}, cpu ${cpu}`, () => {
    expect(planBuilds({ platform, arch, vulkanLib, device })).toEqual({ gpu, cpu });
  });
}

const DIRS = ["/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/usr/lib64", "/usr/lib"];

for (const dir of DIRS) {
  test(`findVulkanLib finds libvulkan.so.1 in ${dir}`, () => {
    expect(findVulkanLib((p) => p === `${dir}/libvulkan.so.1`)).toBe(true);
  });
}

test("findVulkanLib is false when no listed dir has libvulkan.so.1", () => {
  const seen: string[] = [];
  const exists = (p: string) => {
    seen.push(p);
    return p === "/opt/lib/libvulkan.so.1" || p.endsWith("libvulkan.so");
  };
  expect(findVulkanLib(exists)).toBe(false);
  expect(seen).toEqual(DIRS.map((d) => `${d}/libvulkan.so.1`));
});
