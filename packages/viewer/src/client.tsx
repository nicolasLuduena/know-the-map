import type { Anchor, Interpretation } from "@know-the-map/hermeneut";
import { DateTime, Schema } from "effect";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  buildViewerModel,
  type ComponentNode,
  componentKey,
  matchingNodes,
  ROOT_KEY,
} from "./model.ts";
import {
  SourceResponse,
  type SourceSelection,
  ViewerErrorResponse,
  ViewerResponse,
} from "./protocol.ts";

const token = new URL(location.href).searchParams.get("token") ?? "";
const api = (path: string): string =>
  `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
const readResponse = async (response: Response): Promise<string> => {
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      Schema.decodeUnknownSync(Schema.fromJsonString(ViewerErrorResponse))(text).message,
    );
  return text;
};

interface TreeNodeProps {
  readonly node: ComponentNode;
  readonly selected: string;
  readonly visible: ReadonlySet<string>;
  readonly collapsed: ReadonlySet<string>;
  readonly searching: boolean;
  readonly onToggle: (key: string) => void;
  readonly onSelect: (key: string) => void;
}
const TreeNode = (props: TreeNodeProps) => {
  const { node, selected, visible, collapsed, searching, onToggle, onSelect } = props;
  if (!visible.has(node.key)) return null;
  const expanded = searching || !collapsed.has(node.key);
  return (
    <li>
      <div className="tree-row">
        {node.children.length > 0 ? (
          <button
            type="button"
            className="expand"
            aria-label={`${expanded ? "Collapse" : "Expand"} ${node.component.name}`}
            aria-expanded={expanded}
            onClick={() => onToggle(node.key)}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="expand-spacer" />
        )}
        <button
          type="button"
          className={selected === node.key ? "tree-item selected" : "tree-item"}
          aria-current={selected === node.key ? "page" : undefined}
          onClick={() => onSelect(node.key)}
        >
          <span className="node-mark" />
          {node.component.name}
          <span className="file-count">{node.component.files.length}</span>
        </button>
      </div>
      {expanded && node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <TreeNode {...props} key={child.key} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
};

interface EvidenceProps {
  readonly interpretation: Interpretation;
  readonly onOpen: (selection: SourceSelection) => void;
}
const Evidence = ({ interpretation, onOpen }: EvidenceProps) => (
  <article className="interpretation">
    <div className="claim-head">
      <span className="kind">
        {interpretation.kind === "other" ? interpretation.customKind : interpretation.kind}
      </span>
    </div>
    <p>{interpretation.text}</p>
    <div className="anchors">
      {interpretation.anchors.map((anchor: Anchor, index) => (
        <button
          type="button"
          key={`${anchor.path}:${anchor.lineStart}:${anchor.lineEnd}:${index}`}
          onClick={() => onOpen({ path: anchor.path, anchor })}
        >
          {anchor.path}
          <span>
            :{anchor.lineStart}–{anchor.lineEnd}
          </span>
        </button>
      ))}
    </div>
  </article>
);

const App = () => {
  const [data, setData] = useState<ViewerResponse>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState(() => location.hash.slice(1) || ROOT_KEY);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<SourceSelection>();
  const [source, setSource] = useState<SourceResponse>();
  const [sourceError, setSourceError] = useState<string>();
  const requestId = useRef(0);
  const sourcePane = useRef<HTMLElement>(null);
  const sourceTrigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let active = true;
    fetch(api("/api/artifact"))
      .then(readResponse)
      .then(Schema.decodeUnknownSync(Schema.fromJsonString(ViewerResponse)))
      .then((response) => {
        if (active) setData(response);
      })
      .catch((cause: Error) => {
        if (active) setError(cause.message);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const onPop = () => {
      requestId.current++;
      setSelection(undefined);
      setSource(undefined);
      setSelected(location.hash.slice(1) || ROOT_KEY);
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (selection === undefined) return;
    const id = ++requestId.current;
    const range =
      selection.anchor === undefined
        ? ""
        : `&lineStart=${selection.anchor.lineStart}&lineEnd=${selection.anchor.lineEnd}`;
    fetch(api(`/api/source?path=${encodeURIComponent(selection.path)}${range}`))
      .then(readResponse)
      .then(Schema.decodeUnknownSync(Schema.fromJsonString(SourceResponse)))
      .then((response) => {
        if (id === requestId.current) setSource(response);
      })
      .catch((cause: Error) => {
        if (id === requestId.current) setSourceError(cause.message);
      });
    return () => {
      requestId.current++;
    };
  }, [selection]);
  useEffect(() => {
    if (source === undefined && sourceError === undefined) return;
    const pane = sourcePane.current;
    if (pane === null) return;
    pane.focus({ preventScroll: true });
    const line = pane.querySelector<HTMLElement>(".highlighted");
    if (line !== null) pane.scrollTop = Math.max(0, line.offsetTop - pane.clientHeight / 3);
    if (matchMedia("(max-width: 1100px)").matches) pane.scrollIntoView({ block: "nearest" });
  }, [source, sourceError]);

  const model = useMemo(
    () => (data === undefined ? undefined : buildViewerModel(data.artifact)),
    [data],
  );
  const visible = useMemo(
    () => (model === undefined ? new Set<string>() : matchingNodes(model, query)),
    [model, query],
  );
  if (error !== undefined)
    return (
      <main className="center-state">
        <h1>Analysis unavailable</h1>
        <p>{error}</p>
      </main>
    );
  if (data === undefined || model === undefined)
    return (
      <main className="center-state">
        <p role="status">Loading saved analysis…</p>
      </main>
    );
  const { artifact, repositoryName } = data;
  const node = model.byKey.get(selected);
  const scope = node?.childScope ?? model.rootScope;
  const children = node?.children ?? model.nodes;
  const breadcrumbs: ComponentNode[] = [];
  let ancestor = node;
  while (ancestor !== undefined) {
    breadcrumbs.unshift(ancestor);
    ancestor = model.byKey.get(ancestor.parentKey);
  }
  const select = (key: string) => {
    if (key !== selected)
      history.pushState(
        null,
        "",
        key === ROOT_KEY ? location.pathname + location.search : `#${key}`,
      );
    setSelected(key);
    requestId.current++;
    setSelection(undefined);
    setSource(undefined);
    const ancestors = new Set(collapsed);
    let current = model.byKey.get(key);
    while (current !== undefined) {
      ancestors.delete(current.parentKey);
      current = model.byKey.get(current.parentKey);
    }
    setCollapsed(ancestors);
  };
  const openSource = (next: SourceSelection) => {
    sourceTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestId.current++;
    setSource(undefined);
    setSourceError(undefined);
    setSelection(next);
  };
  const closeSource = () => {
    requestId.current++;
    setSelection(undefined);
    setSource(undefined);
    sourceTrigger.current?.focus({ preventScroll: true });
  };
  const parent = node?.parentScope;
  const relationships =
    parent?.result.kind === "division" && node !== undefined
      ? parent.result.relationships.filter(
          (relationship) =>
            relationship.from === node.component.name || relationship.to === node.component.name,
        )
      : [];
  const endpointKey = (name: string): string => {
    if (parent?.result.kind !== "division") throw new Error("relationship has no parent division");
    const component = parent.result.components.find((candidate) => candidate.name === name);
    if (component === undefined)
      throw new Error("relationship target is missing from validated scope");
    return componentKey(parent.id, component.id);
  };
  const unknownSelection = selected !== ROOT_KEY && node === undefined;
  return (
    <div className={selection === undefined ? "app" : "app source-open"}>
      <header>
        <div className="brand">
          <span className="brand-symbol">K</span>
          <div>
            <strong>Know the Map</strong>
            <span className="brand-caption">Saved analysis</span>
          </div>
        </div>
        <div className="repo-meta">
          <strong>{repositoryName}</strong>
          <code title={artifact.headCommit}>{artifact.headCommit.slice(0, 12)}</code>
          <time dateTime={DateTime.formatIso(artifact.generatedAt)}>
            {DateTime.formatIso(artifact.generatedAt).replace("T", " ").replace(".000Z", " UTC")}
          </time>
        </div>
        <label className="search">
          <span className="sr-only">Search components and files</span>
          <input
            type="search"
            placeholder="Search components or files"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </header>
      <nav className="sidebar" aria-label="Component hierarchy">
        <button
          type="button"
          className={selected === ROOT_KEY ? "root-link selected" : "root-link"}
          aria-current={selected === ROOT_KEY ? "page" : undefined}
          onClick={() => select(ROOT_KEY)}
        >
          Repository
        </button>
        <ul className="tree">
          {model.nodes.map((item) => (
            <TreeNode
              key={item.key}
              node={item}
              selected={selected}
              visible={visible}
              collapsed={collapsed}
              searching={query.trim() !== ""}
              onSelect={select}
              onToggle={(key) => {
                const next = new Set(collapsed);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                setCollapsed(next);
              }}
            />
          ))}
        </ul>
        {query !== "" && visible.size === 0 && <p className="empty">No matching components.</p>}
      </nav>
      <main className="detail">
        {unknownSelection ? (
          <section>
            <h1>Component unavailable</h1>
            <p>This component is not in the saved analysis.</p>
            <button type="button" onClick={() => select(ROOT_KEY)}>
              Return to repository
            </button>
          </section>
        ) : (
          <>
            <div className="breadcrumb">
              <button type="button" onClick={() => select(ROOT_KEY)}>
                Repository
              </button>
              {breadcrumbs.map((item) => (
                <span key={item.key}>
                  {" "}
                  /{" "}
                  <button type="button" onClick={() => select(item.key)}>
                    {item.component.name}
                  </button>
                </span>
              ))}
            </div>
            <div className="detail-title">
              <h1>{node?.component.name ?? repositoryName}</h1>
              <span className="scope-type">
                {scope.result.kind === "division" ? "Contains components" : "Module"}
              </span>
            </div>
            <p className="summary">
              {node?.component.summary ??
                (scope.result.kind === "module"
                  ? scope.result.summary
                  : `${artifact.components.length} components · ${artifact.files.length} files in this saved analysis.`)}
            </p>
            {node !== undefined && scope.result.kind === "module" && (
              <section>
                <h2>Exploration summary</h2>
                <p>{scope.result.summary}</p>
              </section>
            )}
            {children.length > 0 && (
              <section>
                <h2>Inside {node?.component.name ?? "this repository"}</h2>
                <div className="children">
                  {children.map((child) => (
                    <button type="button" key={child.key} onClick={() => select(child.key)}>
                      <strong>{child.component.name}</strong>
                      <span>{child.component.summary}</span>
                      <small>{child.component.files.length} files →</small>
                    </button>
                  ))}
                </div>
              </section>
            )}
            {relationships.length > 0 && (
              <section>
                <h2>
                  Connections <span>{relationships.length}</span>
                </h2>
                <div className="relationships">
                  {relationships.map((relationship) => (
                    <div key={relationship.id} className="relationship">
                      <div>
                        <button
                          type="button"
                          onClick={() => select(endpointKey(relationship.from))}
                        >
                          {relationship.from}
                        </button>
                        <span className="route">
                          {" "}
                          →{" "}
                          {relationship.kind === "other"
                            ? relationship.customKind
                            : relationship.kind}{" "}
                          →{" "}
                        </span>
                        <button type="button" onClick={() => select(endpointKey(relationship.to))}>
                          {relationship.to}
                        </button>
                      </div>
                      <p>{relationship.description}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}
            <section>
              <h2>
                Interpretations <span>{scope.result.interpretations.length}</span>
              </h2>
              <p className="section-note">
                Recorded for this scope; inspect the cited source to verify each claim.
              </p>
              {scope.result.interpretations.length === 0 ? (
                <p>No interpretations recorded for this scope.</p>
              ) : (
                scope.result.interpretations.map((item) => (
                  <Evidence key={item.id} interpretation={item} onOpen={openSource} />
                ))
              )}
            </section>
            <section>
              <h2>
                {node ? "Associated files" : "Files in analysis"}{" "}
                <span>{node?.component.files.length ?? artifact.files.length}</span>
              </h2>
              <div className="files">
                {(node?.component.files ?? artifact.files.map((file) => file.path)).map((path) => (
                  <button type="button" key={path} onClick={() => openSource({ path })}>
                    <span>↗</span>
                    {path}
                  </button>
                ))}
              </div>
            </section>
          </>
        )}
      </main>
      {selection !== undefined && (
        <aside ref={sourcePane} className="source" aria-label="Source evidence" tabIndex={-1}>
          <div className="source-head">
            <div>
              <strong title={selection.path}>{selection.path}</strong>
              <span>
                {selection.anchor === undefined
                  ? "Snapshot source"
                  : `Lines ${selection.anchor.lineStart}–${selection.anchor.lineEnd}`}{" "}
                · {artifact.headCommit.slice(0, 12)}
              </span>
            </div>
            <button type="button" aria-label="Close source" onClick={closeSource}>
              ×
            </button>
          </div>
          {sourceError !== undefined ? (
            <div className="source-state" role="alert">
              <strong>Source unavailable</strong>
              <p>{sourceError}</p>
            </div>
          ) : source === undefined ? (
            <div className="source-state" role="status">
              Loading snapshot…
            </div>
          ) : source.content === "" ? (
            <div className="source-state">This file is empty.</div>
          ) : (
            <pre>
              {source.content
                .replace(/\n$/, "")
                .split("\n")
                .map((line, index) => {
                  const number = index + 1;
                  const highlighted =
                    selection.anchor !== undefined &&
                    number >= selection.anchor.lineStart &&
                    number <= selection.anchor.lineEnd;
                  return (
                    <span key={number} className={highlighted ? "line highlighted" : "line"}>
                      <b>{number}</b>
                      <code>{line || " "}</code>
                    </span>
                  );
                })}
            </pre>
          )}
        </aside>
      )}
    </div>
  );
};

const root = document.getElementById("root");
if (root === null) throw new Error("viewer root element is missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
