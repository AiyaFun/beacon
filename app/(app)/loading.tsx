export default function Loading() {
  return (
    <div className="stack" style={{ gap: 16, padding: '8px 0' }}>
      <div className="skeleton" style={{ height: 28, width: '40%', borderRadius: 6 }} />
      <div className="skeleton" style={{ height: 14, width: '60%', borderRadius: 4 }} />
      <div className="grid grid-4" style={{ marginTop: 8 }}>
        {[1, 2, 3, 4].map(k => (
          <div key={k} className="skeleton" style={{ height: 80, borderRadius: 8 }} />
        ))}
      </div>
      <div className="grid grid-2" style={{ marginTop: 8 }}>
        <div className="skeleton" style={{ height: 200, borderRadius: 8 }} />
        <div className="skeleton" style={{ height: 200, borderRadius: 8 }} />
      </div>
    </div>
  );
}
