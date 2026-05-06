import Link from "next/link";

export default function Home() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-12 space-y-12">
      <section className="text-center space-y-3">
        <h2 className="text-2xl" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
          Byron Co-op Production Planning
        </h2>
        <p className="text-base max-w-2xl mx-auto" style={{ color: 'var(--text-secondary)' }}>
          Integrated planning system for kitchen batch scheduling and purchasing
          optimization. Real-time SOH projections and Unleashed API integration.
        </p>
      </section>

      <div className="grid md:grid-cols-2 gap-6">
        {[
          {
            href: '/kitchen',
            title: 'Kitchen Calendar',
            desc: 'Drag-and-drop batch scheduling with feasibility analysis. Plan production runs based on component availability and working day constraints.',
            items: ['Batch scheduling with drag-and-drop', 'Two-level intermediate dependency tracking', 'No-same-day-chaining constraint enforcement', 'Real-time SOH integration'],
          },
          {
            href: '/purchasing',
            title: 'Component Planner',
            desc: 'Dense SOH projection table with short-term adequacy bars and long-term monthly demand vs supply pipeline. Draft purchase orders from projected shortages.',
            items: ['All-component SOH overview table', 'SOH adequacy bar vs planned consumption', 'Monthly demand vs SOH + POs projection', 'Draft purchase order generation'],
          },
        ].map((card) => (
          <Link key={card.href} href={card.href}>
            <div
              className="block p-6 rounded transition-all cursor-pointer hover:opacity-80"
              style={{ border: '0.5px solid var(--border)', background: 'var(--bg-page)' }}
            >
              <h3 className="text-lg mb-2" style={{ fontWeight: 500, color: 'var(--accent)' }}>
                {card.title}
              </h3>
              <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
                {card.desc}
              </p>
              <ul className="space-y-1.5 text-sm" style={{ color: 'var(--text-muted)' }}>
                {card.items.map((item) => (
                  <li key={item}>· {item}</li>
                ))}
              </ul>
            </div>
          </Link>
        ))}
      </div>

      <section className="rounded p-6" style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}>
        <h3 className="text-base mb-4" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
          System Architecture
        </h3>
        <div className="grid md:grid-cols-3 gap-6 text-sm">
          {[
            { title: 'Data Integration', desc: 'Server-side HMAC-SHA256 authenticated Unleashed API proxy. All credentials stored securely on server.' },
            { title: 'Projection Engine', desc: 'Pure functional projection engines for kitchen and purchasing. Business calendar with Australian public holidays.' },
            { title: 'Planning Runs', desc: 'Planning run infrastructure with UUID tracking, external references, and status management.' },
          ].map((item) => (
            <div key={item.title}>
              <h4 className="mb-1.5" style={{ fontWeight: 500, color: 'var(--accent)' }}>{item.title}</h4>
              <p style={{ color: 'var(--text-muted)' }}>{item.desc}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
