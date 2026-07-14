import { Component, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'

interface Props {
  children: ReactNode
  label?: string
}
interface State {
  error: Error | null
}

// Contains render/mount crashes so one bad panel can't blank the whole window.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('[riven] panel crashed:', error)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="crash">
          <div>
            <p>
              <TriangleAlert size={14} /> 이 영역에서 오류가 발생했어요
              {this.props.label ? ` (${this.props.label})` : ''}.
            </p>
            <pre>{this.state.error.message}</pre>
            <button className="btn-small" onClick={() => this.setState({ error: null })}>
              다시 시도
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
