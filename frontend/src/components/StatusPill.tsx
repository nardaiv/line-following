import type { ReactNode } from 'react';

type Tone = 'online' | 'offline' | 'warning' | 'neutral' | 'accent';

export default function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`status-pill status-pill--${tone}`}>
    <span className="status-pill__dot" aria-hidden="true" />
    {children}
  </span>;
}
