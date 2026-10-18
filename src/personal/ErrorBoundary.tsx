import { Component, type ErrorInfo, type ReactNode } from "react";
import { describeError } from "./error-report";

const button = { padding: "8px 16px", font: "inherit", marginRight: 8 } as const;

/** Inline styles on purpose: the stylesheet may be the thing that failed. */
export function ErrorPanel({ details, onRetry }: { details: string; onRetry: () => void }) {
  return (
    <div role="alert" style={{ boxSizing: "border-box", minHeight: "100%", padding: "24px 16px", font: "14px/1.5 system-ui, sans-serif", background: "Canvas", color: "CanvasText" }}>
      <h1 style={{ margin: "0 0 8px", fontSize: 18 }}>NexBot 界面出错了</h1>
      <p style={{ margin: "0 0 12px", opacity: 0.7 }}>请把下面的内容截图或复制发给开发者。</p>
      <pre style={{ margin: "0 0 16px", padding: 12, borderRadius: 8, border: "1px solid GrayText", whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "text", font: "12px/1.5 ui-monospace, monospace" }}>{details}</pre>
      <button type="button" style={button} onClick={onRetry}>重试</button>
      <button type="button" style={button} onClick={() => location.reload()}>重新加载</button>
      <button type="button" style={button} onClick={() => { void navigator.clipboard?.writeText(details)?.catch(() => undefined); }}>复制错误</button>
    </div>
  );
}

type State = { failed: boolean; error?: unknown; componentStack: string };

/** Without a boundary React unmounts the whole tree on a render error, leaving a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, componentStack: "" };
  static getDerivedStateFromError(error: unknown): Partial<State> { return { failed: true, error }; }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("NexBot render error", error);
    this.setState({ componentStack: info.componentStack ?? "" });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <ErrorPanel details={describeError(this.state.error, this.state.componentStack)} onRetry={() => this.setState({ failed: false, error: undefined, componentStack: "" })} />;
  }
}
