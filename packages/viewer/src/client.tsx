import type { AnalysisScope, Interpretation } from "@know-the-map/hermeneut";
import { DateTime, Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";
import { Component, type ReactNode, StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  buildViewerModel,
  type ComponentNode,
  type CoverageSummary,
  coverage,
  matchingNodes,
  type ViewerModel,
} from "./model.ts";
import { ViewerRpc, type ViewerSnapshot } from "./rpc.ts";

/** Depth at which the outline stops opening itself on a large repository. */
const OPEN_TO_DEPTH = 2;

const ROOT_KEY = "repository" as const;

const rpcLayer = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket(`${location.origin.replace(/^http/, "ws")}/rpc`)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerJson),
);

const loadSnapshot = (): Promise<ViewerSnapshot> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(ViewerRpc);
      return yield* client.getArtifact();
    }).pipe(Effect.provide(rpcLayer), Effect.scoped),
  );

/**
 * `2026-09-06 04:31 UTC`. The seconds and milliseconds are noise here — the
 * reader wants to know roughly how old the analysis is, not to the instant.
 */
const formatGeneratedAt = (at: DateTime.Utc): string =>
  `${DateTime.formatIso(at)
    .replace("T", " ")
    .replace(/:\d\d(\.\d+)?Z$/, "")} UTC`;

const kindOf = (interpretation: Interpretation): string =>
  interpretation.kind === "other" ? interpretation.customKind : interpretation.kind;

/** Keys from the repository root down to `key`, root first. */
const trailTo = (model: ViewerModel, key: string): ReadonlyArray<ComponentNode> => {
  const trail: Array<ComponentNode> = [];
  let current = model.nodesByKey.get(key);
  while (current !== undefined) {
    trail.unshift(current);
    current = current.parentKey === null ? undefined : model.nodesByKey.get(current.parentKey);
  }
  return trail;
};

interface SpineProps {
  readonly model: ViewerModel;
  readonly selected: string;
  readonly repositoryName: string;
  readonly onSelect: (key: string) => void;
}

/**
 * The path to the current scope, drawn as the identity's own grammar: nodes
 * joined by routes, with Signal marking the one node under examination. The
 * brand manual reserves Signal for exactly this — "one change, focus, or
 * transition" — so it appears here and nowhere else on the page.
 */
const Spine = ({ model, selected, repositoryName, onSelect }: SpineProps) => {
  const trail = trailTo(model, selected);
  return (
    <nav className="spine" aria-label="Path to the current scope">
      <button
        type="button"
        className={selected === ROOT_KEY ? "spine-node current" : "spine-node"}
        aria-current={selected === ROOT_KEY ? "true" : undefined}
        onClick={() => onSelect(ROOT_KEY)}
      >
        {repositoryName}
      </button>
      {trail.map((node, index) => (
        <button
          type="button"
          key={node.key}
          className={index === trail.length - 1 ? "spine-node current" : "spine-node"}
          aria-current={index === trail.length - 1 ? "true" : undefined}
          onClick={() => onSelect(node.key)}
        >
          {node.component.name}
        </button>
      ))}
    </nav>
  );
};

interface OutlineProps {
  readonly nodes: ReadonlyArray<ComponentNode>;
  readonly model: ViewerModel;
  readonly selected: string;
  readonly visible: ReadonlySet<string>;
  readonly opened: ReadonlySet<string>;
  readonly searching: boolean;
  readonly onSelect: (key: string) => void;
  readonly onToggle: (key: string) => void;
}

