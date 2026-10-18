// Small, dependency-free SVG charts tuned for dense side panels.

import type { ComponentChildren } from 'preact';

export function Spark({ values, color = '#7fe7ff', w = 96, h = 22, fill = true, min, max }: { values: number[]; color?: string; w?: number; h?: number; fill?: boolean; min?: number; max?: number }) {
  if (values.length < 2) return <svg class="spark" width={w} height={h} />;
  const lo = min ?? Math.min(...values), hi = max ?? Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - ((v - lo) / span) * (h - 4)] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const last = pts[pts.length - 1];
  return (
    <svg class="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      {fill && <path d={`${d}L${w},${h}L0,${h}Z`} fill={color} opacity="0.12" />}
      <path d={d} fill="none" stroke={color} stroke-width="1.3" stroke-linejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="1.8" fill={color} />
    </svg>
  );
}

export function StackArea({ series, colors, w = 300, h = 110, labels }: { series: number[][]; colors: string[]; w?: number; h?: number; labels?: string[] }) {
  const n = series[0]?.length ?? 0;
  if (n < 2) return <EmptyChart w={w} h={h} text="Collecting samples (every 30 s of simulation)…" />;
  const totals = new Array(n).fill(0).map((_, i) => series.reduce((a, s) => a + (s[i] ?? 0), 0) || 1);
  const acc = new Array(n).fill(0);
  const paths: ComponentChildren[] = [];
  series.forEach((s, k) => {
    const top: string[] = [], bot: string[] = [];
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y0 = h - (acc[i] / totals[i]) * h;
      acc[i] += s[i] ?? 0;
      const y1 = h - (acc[i] / totals[i]) * h;
      top.push(`${x.toFixed(1)},${y1.toFixed(1)}`);
      bot.unshift(`${x.toFixed(1)},${y0.toFixed(1)}`);
    }
    paths.push(<polygon key={k} points={[...top, ...bot].join(' ')} fill={colors[k]} opacity="0.55" stroke={colors[k]} stroke-width="0.8" />);
  });
  return (
    <svg class="chart" width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={labels?.join(', ')}>
      {[0.25, 0.5, 0.75].map((g) => <line key={g} x1="0" x2={w} y1={h * g} y2={h * g} class="gridline" />)}
      {paths}
    </svg>
  );
}

export function Lines({ series, colors, w = 300, h = 110, min, max, dashed }: { series: number[][]; colors: string[]; w?: number; h?: number; min?: number; max?: number; dashed?: boolean[] }) {
  const all = series.flat();
  const n = Math.max(0, ...series.map((s) => s.length));
  if (n < 2 || !all.length) return <EmptyChart w={w} h={h} text="Collecting samples…" />;
  const lo = min ?? Math.min(...all), hi = max ?? Math.max(...all);
  const span = hi - lo || 1;
  return (
    <svg class="chart" width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {[0.25, 0.5, 0.75].map((g) => <line key={g} x1="0" x2={w} y1={h * g} y2={h * g} class="gridline" />)}
      {series.map((s, k) => {
        if (s.length < 2) return null;
        const off = n - s.length;
        const d = s.map((v, i) => `${i ? 'L' : 'M'}${(((i + off) / (n - 1)) * w).toFixed(1)},${(h - 3 - ((v - lo) / span) * (h - 6)).toFixed(1)}`).join('');
        return <path key={k} d={d} fill="none" stroke={colors[k % colors.length]} stroke-width="1.5" stroke-dasharray={dashed?.[k] ? '3 3' : undefined} vector-effect="non-scaling-stroke" />;
      })}
    </svg>
  );
}

function EmptyChart({ w, h, text }: { w: number; h: number; text: string }) {
  return (
    <svg class="chart" width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <line x1="0" x2={w} y1={h / 2} y2={h / 2} class="gridline" />
      <text x={w / 2} y={h / 2 - 6} text-anchor="middle" class="chart-empty">{text}</text>
    </svg>
  );
}

export function Radar({ values, labels, color, size = 150, deltas }: { values: number[]; labels: string[]; color: string; size?: number; deltas?: Record<string, number> }) {
  const n = values.length, c = size / 2, r = size / 2 - 22;
  const pt = (i: number, v: number) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return [c + Math.cos(a) * r * v, c + Math.sin(a) * r * v] as const;
  };
  const poly = values.map((v, i) => pt(i, v / 100).join(',')).join(' ');
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} class="radar">
      {[0.25, 0.5, 0.75, 1].map((g) => <polygon key={g} points={values.map((_, i) => pt(i, g).join(',')).join(' ')} class="radar-ring" />)}
      {values.map((_, i) => { const [x, y] = pt(i, 1); return <line key={i} x1={c} y1={c} x2={x} y2={y} class="radar-axis" />; })}
      <polygon points={poly} fill={color} fill-opacity="0.22" stroke={color} stroke-width="1.6" />
      {values.map((v, i) => { const [x, y] = pt(i, v / 100); return <circle key={i} cx={x} cy={y} r="2.2" fill={color} />; })}
      {labels.map((l, i) => {
        const [x, y] = pt(i, 1.22);
        const d = deltas?.[l];
        return (
          <text key={l} x={x} y={y + 3} text-anchor="middle" class="radar-label">
            {l.slice(0, 3).toUpperCase()} {values[i]}{d ? <tspan class={d > 0 ? 'up' : 'down'}> {d > 0 ? '+' : ''}{d}</tspan> : null}
          </text>
        );
      })}
    </svg>
  );
}

export function WeightBars({ weights, names, max = 2 }: { weights: number[]; names: string[]; max?: number }) {
  return (
    <div class="wbars">
      {weights.map((w, i) => (
        <div class="wbar" key={names[i]}>
          <span class="wname">{names[i]}</span>
          <span class="wtrack">
            <span class="wzero" />
            <span class={`wfill ${w >= 0 ? 'pos' : 'neg'}`} style={{ left: w >= 0 ? '50%' : `${50 + (w / max) * 50}%`, width: `${(Math.abs(w) / max) * 50}%` }} />
          </span>
          <span class={`wval ${w >= 0 ? 'pos' : 'neg'}`}>{w >= 0 ? '+' : ''}{w.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

export function Bar({ value, max = 1, color = '#7fe7ff', h = 4 }: { value: number; max?: number; color?: string; h?: number }) {
  return <span class="bar" style={{ height: `${h}px` }}><span style={{ width: `${Math.max(0, Math.min(1, value / (max || 1))) * 100}%`, background: color }} /></span>;
}

export function Gauge({ value, budget, label }: { value: number; budget: number; label: string }) {
  const p = Math.min(1, value / budget);
  const col = p < 0.5 ? '#7ee2a8' : p < 0.75 ? '#ffd166' : '#ff5d5d';
  return (
    <div class="gauge">
      <div class="gauge-top"><span>{label}</span><b style={{ color: col }}>{value.toFixed(2)} ms</b></div>
      <Bar value={value} max={budget} color={col} h={5} />
    </div>
  );
}
