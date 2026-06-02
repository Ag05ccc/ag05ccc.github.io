class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(err) { return { error: err }; }
  render() {
    if (this.state.error) return <div style={{color:'red',fontFamily:'monospace',fontSize:14,padding:20,background:'#0a0e17',minHeight:'100vh'}}>
      <h2>React Error</h2><pre>{this.state.error.message}</pre><pre>{this.state.error.stack}</pre>
      <button onClick={()=>this.setState({error:null})} style={{marginTop:10,padding:'8px 16px',background:'#f59e0b',border:'none',borderRadius:4,cursor:'pointer'}}>Retry</button>
    </div>;
    return this.props.children;
  }
}
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<ErrorBoundary><App /></ErrorBoundary>);
