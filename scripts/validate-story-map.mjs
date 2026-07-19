import { readFile } from "node:fs/promises";
import ts from "typescript";

const map = JSON.parse(await readFile("docs/design/ui-map.json", "utf8"));
const index = JSON.parse(await readFile("storybook-static/index.json", "utf8"));
const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const available = new Set(
  Object.values(index.entries)
    .filter((entry) => entry.type === "story")
    .map((entry) => `${normalize(entry.title)}/${normalize(entry.name)}`),
);
const expected = [
  ...map.routeCompositions,
  ...map.components.flatMap((component) => component.storybookStories),
];
const missing = expected.filter((story) => {
  const [title, name] = story.split("/");
  return !available.has(`${normalize(title)}/${normalize(name)}`);
});

if (missing.length > 0) {
  console.error("Missing Storybook stories declared by docs/design/ui-map.json:");
  for (const story of missing) console.error(`  - ${story}`);
  process.exit(1);
}

const forbiddenPhase4Literals = new Set(["microsoft-onedrive", "send-mail", "save-to-onedrive", "disconnect-account"]);
const activePhase3Paths = [
  "src/ui/ProfileSettings.tsx",
  "src/ui/ProfileSettings.stories.tsx",
  "src/ui/BookSearch.tsx",
  "src/ui/BookSearch.stories.tsx",
  "src/ui/DeliveryPreflight.tsx",
  "src/ui/DeliveryPreflight.stories.tsx",
  "src/ui/OperationTimeline.tsx",
  "src/ui/OperationTimeline.stories.tsx",
];
const futureProviderPattern = /gmail-api|gmail\.send|submitted by gmail|microsoft|onedrive/i;
for (const path of activePhase3Paths) {
  const sourceText = await readFile(path, "utf8");
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const forbiddenLiteral = forbiddenPhase4Literals.has(node.text);
      const futureProviderLiteral = futureProviderPattern.test(node.text);
      if (forbiddenLiteral || futureProviderLiteral) {
        console.error(`Phase 4 literal '${node.text}' is present in active Phase 3 reference ${path}`);
        process.exitCode = 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (process.exitCode) process.exit(process.exitCode);

console.log(`STORY-MAP: PASS (${expected.length} declarations resolve to built stories; active Phase 3 references contain no future provider literals)`);