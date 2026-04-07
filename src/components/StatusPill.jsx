export default function StatusPill({ status }) {
  const isOnline = status.available;
  return (
    <div className={`status-pill ${isOnline ? 'online' : 'offline'}`}>
      <span className="status-pill__dot" />
      <div>
        <strong>{isOnline ? 'Ollama connected' : 'Ollama unavailable'}</strong>
        <div>{isOnline ? status.baseUrl : status.error || status.baseUrl}</div>
      </div>
    </div>
  );
}