const Outline = (props: OutlineProps) => {
  const { nodes, model, selected, visible, opened, searching, onSelect, onToggle } = props;
  return (
    <ul>
      {nodes
        .filter((node) => visible.has(node.key))
        .map((node) => {
          const isOpen = searching || opened.has(node.key);
          const hasChildren = node.children.length > 0;
          return (
            <li key={node.key}>
              <div className="outline-row">
                {hasChildren ? (
                  <button
                    type="button"
                    className="disclosure"
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.component.name}`}
                    onClick={() => onToggle(node.key)}
                  >
                    {isOpen ? "▾" : "▸"}
                  </button>
                ) : (
                  <span className="disclosure-gap" aria-hidden="true" />
                )}
                <button
                  type="button"
                  className={selected === node.key ? "outline-item selected" : "outline-item"}
                  aria-current={selected === node.key ? "true" : undefined}
                  onClick={() => onSelect(node.key)}
                >
                  <span className="outline-name">{node.component.name}</span>
                  {node.leaf?.kind === "gap" ? (
                    <span className="tag gap">unexplored</span>
                  ) : (
                    <span className="tag count">{node.component.files.length}</span>
                  )}
                </button>
              </div>
              {isOpen && hasChildren && <Outline {...props} nodes={node.children} model={model} />}
            </li>
          );
        })}
    </ul>
  );
};

const Claim = ({ interpretation }: { readonly interpretation: Interpretation }) => (
  <li className="claim">
    <div className="claim-head">
      <span className="claim-kind">{kindOf(interpretation)}</span>
    </div>
    <p>{interpretation.text}</p>
    <ul className="anchors">
      {interpretation.anchors.map((anchor) => (
        <li key={`${anchor.path}:${anchor.lineStart}:${anchor.lineEnd}`}>
          <code>
            {anchor.path}
            <span className="lines">
              :{anchor.lineStart}&ndash;{anchor.lineEnd}
            </span>
          </code>
        </li>
      ))}
    </ul>
  </li>
);

interface ScopeViewProps {
  readonly scope: AnalysisScope;
  readonly node: ComponentNode | undefined;
  readonly repositoryName: string;
  readonly onSelect: (key: string) => void;
}

const ScopeView = ({ scope, node, repositoryName, onSelect }: ScopeViewProps) => {
  const result = scope.result;
  return (
    <>
      <header className="scope-head">
        <h1>{node?.component.name ?? repositoryName}</h1>
        {node !== undefined && <p className="summary">{node.component.summary}</p>}
        {result.kind === "module" && <p className="summary">{result.summary}</p>}
      </header>

      {result.kind === "gap" && (
        <section className="region unexplored" aria-labelledby="unexplored-heading">
          <h2 id="unexplored-heading">Never explored</h2>
          <p>
            The run stopped before reaching this part
            {result.reason === "call_budget"
              ? " because it ran out of model calls."
              : " because it hit the division-depth limit."}
          </p>
          <p className="detail">{result.message}</p>
        </section>
      )}

      {result.kind === "division" && (
        <section className="region" aria-labelledby="parts-heading">
          <h2 id="parts-heading">
            Parts <span className="count">{result.components.length}</span>
          </h2>
          <ul className="parts">
            {result.components.map((part) => (
              <li key={part.id}>
                <button type="button" onClick={() => onSelect(`${scope.id}:${part.id}`)}>
                  <span className="part-name">{part.name}</span>
                  <span className="part-summary">{part.summary}</span>
                  <span className="part-files">
                    {part.files.length} {part.files.length === 1 ? "file" : "files"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.kind === "division" && result.relationships.length > 0 && (
        <section className="region" aria-labelledby="routes-heading">
          <h2 id="routes-heading">
            Routes <span className="count">{result.relationships.length}</span>
          </h2>
          <ul className="routes">
            {result.relationships.map((route) => (
              <li key={route.id}>
                <p className="route-line">
                  <span className="endpoint">{route.from}</span>
                  <span className="route-kind">
                    {route.kind === "other" ? route.customKind : route.kind}
                  </span>
                  <span className="endpoint">{route.to}</span>
                </p>
                <p className="detail">{route.description}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.kind !== "gap" && (
        <section className="region" aria-labelledby="claims-heading">
          <h2 id="claims-heading">
            Interpretations <span className="count">{result.interpretations.length}</span>
          </h2>
          {result.interpretations.length === 0 ? (
            <p className="detail">Nothing was claimed about this scope.</p>
          ) : (
            <ul className="claims">
              {result.interpretations.map((interpretation) => (
                <Claim key={interpretation.id} interpretation={interpretation} />
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="region" aria-labelledby="files-heading">
        <h2 id="files-heading">
          Files <span className="count">{scope.inputPaths.length}</span>
        </h2>
        <ul className="files">
          {scope.inputPaths.map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
};

const CoverageStrip = ({ summary }: { readonly summary: CoverageSummary }) => {
  const percent = Math.round(summary.fraction * 100);
  return (
    <div className="coverage" title={`${summary.exploredFiles} of ${summary.totalFiles} files`}>
      <span className="coverage-label">explored</span>
      {/* The bar restates the number beside it, so it is decorative. */}
      <span className="coverage-track" aria-hidden="true">
        <span className="coverage-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="coverage-value">
        {percent}%
        <span className="sr-only">
          {" "}
          of {summary.totalFiles} submitted files reached an explored leaf
        </span>
      </span>
      {summary.gapScopeCount > 0 && (
        <span className="tag gap">
          {summary.gapScopeCount} {summary.gapScopeCount === 1 ? "gap" : "gaps"}
        </span>
      )}
    </div>
  );
};

const Workspace = ({ snapshot }: { readonly snapshot: ViewerSnapshot }) => {
  const model = useMemo(() => buildViewerModel(snapshot.artifact), [snapshot.artifact]);
  const summary = useMemo(() => coverage(snapshot.artifact), [snapshot.artifact]);
  const [selected, setSelected] = useState<string>(() => location.hash.slice(1) || ROOT_KEY);
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => {
    // Opened rather than collapsed: a real repository has hundreds of
    // components, and defaulting to open renders the whole tree as a wall.
    const initial = new Set<string>();
    const walk = (nodes: ReadonlyArray<ComponentNode>, depth: number): void => {
      for (const node of nodes) {
        if (depth < OPEN_TO_DEPTH) initial.add(node.key);
        walk(node.children, depth + 1);
      }
    };
    walk(model.roots, 0);
    return initial;
  });

  useEffect(() => {
    const onPop = () => setSelected(location.hash.slice(1) || ROOT_KEY);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const visible = useMemo(() => matchingNodes(model, query), [model, query]);
  const node = model.nodesByKey.get(selected);
  const scope = node?.childScope ?? model.rootScope;

  const select = (key: string): void => {
    if (key !== selected) {
      history.pushState(null, "", key === ROOT_KEY ? location.pathname : `#${key}`);
    }
    setSelected(key);
    const ancestors = new Set(opened);
    for (const ancestor of trailTo(model, key)) ancestors.add(ancestor.key);
    setOpened(ancestors);
  };

  const unknown = selected !== ROOT_KEY && node === undefined;

  return (
    <div className="workspace">
      <header className="masthead">
        <div className="identity">
          <span className="mark" aria-hidden="true" />
          <div>
            <strong>{snapshot.repositoryName}</strong>
            <span className="revision">
              <code>{snapshot.artifact.headCommit.slice(0, 12)}</code>
              <time dateTime={DateTime.formatIso(snapshot.artifact.generatedAt)}>
                {formatGeneratedAt(snapshot.artifact.generatedAt)}
              </time>
            </span>
          </div>
        </div>
        <CoverageStrip summary={summary} />
      </header>

      <nav className="outline" aria-label="Components">
        <label className="search">
          <span className="sr-only">Search components and file paths</span>
          <input
            type="search"
            placeholder="Search components or paths"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={selected === ROOT_KEY ? "outline-item root selected" : "outline-item root"}
          aria-current={selected === ROOT_KEY ? "true" : undefined}
          onClick={() => select(ROOT_KEY)}
        >
          <span className="outline-name">Repository</span>
        </button>
        <Outline
          nodes={model.roots}
          model={model}
          selected={selected}
          visible={visible}
          opened={opened}
          searching={query.trim() !== ""}
          onSelect={select}
          onToggle={(key) => {
            const next = new Set(opened);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            setOpened(next);
          }}
        />
        {query.trim() !== "" && visible.size === 0 && (
          <p className="detail empty">Nothing matches that.</p>
        )}
      </nav>

      <main className="detail-pane">
        {unknown ? (
          <section className="region">
            <h1>Not in this analysis</h1>
            <p className="detail">
              That component is not part of the saved analysis. It may be from an older run.
            </p>
            <button type="button" className="linkish" onClick={() => select(ROOT_KEY)}>
              Back to the repository
            </button>
          </section>
        ) : (
          <>
            <Spine
              model={model}
              selected={selected}
              repositoryName={snapshot.repositoryName}
              onSelect={select}
            />
            <ScopeView
              scope={scope}
              node={node}
              repositoryName={snapshot.repositoryName}
              onSelect={select}
            />
          </>
        )}
      </main>
    </div>
  );
};

interface BoundaryState {
  readonly message: string | undefined;
}

/**
 * `buildViewerModel` throws on an artifact that passed the wire schema but
 * breaks an invariant it does not carry. Without a boundary that is a blank
 * page; with one it is a message naming the problem.
 */
class Boundary extends Component<{ readonly children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { message: undefined };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override render(): ReactNode {
    if (this.state.message === undefined) return this.props.children;
    return (
      <main className="notice">
        <h1>This analysis could not be read</h1>
        <p className="detail">{this.state.message}</p>
        <p className="detail">Regenerate it with `ktm analyze`.</p>
      </main>
    );
  }
}

const App = () => {
  const [snapshot, setSnapshot] = useState<ViewerSnapshot>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    let live = true;
    loadSnapshot().then(
      (loaded) => {
        if (live) setSnapshot(loaded);
      },
      (cause: unknown) => {
        if (live) setFailure(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  if (failure !== undefined) {
    return (
      <main className="notice">
        <h1>Lost the connection</h1>
        <p className="detail">{failure}</p>
        <p className="detail">The viewer stops when its terminal does. Restart `ktm view`.</p>
      </main>
    );
  }
  if (snapshot === undefined) {
    return (
      <main className="notice">
        <p role="status">Reading the saved analysis&hellip;</p>
      </main>
    );
  }
  return <Workspace snapshot={snapshot} />;
};

const root = document.getElementById("root");
if (root === null) throw new Error("viewer root element is missing");
createRoot(root).render(
  <StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </StrictMode>,
);
