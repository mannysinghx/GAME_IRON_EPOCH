// Original glyphs: faction marks, unit silhouettes, resources and UI icons.

import { fcss } from './format.ts';

export function FactionGlyph({ f, size = 14 }: { f: number; size?: number }) {
  const c = fcss(f);
  const s = size;
  switch (f) {
    case 0: return <svg width={s} height={s} viewBox="0 0 16 16" class="glyph"><path d="M8 1 14 4v4c0 3.5-2.6 6-6 7-3.4-1-6-3.5-6-7V4z" fill="none" stroke={c} stroke-width="1.6" /><path d="M8 4.5 11 6v2.2c0 1.8-1.3 3.1-3 3.7-1.7-.6-3-1.9-3-3.7V6z" fill={c} /></svg>;
    case 1: return <svg width={s} height={s} viewBox="0 0 16 16" class="glyph"><path d="M2 3h4l5 5-5 5H2l5-5z" fill={c} /><path d="M8 3h3l5 5-5 5H8l5-5z" fill={c} opacity=".55" /></svg>;
    case 2: return <svg width={s} height={s} viewBox="0 0 16 16" class="glyph"><path d="M3 4h10v3l-2 1v5H5V8L3 7z" fill={c} /><rect x="6" y="1.5" width="4" height="2.5" fill={c} opacity=".6" /></svg>;
    case 3: return <svg width={s} height={s} viewBox="0 0 16 16" class="glyph"><path d="M1 8c2.4-3.6 4.6-5 7-5s4.6 1.4 7 5c-2.4 3.6-4.6 5-7 5s-4.6-1.4-7-5z" fill="none" stroke={c} stroke-width="1.5" /><circle cx="8" cy="8" r="2.4" fill={c} /></svg>;
    default: return <svg width={s} height={s} viewBox="0 0 16 16" class="glyph"><circle cx="8" cy="8" r="5" fill="none" stroke={c} stroke-width="1.5" /></svg>;
  }
}

