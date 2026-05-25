import { Component, type ErrorInfo, type ReactNode } from 'react';

interface RouteErrorBoundaryProps {
  label: string;
  children: ReactNode;
}

interface RouteErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render-time and lazy-chunk-load errors inside a single
 * editor-tab view so a single broken pane can't blank the whole app.
 *
 * Without this, an uncaught render error inside a lazy-loaded view
 * (CodeflowView, LivePreviewView, MarkdownPreview, etc.) bubbles all the
 * way up past the Suspense fallback and React unmounts the root tree
 * — the user sees a black screen with no way to recover.
 */
export class RouteErrorBoundary extends Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  state: RouteErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RouteErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logs to the renderer devtools console so a packaged build still
    // surfaces the stack when the user opens devtools.
    // eslint-disable-next-line no-console
    console.error(
      `[${this.props.label}] render error caught by RouteErrorBoundary:`,
      error,
      info.componentStack,
    );
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full w-full items-center justify-center bg-surface p-6">
          <div className="max-w-lg text-center">
            <div className="text-[12px] font-medium text-semantic-error">
              {this.props.label} failed to render
            </div>
            <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-[6px] border border-border-subtle bg-surface-2 px-3 py-2 text-left text-[11px] text-text-muted">
              {this.state.error.message}
              {'\n\n'}
              {this.state.error.stack ?? ''}
            </pre>
            <button
              type="button"
              onClick={this.reset}
              className="mt-3 rounded-[6px] border border-border-subtle bg-surface-3 px-3 py-1.5 text-[11px] text-text-secondary transition hover:bg-surface-4 hover:text-text"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
