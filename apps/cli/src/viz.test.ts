import { expect, test } from "bun:test";
import type { AnalysisArtifact } from "@know-the-map/hermeneut";
import { renderVizHtml } from "./viz.ts";

const artifact = {
  headCommit: "abc123def456",
  generatedAt: "2026-08-31T19:18:05.465Z",
  components: [
    { id: 1, name: "alpha", summary: "does a", files: ["src/a.ts"] },
    {
      id: 2,
      name: "beta",
      summary: "does b </script><script>alert(1)</script>",
      files: ["src/b.ts"],
    },
  ],
  relationships: [
    { id: 3, from: "alpha", to: "beta", kind: "uses", description: "alpha uses beta" },
  ],
  interpretations: [
    {
      id: 4,
      kind: "role",
      text: "alpha orchestrates beta",
      anchors: [{ path: "src/a.ts", lineStart: 1, lineEnd: 3 }],
    },
  ],
  files: [
    { path: "src/a.ts", hash: "aaaa", lineCount: 10 },
    { path: "src/b.ts", hash: "bbbb", lineCount: 5 },
  ],
} as const satisfies AnalysisArtifact;

test("renderVizHtml embeds the artifact and its data", () => {
  const html = renderVizHtml(artifact);
  expect(html).toContain("cytoscape.min.js");
  expect(html).toContain('"name":"alpha"');
  expect(html).toContain('"kind":"uses"');
  expect(html).toContain('"alpha orchestrates beta"');
});

test("renderVizHtml escapes script-breaking sequences", () => {
  const html = renderVizHtml(artifact);
  expect(html).toContain("\\u003c/script>");
  expect(html).not.toContain("</script>alert(1)");
});
