// Release notes from the commits between the previous tag and <tag>.
// GitHub's "Generate release notes" lists merged pull requests; this repo commits straight to
// main, so notes are built from conventional commit subjects instead.
//
// Usage: bun scripts/release-notes.ts <tag> [repo]   (repo defaults to $GITHUB_REPOSITORY)

export type Commit = { subject: string; body: string };

const SECTIONS: [title: string, types: string[]][] = [
  ["Features", ["feat"]],
  ["Fixes", ["fix"]],
];
const SKIP = new Set(["build"]); // bundle rebuilds, not user-facing

export function renderNotes(commits: Commit[], prevTag: string | null, tag: string, repo: string): string {
  const link = prevTag
    ? `https://github.com/${repo}/compare/${prevTag}...${tag}`
    : `https://github.com/${repo}/commits/${tag}`;
  const footer = `**Full Changelog**: ${link}\n`;
  if (!prevTag) return `Initial release.\n\n${footer}`;

  const groups = new Map<string, string[]>();
  for (const { subject, body } of commits) {
    if (/^Merge /.test(subject)) continue;
    const m = subject.match(/^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/);
    const type = m?.[1]?.toLowerCase() ?? "";
    if (SKIP.has(type)) continue;
    const text = m ? m[2]! : subject;
    const issues = [...body.matchAll(/\b(?:fixes|closes|resolves)\s+#(\d+)/gi)].map((x) => `#${x[1]}`);
    const line = `- ${text[0]!.toUpperCase()}${text.slice(1)}${issues.length ? ` (${issues.join(", ")})` : ""}`;
    const section = SECTIONS.find(([, types]) => types.includes(type))?.[0] ?? "Other";
    groups.set(section, [...(groups.get(section) ?? []), line]);
  }
  const order = [...SECTIONS.map(([t]) => t), "Other"];
  const parts = order.filter((t) => groups.has(t)).map((t) => `## ${t}\n\n${groups.get(t)!.join("\n")}\n\n`);
  return parts.join("") + footer;
}

function git(...args: string[]): string | null {
  const r = Bun.spawnSync(["git", ...args]);
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

if (import.meta.main) {
  const [tag, repoArg] = Bun.argv.slice(2);
  const repo = repoArg ?? process.env.GITHUB_REPOSITORY;
  if (!tag || !repo) {
    console.error("usage: bun scripts/release-notes.ts <tag> [owner/repo]");
    process.exit(2);
  }
  const prev = git("describe", "--tags", "--abbrev=0", `${tag}^`);
  const SEP = "\u001e"; // record separator between commits
  const log = prev ? git("log", "--no-merges", `--format=%s%n%b${SEP}`, `${prev}..${tag}`) ?? "" : "";
  const commits = log
    .split(SEP)
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [subject = "", ...rest] = c.split("\n");
      return { subject, body: rest.join("\n") };
    })
    .reverse(); // oldest first
  process.stdout.write(renderNotes(commits, prev, tag, repo));
}
