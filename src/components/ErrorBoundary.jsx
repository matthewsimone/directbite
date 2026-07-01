import { Component } from 'react'

// Minimal reusable error boundary. Catches render/lifecycle crashes in its
// subtree and shows a recoverable fallback instead of white-screening the app.
// Dependency-free; styled to match the rest of the tablet UI.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] caught render error', error, info)
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="fixed inset-0 flex items-center justify-center bg-white p-6 z-30">
        <div className="max-w-sm w-full bg-white border border-gray-200 rounded-2xl shadow-sm p-6 text-center space-y-4">
          <h2 className="text-lg font-bold text-gray-900">
            Something went wrong displaying this screen.
          </h2>
          <button
            onClick={() => window.location.reload()}
            className="w-full h-11 rounded-xl bg-[#16A34A] text-white font-semibold"
          >
            Reload
          </button>
          {this.props.onReset && (
            <button
              onClick={this.props.onReset}
              className="w-full h-10 rounded-xl text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"
            >
              Go back
            </button>
          )}
        </div>
      </div>
    )
  }
}
