import { Component, type ErrorInfo, type ReactNode } from 'react';
import { BG, ON_SURFACE, PRIMARY } from '../utils/constants';
import { withAlpha } from '../utils/colorUtils';

// Last-resort catch for render crashes. Without it, any uncaught error in a
// render unmounts the entire React tree — the user sees a permanently blank
// page with no way to tell what happened. This shows the error and offers a
// reload instead.
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('App crashed:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        position: 'fixed', inset: 0, background: BG,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: 28, textAlign: 'center',
      }}>
        <h2 style={{ color: ON_SURFACE, fontSize: 20, fontWeight: 800, margin: '0 0 8px' }}>
          Something went wrong
        </h2>
        <pre style={{
          color: withAlpha(ON_SURFACE, 0.55), fontSize: 12,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          maxWidth: 480, maxHeight: 200, overflowY: 'auto',
          margin: '0 0 20px',
        }}>
          {String(this.state.error)}
        </pre>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '12px 28px', borderRadius: 14, border: 'none',
            background: PRIMARY, color: '#FFF',
            fontSize: 15, fontWeight: 700, cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
