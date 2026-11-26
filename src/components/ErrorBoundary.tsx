import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    message: '',
  };

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error.message || 'An unexpected error occurred.',
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('CozyPrep ErrorBoundary:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#FBF9F5] text-[#1F2421] flex items-center justify-center p-6">
          <div className="bg-white border border-[#E6E1D6] rounded-2xl max-w-md w-full p-6 space-y-4">
            <h1 className="font-display text-xl font-semibold text-[#1F2421]">
              Something went wrong
            </h1>
            <p className="text-sm text-[#5F6660] break-words">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-xl bg-[#2F6F5E] text-white text-sm font-semibold hover:bg-[#25594B] cursor-pointer"
            >
              Reload CozyPrep
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
