import React from 'react';

function formatError(error) {
  if (!error) {
    return 'Unknown renderer error.';
  }

  return error.stack || error.message || String(error);
}

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      error: null,
    };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error('Renderer crashed:', error);
  }

  render() {
    if (this.state.error) {
      return (
        <section className="fatal-screen">
          <div className="fatal-screen__panel">
            <p>Startup Error</p>
            <h1>Sidekick failed to render.</h1>
            <pre>{formatError(this.state.error)}</pre>
          </div>
        </section>
      );
    }

    return this.props.children;
  }
}
