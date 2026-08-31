import type { AnalysisArtifact } from "@know-the-map/hermeneut";

export const VIZ_OUTPUT_PATH = ".ktm/analysis.html";

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Prevent `</script>` inside interpretation text from closing the tag. */
const inlineJson = (value: AnalysisArtifact): string =>
  JSON.stringify(value).replace(/</g, "\\u003c");

export const renderVizHtml = (artifact: AnalysisArtifact): string => {
  const payload = inlineJson(artifact);
  const head = escapeHtml(artifact.headCommit.slice(0, 12));
  const generatedAt = escapeHtml(artifact.generatedAt);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>ktm map</title>
<script src="https://unpkg.com/cytoscape@3/dist/cytoscape.min.js"></script>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, sans-serif; background: #F5F1E8; color: #0B1F2A; }
  header { display: flex; gap: 1.5rem; align-items: baseline; padding: 0.75rem 1.25rem; border-bottom: 2px solid #0B1F2A; }
  header h1 { margin: 0; font-size: 1rem; letter-spacing: 0.05em; }
  header .stat { font-size: 0.8rem; color: #456; }
  header .stat b { color: #2F7F78; }
  main { display: flex; height: calc(100vh - 46px); }
  #graph { flex: 1; min-width: 0; }
  aside { width: 380px; border-left: 2px solid #0B1F2A; overflow-y: auto; padding: 1rem 1.25rem; background: #FBF8F1; }
  aside h2 { margin: 0 0 0.25rem; font-size: 1rem; }
  aside h3 { margin: 1rem 0 0.35rem; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #2F7F78; }
  aside p { margin: 0.25rem 0; font-size: 0.85rem; line-height: 1.45; }
  aside ul { margin: 0.25rem 0; padding-left: 1.1rem; font-size: 0.8rem; }
  code { font-family: ui-monospace, monospace; font-size: 0.72rem; background: #EAE4D6; padding: 0 0.25rem; border-radius: 3px; }
  .kind { display: inline-block; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.06em; background: #2F7F78; color: #F5F1E8; padding: 0.1rem 0.4rem; border-radius: 3px; margin-right: 0.35rem; vertical-align: 1px; }
  .interp { margin: 0.6rem 0; padding-left: 0.6rem; border-left: 2px solid #EAE4D6; }
  .interp .anchors { margin-top: 0.25rem; display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .placeholder { color: #789; font-size: 0.85rem; }
</style>
</head>
<body>
<header>
  <h1>ktm map</h1>
  <span class="stat"><b>${artifact.components.length}</b> components</span>
  <span class="stat"><b>${artifact.relationships.length}</b> relationships</span>
  <span class="stat"><b>${artifact.interpretations.length}</b> interpretations</span>
  <span class="stat">head <b>${head}</b></span>
  <span class="stat">${generatedAt}</span>
</header>
<main>
  <div id="graph"></div>
  <aside id="details"><p class="placeholder">Click a component or an edge.</p></aside>
</main>
<script>
  const ARTIFACT = ${payload};
  const elements = ARTIFACT.components.map(function (c) {
    return { data: { id: c.name, label: c.name, summary: c.summary, files: c.files, nfiles: c.files.length } };
  });
  ARTIFACT.relationships.forEach(function (r) {
    elements.push({ data: { id: "r" + r.id, source: r.from, target: r.to, kind: r.kind, description: r.description } });
  });

  const cy = cytoscape({
    container: document.getElementById("graph"),
    elements: elements,
    layout: { name: "cose", padding: 30, animate: false, nodeOverlap: 20 },
    style: [
      { selector: "node", style: {
        "background-color": "#2F7F78", label: "data(label)", color: "#F5F1E8",
        width: "mapData(nfiles, 1, 20, 26, 90)", height: "mapData(nfiles, 1, 20, 26, 90)",
        "font-size": 11, "text-valign": "center", "text-wrap": "wrap", "text-max-width": "80px",
        shape: "round-rectangle" } },
      { selector: "edge", style: {
        width: 1.5, "line-color": "#9a9488", "target-arrow-color": "#9a9488",
        "target-arrow-shape": "triangle", "curve-style": "bezier",
        label: "data(kind)", "font-size": 9, color: "#667",
        "text-background-color": "#F5F1E8", "text-background-opacity": 1, "text-background-padding": 2 } },
      { selector: "node:selected", style: { "background-color": "#C7F23D", color: "#0B1F2A" } },
      { selector: "edge:selected", style: { "line-color": "#C7F23D", "target-arrow-color": "#C7F23D", width: 3 } }
    ]
  });

  function esc(s) {
    const d = document.createElement("span");
    d.textContent = s === null || s === undefined ? "" : String(s);
    return d.innerHTML;
  }

  function showNode(node) {
    const c = node.data();
    const mine = ARTIFACT.interpretations.filter(function (i) {
      return i.anchors.some(function (a) { return c.files.indexOf(a.path) !== -1; });
    });
    let html = "<h2>" + esc(c.label) + "</h2><p>" + esc(c.summary) + "</p>";
    html += "<h3>files (" + c.files.length + ")</h3><ul>" +
      c.files.map(function (f) { return "<li><code>" + esc(f) + "</code></li>"; }).join("") + "</ul>";
    html += "<h3>interpretations (" + mine.length + ")</h3>" + mine.map(function (i) {
      const anchors = i.anchors.map(function (a) {
        return "<code>" + esc(a.path) + ":" + a.lineStart + "-" + a.lineEnd + "</code>";
      }).join(" ");
      return '<div class="interp"><span class="kind">' + esc(i.kind) + "</span>" + esc(i.text) +
        '<div class="anchors">' + anchors + "</div></div>";
    }).join("");
    document.getElementById("details").innerHTML = html;
  }

  function showEdge(edge) {
    const e = edge.data();
    document.getElementById("details").innerHTML =
      "<h2>" + esc(e.source) + " &rarr; " + esc(e.target) + "</h2>" +
      '<p><span class="kind">' + esc(e.kind) + "</span>" + esc(e.description) + "</p>";
  }

  cy.on("tap", "node", function (evt) { showNode(evt.target); });
  cy.on("tap", "edge", function (evt) { showEdge(evt.target); });
</script>
</body>
</html>
`;
};
