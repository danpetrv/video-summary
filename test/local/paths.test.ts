import { expect, test } from "bun:test";
import { localPaths } from "../../src/local/paths";

test("localPaths: XDG dirs unset -> ~/.local/share, ~/.cache, ~/.local/state", () => {
  const p = localPaths({}, "/h");
  expect(p.binDir("linux-cpu-x64")).toBe("/h/.local/share/video-summary/parakeet/v0.6.1/linux-cpu-x64");
  expect(p.cli("macos-metal-arm64")).toBe("/h/.local/share/video-summary/parakeet/v0.6.1/macos-metal-arm64/parakeet-cli");
  expect(p.model).toBe("/h/.cache/video-summary/models/ultra-q8_0.gguf");
  expect(p.diarModel).toBe("/h/.cache/video-summary/models/nemotron-3-diarization-q8_0.gguf");
  expect(p.speedFile).toBe("/h/.local/state/video-summary/speed.json");
});

test("localPaths: XDG dirs set win; empty values are ignored", () => {
  const p = localPaths({ XDG_DATA_HOME: "/d", XDG_CACHE_HOME: "/c", XDG_STATE_HOME: "/s" }, "/h");
  expect(p.binDir("linux-vulkan-arm64")).toBe("/d/video-summary/parakeet/v0.6.1/linux-vulkan-arm64");
  expect(p.model).toBe("/c/video-summary/models/ultra-q8_0.gguf");
  expect(p.diarModel).toBe("/c/video-summary/models/nemotron-3-diarization-q8_0.gguf");
  expect(p.speedFile).toBe("/s/video-summary/speed.json");
  expect(localPaths({ XDG_DATA_HOME: "", XDG_CACHE_HOME: "", XDG_STATE_HOME: "" }, "/h").model)
    .toBe("/h/.cache/video-summary/models/ultra-q8_0.gguf");
});