export function UnitIcon({ cls, color = 'currentColor', size = 14 }: { cls: number; color?: string; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 16 16', class: 'uicon' };
  switch (cls) {
    case 0: return <svg {...p}><path d="M14 8 3 3.5 5.5 8 3 12.5z" fill={color} /></svg>;
    case 1: return <svg {...p}>{[[11, 8], [7.5, 5], [7.5, 11], [4, 3], [4, 13]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="1.7" fill={color} />)}</svg>;
    case 2: return <svg {...p}><path d="M8 3.5 12 5.7v4.6L8 12.5 4 10.3V5.7z" fill={color} /><rect x="11" y="7.2" width="4.5" height="1.6" fill={color} /><path d="M5 11.5 3 14M11 11.5l2 2.5M5 4.5 3 2M11 4.5 13 2" stroke={color} stroke-width="1.2" /></svg>;
    case 3: return <svg {...p}><rect x="2" y="5" width="9" height="6.5" rx="1" fill={color} /><rect x="11.3" y="6" width="3.2" height="5.5" rx=".8" fill={color} opacity=".7" /><path d="M4.5 8.2h4M6.5 6.2v4" stroke="#0b0f14" stroke-width="1.3" /></svg>;
    case 4: return <svg {...p}><rect x="2" y="6" width="7" height="6" rx="1" fill={color} /><rect x="7" y="7.6" width="8" height="1.8" fill={color} /><circle cx="5" cy="9" r="1.6" fill="#0b0f14" /></svg>;
  }
  return null;
}

export function ResIcon({ k, size = 12 }: { k: 'alloy' | 'energy' | 'supply'; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 16 16', class: 'ricon' };
  if (k === 'alloy') return <svg {...p}><path d="M2 11 6 4h4l4 7-2 2H4z" fill="#c9a27a" /><path d="M6 4h4l1.5 2.5h-7z" fill="#e3c6a4" /></svg>;
  if (k === 'energy') return <svg {...p}><path d="M9.5 1 3 9h4l-1 6 6.5-8h-4z" fill="#7fe7ff" /></svg>;
  return <svg {...p}><rect x="2" y="5" width="12" height="8" rx="1" fill="#8fd3a0" /><path d="M2 8h12M8 5v8" stroke="#0b0f14" stroke-width="1.1" /><path d="M5 5 8 2l3 3" fill="none" stroke="#8fd3a0" stroke-width="1.4" /></svg>;
}

export function Icon({ name, size = 14 }: { name: string; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' as const, 'stroke-linejoin': 'round' as const, class: 'icon' };
  switch (name) {
    case 'pause': return <svg {...p}><path d="M5 3v10M11 3v10" /></svg>;
    case 'play': return <svg {...p}><path d="M5 3l8 5-8 5z" fill="currentColor" /></svg>;
    case 'chev': return <svg {...p}><path d="M5 6l3 3 3-3" /></svg>;
    case 'eye': return <svg {...p}><path d="M1.5 8C3.5 4.5 5.7 3 8 3s4.5 1.5 6.5 5C12.5 11.5 10.3 13 8 13S3.5 11.5 1.5 8z" /><circle cx="8" cy="8" r="2" /></svg>;
    case 'target': return <svg {...p}><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="2" /><path d="M8 0.5v3M8 12.5v3M0.5 8h3M12.5 8h3" /></svg>;
    case 'follow': return <svg {...p}><path d="M8 14s5-4.2 5-8A5 5 0 0 0 3 6c0 3.8 5 8 5 8z" /><circle cx="8" cy="6" r="1.8" /></svg>;
    case 'film': return <svg {...p}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M2 6h12M2 10h12M5 3v3M11 3v3M5 10v3M11 10v3" /></svg>;
    case 'hand': return <svg {...p}><path d="M5 8V3.5a1 1 0 0 1 2 0V7M7 7V2.5a1 1 0 0 1 2 0V7M9 7V3.5a1 1 0 0 1 2 0V9M11 6.5a1 1 0 0 1 2 0V10c0 2.5-2 4.5-4.5 4.5S4 13 3 11l-1-2a1 1 0 0 1 1.7-1L5 9.5" /></svg>;
    case 'layers': return <svg {...p}><path d="M8 2 14.5 5.5 8 9 1.5 5.5z" /><path d="M1.5 8.5 8 12l6.5-3.5" /><path d="M1.5 11 8 14.5 14.5 11" opacity=".6" /></svg>;
    case 'plus': return <svg {...p}><path d="M8 3v10M3 8h10" /></svg>;
    case 'minus': return <svg {...p}><path d="M3 8h10" /></svg>;
    case 'fit': return <svg {...p}><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" /></svg>;
    case 'help': return <svg {...p}><circle cx="8" cy="8" r="6.5" /><path d="M6.2 6.2a1.9 1.9 0 0 1 3.6.8c0 1.3-1.8 1.6-1.8 2.8M8 11.6v.2" /></svg>;
    case 'save': return <svg {...p}><path d="M3 2.5h8l2.5 2.5v8.5h-11z" /><path d="M5 2.5v3.5h5V2.5M5 13.5V9.5h6v4" /></svg>;
    case 'search': return <svg {...p}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>;
    case 'shield': return <svg {...p}><path d="M8 1.5 13.5 4v4c0 3.2-2.4 5.5-5.5 6.5C4.9 13.5 2.5 11.2 2.5 8V4z" /></svg>;
    case 'check': return <svg {...p}><path d="M3 8.5 6.5 12 13 4.5" /></svg>;
    case 'bolt': return <svg {...p}><path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" /></svg>;
    case 'close': return <svg {...p}><path d="M4 4l8 8M12 4l-8 8" /></svg>;
    case 'dna': return <svg {...p}><path d="M4 1.5c0 4 8 4 8 6.5S4 10.5 4 14.5M12 1.5c0 4-8 4-8 6.5s8 2.5 8 6.5M5 4h6M5 12h6" /></svg>;
    case 'brain': return <svg {...p}><path d="M6 2.5a2 2 0 0 0-2 2 2 2 0 0 0-1.5 3.3A2.2 2.2 0 0 0 4 11.5a2 2 0 0 0 2 2V2.5zM10 2.5a2 2 0 0 1 2 2 2 2 0 0 1 1.5 3.3 2.2 2.2 0 0 1-1.5 3.7 2 2 0 0 1-2 2V2.5zM6 7h4" /></svg>;
  }
  return null;
}

export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" class="logo">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7fe7ff" /><stop offset="1" stop-color="#5aa9ff" /></linearGradient>
      </defs>
      <path d="M16 2 28.1 9v14L16 30 3.9 23V9z" fill="none" stroke="url(#lg)" stroke-width="1.8" />
      <path d="M16 8.5 22.5 12.2v7.6L16 23.5l-6.5-3.7v-7.6z" fill="url(#lg)" opacity=".18" />
      <path d="M11 11.5h10M11 16h10M11 20.5h10" stroke="#e6ebf2" stroke-width="1.6" stroke-linecap="square" />
      <path d="M11 11.5v9" stroke="#e6ebf2" stroke-width="1.6" />
    </svg>
  );
}
