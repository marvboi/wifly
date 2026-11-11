import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode; label?: string; fallback?: ReactNode }
type State = { broken: boolean }

/** speed.12: one broken widget stays broken; the rest of the page keeps working. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { broken: false }
  static getDerivedStateFromError() { return { broken: true } }
  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error(`[wifly] ${this.props.label ?? 'section'} crashed:`, err?.message, info?.componentStack?.slice(0, 200))
  }
  render() {
    if (!this.state.broken) return this.props.children
    if (this.props.fallback) return this.props.fallback
    return (
      <div className="empty empty--card" role="status">
        <p className="strong">this bit couldn’t load.</p>
        <p className="muted small">the rest of the page still works.</p>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => this.setState({ broken: false })}>try again</button>
      </div>
    )
  }
}
