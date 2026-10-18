import type { ComponentChildren } from 'preact';
import { store } from './store.ts';
import { Icon } from './icons.tsx';

export function Section({ id, index, title, meta, children, defaultOpen = true, accent }: { id: string; index: string; title: string; meta?: ComponentChildren; children: ComponentChildren; defaultOpen?: boolean; accent?: string }) {
  const collapsed = store.collapsed[id] ?? !defaultOpen;
  return (
    <section class={`sec ${collapsed ? 'collapsed' : ''}`} style={accent ? { '--sec-accent': accent } : undefined}>
      <header class="sec-head" onClick={() => store.toggleSection(id)}>
        <span class="sec-idx">{index}</span>
        <h2>{title}</h2>
        <span class="sec-meta">{meta}</span>
        <span class="sec-chev"><Icon name="chev" size={12} /></span>
      </header>
      {!collapsed && <div class="sec-body">{children}</div>}
    </section>
  );
}

export function Stat({ label, value, sub, color, title }: { label: string; value: ComponentChildren; sub?: ComponentChildren; color?: string; title?: string }) {
  return (
    <div class="stat" title={title}>
      <div class="stat-l">{label}</div>
      <div class="stat-v" style={color ? { color } : undefined}>{value}</div>
      {sub !== undefined && <div class="stat-s">{sub}</div>}
    </div>
  );
}

export function Pill({ children, tone = 'muted', title }: { children: ComponentChildren; tone?: string; title?: string }) {
  return <span class={`pill tone-${tone}`} title={title}>{children}</span>;
}

export function KV({ k, v, title }: { k: ComponentChildren; v: ComponentChildren; title?: string }) {
  return <div class="kv" title={title}><span class="k">{k}</span><span class="v">{v}</span></div>;
}

export function Tabs<T extends string>({ value, options, onChange, size = 'md' }: { value: T; options: { id: T; label: ComponentChildren; title?: string }[]; onChange: (v: T) => void; size?: 'sm' | 'md' }) {
  return (
    <div class={`tabs tabs-${size}`} role="tablist">
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={o.id === value} class={o.id === value ? 'on' : ''} title={o.title} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

export function statusTone(s: string): string {
  switch (s) {
    case 'Open': return 'good';
    case 'Locked': return 'warn';
    case 'Running': return 'live';
    case 'Provisional': return 'info';
    case 'Settled': return 'muted';
    case 'Voided': return 'bad';
    case 'active': return 'good';
    case 'reserve': return 'warn';
    case 'awaiting': return 'info';
    case 'retired': return 'muted';
    default: return 'muted';
  }
}

export function Empty({ children }: { children: ComponentChildren }) { return <div class="empty">{children}</div>; }
