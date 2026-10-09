// Pinned engine and model. Hashes live in code, not fetched at install time: a swapped release
// asset or Hugging Face file fails the check. Updating the engine is a deliberate edit here.

export const PARAKEET_VERSION = "v0.6.1";
export const RELEASE_URL = `https://github.com/mudler/parakeet.cpp/releases/download/${PARAKEET_VERSION}/`;

export type BuildId =
  | "macos-metal-arm64" | "macos-cpu-x64" | "linux-cpu-x64" | "linux-cpu-arm64" | "linux-vulkan-x64" | "linux-vulkan-arm64";
export type BuildPin = { asset: string; size: number; sha256: string; gpu: boolean };

export const BUILDS: Record<BuildId, BuildPin> = {
  "macos-metal-arm64": {
    asset: "parakeet-v0.6.1-bin-macos-metal-arm64.tar.gz", size: 2587801,
    sha256: "bc97b5e6253e928d1127f48f08242324317495ef8708e31db1e09b9537d1bb74", gpu: true,
  },
  "macos-cpu-x64": {
    asset: "parakeet-v0.6.1-bin-macos-cpu-x64.tar.gz", size: 2753061,
    sha256: "82392069ea091c896dcf86fb5d86f20d107c71f6bad4b9e79a114523d98fb643", gpu: false,
  },
  "linux-cpu-x64": {
    asset: "parakeet-v0.6.1-bin-linux-cpu-x64.tar.gz", size: 2727511,
    sha256: "cce60d122ab72e1068cd0d164e54a21655a0b83f1b9c21befc20124f5a972c10", gpu: false,
  },
  "linux-cpu-arm64": {
    asset: "parakeet-v0.6.1-bin-linux-cpu-arm64.tar.gz", size: 2448702,
    sha256: "85b6dafce8a984d0971d94865da5e2e50e111604fb6e7030f5b599dc2616c8db", gpu: false,
  },
  "linux-vulkan-x64": {
    asset: "parakeet-v0.6.1-bin-linux-vulkan-x64.tar.gz", size: 37493205,
    sha256: "881fd99d531a4dcfc26119a4969aec61b8390ba84e9d641716411d4c1db2de3a", gpu: true,
  },
  "linux-vulkan-arm64": {
    asset: "parakeet-v0.6.1-bin-linux-vulkan-arm64.tar.gz", size: 29743428,
    sha256: "96bc0a9ac524ea875f7260fbaed65632d55cd249e251d0f8a69d9df13dc30c9c", gpu: true,
  },
};

export type ModelPin = { file: string; url: string; size: number; sha256: string };

/** Parakeet Ultra, q8_0, at a fixed revision (not `main`). */
export const MODEL: ModelPin = {
  file: "ultra-q8_0.gguf",
  url: "https://huggingface.co/mudler/parakeet-cpp-gguf/resolve/741158ae71e64ef5c89385862c18f777d07a97a1/ultra-q8_0.gguf",
  size: 941517728,
  sha256: "c2fb452a9df468a141012b01c8c168a25ce93f710897c7de6e353c6cc250986a",
};

/** Nemotron-3 speaker diarization model, q8_0, at the same fixed revision as the main model. */
export const DIAR_MODEL: ModelPin = {
  file: "nemotron-3-diarization-q8_0.gguf",
  url: "https://huggingface.co/mudler/parakeet-cpp-gguf/resolve/741158ae71e64ef5c89385862c18f777d07a97a1/nemotron-3-diarization-q8_0.gguf",
  size: 108674624,
  sha256: "76c5bb1fb20d82706142ad32769b7ab496d2458489473a000fd7074c52ceec22",
};

/** Languages Parakeet v3 / Ultra recognizes. */
export const LANGUAGES: readonly string[] = [
  "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu",
  "it", "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk",
];
