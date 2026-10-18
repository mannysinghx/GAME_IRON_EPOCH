// Procedural art: colours and generated textures. All original geometry, no external assets.

import { Graphics, type Renderer, type Texture } from 'pixi.js';
import { FACTIONS, U } from '../shared/config.ts';

export const NEUTRAL = 0x8a93a2;

export function shade(c: number, f: number): number {
  const r = Math.min(255, Math.max(0, Math.round(((c >> 16) & 255) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((c >> 8) & 255) * f)));
  const b = Math.min(255, Math.max(0, Math.round((c & 255) * f)));
  return (r << 16) | (g << 8) | b;
}

export function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}

export function factionColor(f: number): number { return f >= 0 && f < 4 ? FACTIONS[f].color : NEUTRAL; }

export interface TextureBank {
  glow: Texture; dot: Texture; smoke: Texture; spark: Texture; shadow: Texture; cloud: Texture; ring: Texture;
  unit: Map<string, Texture>;
}

function gen(r: Renderer, g: Graphics, res = 3): Texture {
  const t = r.generateTexture({ target: g, resolution: res, antialias: true });
  g.destroy();
  return t;
}

function radial(r: Renderer, radius: number, stops: [number, number][], color = 0xffffff): Texture {
  // concentric discs approximate a soft radial gradient
  const g = new Graphics();
  const steps = 18;
  for (let i = steps; i >= 1; i--) {
    const t = i / steps;
    let a = 0;
    for (let k = 0; k < stops.length - 1; k++) {
      const [p0, a0] = stops[k], [p1, a1] = stops[k + 1];
      if (t >= p0 && t <= p1) { a = a0 + ((t - p0) / (p1 - p0)) * (a1 - a0); break; }
    }
    g.circle(0, 0, radius * t).fill({ color, alpha: Math.max(0.004, a / steps * 2.2) });
  }
  return gen(r, g, 2);
}

export function buildTextures(r: Renderer): TextureBank {
  const bank: TextureBank = {
    glow: radial(r, 32, [[0, 1], [0.35, 0.55], [1, 0]]),
    dot: radial(r, 8, [[0, 1], [0.5, 0.8], [1, 0]]),
    smoke: radial(r, 24, [[0, 0.9], [0.6, 0.45], [1, 0]]),
    spark: (() => { const g = new Graphics(); g.rect(-3, -0.6, 6, 1.2).fill(0xffffff); return gen(r, g, 3); })(),
    shadow: (() => { const g = new Graphics(); g.ellipse(0, 0, 9, 4).fill({ color: 0x000000, alpha: 0.42 }); g.ellipse(0, 0, 6, 2.6).fill({ color: 0x000000, alpha: 0.25 }); return gen(r, g, 2); })(),
    cloud: radial(r, 64, [[0, 0.8], [0.7, 0.35], [1, 0]]),
    ring: (() => { const g = new Graphics(); g.circle(0, 0, 30).stroke({ width: 2.5, color: 0xffffff, alpha: 1 }); return gen(r, g, 2); })(),
    unit: new Map(),
  };
  for (let f = -1; f < 4; f++) {
    const col = factionColor(f);
    for (let cls = 0; cls < 5; cls++) {
      if (cls === U.RIFLE) {
        for (let n = 1; n <= 5; n++) bank.unit.set(`${cls}:${f}:${n}`, gen(r, unitGraphic(cls, col, n), 4));
      } else bank.unit.set(`${cls}:${f}:0`, gen(r, unitGraphic(cls, col, 0), 4));
    }
  }
  return bank;
}

/** Geometric silhouettes facing +x. Faction colour body, dark outline, light top edge. */
function unitGraphic(cls: number, col: number, n: number): Graphics {
  const g = new Graphics();
  const dark = shade(col, 0.32), light = mix(col, 0xffffff, 0.45), mid = shade(col, 0.8);
  switch (cls) {
    case U.SCOUT: {
      g.poly([9, 0, -5, -5, -2, 0, -5, 5]).fill(col).stroke({ width: 1.2, color: dark, join: 'round' });
      g.poly([9, 0, -2, 0, -5, -5]).fill({ color: light, alpha: 0.55 });
      g.circle(2, 0, 1.4).fill(0xffffff);
      break;
    }
    case U.RIFLE: {
      const pts: [number, number][] = [[5, 0], [1, -3.6], [1, 3.6], [-3, -6.4], [-3, 6.4]];
      for (let i = 0; i < n; i++) {
        const [x, y] = pts[i];
        g.circle(x, y, 2.5).fill(dark);
        g.circle(x, y, 1.9).fill(col);
        g.circle(x - 0.5, y - 0.6, 0.8).fill({ color: light, alpha: 0.9 });
      }
      break;
    }
    case U.WALKER: {
      // legs
      for (const [a, b] of [[-5, -8], [3, -8], [-5, 8], [3, 8]]) g.moveTo(a * 0.6, b * 0.4).lineTo(a, b).stroke({ width: 2, color: dark, cap: 'round' });
      const hex: number[] = [];
      for (let k = 0; k < 6; k++) { const a = (Math.PI / 3) * k; hex.push(Math.cos(a) * 6.5, Math.sin(a) * 5.5); }
      g.poly(hex).fill(col).stroke({ width: 1.4, color: dark, join: 'round' });
      g.poly([0, -5.5, 5.6, -2.7, 0, 0, -5.6, -2.7]).fill({ color: light, alpha: 0.35 });
      g.rect(3, -1.2, 9, 2.4).fill(dark);
      g.rect(3, -0.6, 8.4, 1.2).fill(mid);
      g.circle(0, 0, 2).fill(0xffffff);
      break;
    }
    case U.ENGINEER: {
      g.roundRect(-7, -4.5, 12, 9, 1.6).fill(col).stroke({ width: 1.2, color: dark });
      g.roundRect(5, -3.5, 4.5, 7, 1.2).fill(mid).stroke({ width: 1, color: dark });
      g.rect(-4.5, -0.8, 6, 1.6).fill(0xffffff);
      g.rect(-2.3, -3, 1.6, 6).fill(0xffffff);
      break;
    }
    case U.ARTILLERY: {
      g.roundRect(-6, -4.5, 10, 9, 1.5).fill(col).stroke({ width: 1.2, color: dark });
      g.rect(1, -1.1, 13, 2.2).fill(dark);
      g.rect(1, -0.5, 12.4, 1).fill(light);
      g.circle(-1, 0, 2.6).fill(mid).stroke({ width: 1, color: dark });
      break;
    }
  }
  return g;
}
