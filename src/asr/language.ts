/**
 * Whisper reports the detected language either as an ISO code ("en") or, in OpenAI-compatible
 * verbose_json, as its English name ("english"). This is Whisper's own code ↔ name table.
 */
const WHISPER_NAMES: Record<string, string> = {
  english: "en", chinese: "zh", german: "de", spanish: "es", russian: "ru", korean: "ko", french: "fr",
  japanese: "ja", portuguese: "pt", turkish: "tr", polish: "pl", catalan: "ca", dutch: "nl", arabic: "ar",
  swedish: "sv", italian: "it", indonesian: "id", hindi: "hi", finnish: "fi", vietnamese: "vi", hebrew: "he",
  ukrainian: "uk", greek: "el", malay: "ms", czech: "cs", romanian: "ro", danish: "da", hungarian: "hu",
  tamil: "ta", norwegian: "no", thai: "th", urdu: "ur", croatian: "hr", bulgarian: "bg", lithuanian: "lt",
  latin: "la", maori: "mi", malayalam: "ml", welsh: "cy", slovak: "sk", telugu: "te", persian: "fa",
  latvian: "lv", bengali: "bn", serbian: "sr", azerbaijani: "az", slovenian: "sl", kannada: "kn",
  estonian: "et", macedonian: "mk", breton: "br", basque: "eu", icelandic: "is", armenian: "hy",
  nepali: "ne", mongolian: "mn", bosnian: "bs", kazakh: "kk", albanian: "sq", swahili: "sw", galician: "gl",
  marathi: "mr", punjabi: "pa", sinhala: "si", khmer: "km", shona: "sn", yoruba: "yo", somali: "so",
  afrikaans: "af", occitan: "oc", georgian: "ka", belarusian: "be", tajik: "tg", sindhi: "sd",
  gujarati: "gu", amharic: "am", yiddish: "yi", lao: "lo", uzbek: "uz", faroese: "fo", "haitian creole": "ht",
  pashto: "ps", turkmen: "tk", nynorsk: "nn", maltese: "mt", sanskrit: "sa", luxembourgish: "lb",
  myanmar: "my", tibetan: "bo", tagalog: "tl", malagasy: "mg", assamese: "as", tatar: "tt", hawaiian: "haw",
  lingala: "ln", hausa: "ha", bashkir: "ba", javanese: "jw", sundanese: "su", cantonese: "yue",
};

/** ISO 639 code (primary subtag, lowercase) or null when the value is neither a code nor a known name. */
export function normalizeLanguage(raw: string | null | undefined): string | null {
  const v = raw?.trim().toLowerCase();
  if (!v) return null;
  if (/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(v) && !(v in WHISPER_NAMES)) return v.split("-")[0]!;
  return WHISPER_NAMES[v] ?? null;
}
