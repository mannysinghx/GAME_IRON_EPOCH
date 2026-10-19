// Procedural low-poly models. Local frame: +x is forward (bridges span along +x), y up, origin on the
// ground (tile top). Albedo colours are sRGB hex; tint 1 parts take the per-instance faction colour and
// glow parts emit (bloom). Built once; every model is drawn through instancing.

import * as THREE from 'three';
import { beam, buildParts, starGeometry, trs, type Part } from './geometry.ts';

const PI = Math.PI;
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt: number, rb: number, h: number, seg = 6, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
const sph = (r: number, ws = 8, hs = 6) => new THREE.SphereGeometry(r, ws, hs);

// ------------------------------------------------------------------ decor
// decor is instanced by the tens of thousands (and trees also cast shadows), so it stays very low-poly:
// open-ended cones, no hidden caps
export function treeGeometry(): THREE.BufferGeometry {
  return buildParts([
    { geo: cyl(0.022, 0.032, 0.14, 4, true), color: 0x2a2118, m: trs(0, 0.07, 0) },
    { geo: new THREE.ConeGeometry(0.17, 0.3, 6, 1, true), color: 0x1f3d2c, m: trs(0, 0.25, 0) },
    { geo: new THREE.ConeGeometry(0.125, 0.25, 6, 1, true), color: 0x2a5039, m: trs(0, 0.42, 0, 0, 0.5, 0) },
    { geo: new THREE.ConeGeometry(0.07, 0.15, 5, 1, true), color: 0x31593f, m: trs(0, 0.56, 0) },
  ]);
}

export function rockGeometry(): THREE.BufferGeometry {
  return buildParts([
    { geo: new THREE.IcosahedronGeometry(0.16, 0), color: 0x4a4f58, m: trs(0, 0.05, 0, 0.3, 0.2, 0, 1, 0.62, 0.85) },
    { geo: new THREE.IcosahedronGeometry(0.09, 0), color: 0x5a606a, m: trs(0.13, 0.03, 0.06, 0.6, 1.1, 0.2, 1, 0.7, 0.9) },
  ]);
}

/** Unit block (base at y 0, 1 x 1 x 1) with a lighter broken top; scaled per instance. */
export function ruinGeometry(): THREE.BufferGeometry {
  return buildParts([
    { geo: box(1, 0.9, 1), color: 0x4a443e, m: trs(0, 0.45, 0) },
    { geo: box(0.92, 0.1, 0.8), color: 0x5d564e, m: trs(0.03, 0.95, -0.05) },
    { geo: box(0.3, 0.25, 0.35), color: 0x3e3934, m: trs(-0.35, 1.05, 0.2, 0.2, 0, 0.3) },
  ]);
}

export function reedGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [];
  for (let i = 0; i < 6; i++) {
    const a = i * 2.399, r = 0.03 + (i % 3) * 0.035, h = 0.16 + (i % 4) * 0.035;
    parts.push({ geo: new THREE.ConeGeometry(0.011, h, 3, 1, true), color: i % 2 ? 0x3f5b4f : 0x4b6a58, m: trs(Math.cos(a) * r, h / 2, Math.sin(a) * r, Math.sin(a) * 0.2, a, Math.cos(a) * 0.2) });
  }
  return buildParts(parts);
}

export function grassGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [];
  for (let i = 0; i < 4; i++) {
    const a = i * 2.1, r = 0.02 + (i % 2) * 0.03, h = 0.07 + (i % 3) * 0.025;
    parts.push({ geo: new THREE.ConeGeometry(0.01, h, 3, 1, true), color: i % 2 ? 0x56604f : 0x4c5848, m: trs(Math.cos(a) * r, h / 2, Math.sin(a) * r, Math.sin(a) * 0.35, a, Math.cos(a) * 0.35) });
  }
  return buildParts(parts);
}

export function puddleGeometry(): THREE.BufferGeometry {
  return buildParts([{ geo: cyl(0.3, 0.3, 0.012, 12), color: 0x173246, m: trs(0, 0.006, 0), smooth: true }]);
}

export function emberGeometry(): THREE.BufferGeometry { return new THREE.SphereGeometry(0.03, 6, 4); }

/** Flat unit quad spanning x 0..1, z -0.5..0.5 on the ground (road segments, scaled per instance). */
export function roadQuadGeometry(): THREE.BufferGeometry {
  const p = new THREE.PlaneGeometry(1, 1);
  p.rotateX(-PI / 2);
  p.translate(0.5, 0, 0);
  return buildParts([{ geo: p, color: 0xffffff, smooth: true }]);
}

export function roadJointGeometry(): THREE.BufferGeometry {
  return buildParts([{ geo: new THREE.CircleGeometry(0.5, 8).rotateX(-PI / 2), color: 0xffffff, smooth: true }]);
}

// ------------------------------------------------------------------ units
const DARK = 0x1b1f25, GUN = 0x2b3038, STEEL = 0x6b7380, LIGHT = 0xdfe8f5;

export function scoutGeometry(): THREE.BufferGeometry {
  const hull = new THREE.ConeGeometry(0.15, 0.52, 4);
  hull.rotateY(PI / 4);
  hull.rotateZ(-PI / 2);
  return buildParts([
    { geo: hull, color: 0xffffff, tint: 1, m: trs(0.02, 0.15, 0, 0, 0, 0, 1, 0.42, 1) },
    { geo: sph(0.055, 8, 6), color: LIGHT, tint: 0.2, glow: 0.25, m: trs(0.05, 0.19, 0, 0, 0, 0, 1.5, 0.65, 1) },
    { geo: box(0.3, 0.014, 0.022), color: 0xffffff, tint: 1, glow: 1, m: trs(-0.02, 0.165, 0.075, 0, 0.2, 0) },
    { geo: box(0.3, 0.014, 0.022), color: 0xffffff, tint: 1, glow: 1, m: trs(-0.02, 0.165, -0.075, 0, -0.2, 0) },
    { geo: sph(0.04, 6, 4), color: 0xffffff, tint: 0.6, glow: 2.2, m: trs(-0.24, 0.15, 0) },
    { geo: cyl(0.05, 0.06, 0.03, 8), color: DARK, m: trs(0.08, 0.05, 0.09) },
    { geo: cyl(0.05, 0.06, 0.03, 8), color: DARK, m: trs(0.08, 0.05, -0.09) },
    { geo: cyl(0.05, 0.06, 0.03, 8), color: DARK, m: trs(-0.14, 0.05, 0) },
  ]);
}

export function soldierGeometry(): THREE.BufferGeometry {
  return buildParts([
    { geo: new THREE.CapsuleGeometry(0.04, 0.1, 2, 6), color: 0xd0d4da, tint: 1, m: trs(0, 0.095, 0) },
    { geo: sph(0.036, 8, 6), color: 0xb8c0cc, tint: 0.35, m: trs(0.005, 0.215, 0) },
    { geo: box(0.012, 0.012, 0.05), color: 0xffffff, tint: 1, glow: 1.4, m: trs(0.034, 0.218, 0) },
    { geo: box(0.17, 0.018, 0.018), color: GUN, m: trs(0.06, 0.125, 0.04, 0, 0, 0.12) },
    { geo: box(0.05, 0.075, 0.07), color: 0x2b3038, tint: 0.2, m: trs(-0.045, 0.135, 0) },
  ]);
}

export function walkerBodyGeometry(): THREE.BufferGeometry {
  return buildParts([
    { geo: cyl(0.21, 0.25, 0.16, 6), color: 0xcfd6df, tint: 1, m: trs(0, 0.42, 0) },
    { geo: cyl(0.15, 0.2, 0.07, 6), color: 0x9aa3b0, tint: 0.55, m: trs(-0.02, 0.535, 0) },
    { geo: cyl(0.23, 0.16, 0.06, 6), color: 0x20242b, tint: 0.2, m: trs(0, 0.31, 0) },
    { geo: cyl(0.255, 0.255, 0.022, 6), color: 0xffffff, tint: 1, glow: 1.2, m: trs(0, 0.385, 0) },
    { geo: box(0.38, 0.06, 0.06), color: GUN, m: trs(0.31, 0.45, 0) },
    { geo: box(0.07, 0.085, 0.085), color: DARK, m: trs(0.5, 0.45, 0) },
    { geo: box(0.12, 0.05, 0.05), color: GUN, m: trs(0.16, 0.49, 0.1) },
    { geo: sph(0.034, 8, 6), color: 0xffffff, tint: 0.45, glow: 2.4, m: trs(0.2, 0.48, -0.06) },
    { geo: box(0.08, 0.1, 0.14), color: 0x3a3f48, tint: 0.3, m: trs(-0.2, 0.46, 0) },
  ]);
}

/** One leg, hip at the origin, foot on the ground 0.36 below. */
export function walkerLegGeometry(): THREE.BufferGeometry {
  return buildParts([
    { geo: cyl(0.03, 0.022, 0.2, 5), color: 0x3a3f48, tint: 0.25, m: trs(0, -0.09, 0.03, 0.3, 0, 0) },
    { geo: sph(0.035, 6, 4), color: 0xffffff, tint: 1, glow: 0.8, m: trs(0, -0.185, 0.06) },
    { geo: cyl(0.02, 0.03, 0.18, 5), color: GUN, m: trs(0, -0.27, 0.04, -0.2, 0, 0) },
    { geo: box(0.09, 0.025, 0.08), color: DARK, m: trs(0.01, -0.35, 0.02) },
  ]);
}

export function engineerGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geo: box(0.5, 0.06, 0.24), color: DARK, m: trs(0, 0.085, 0) },
    { geo: box(0.15, 0.15, 0.22), color: 0xffffff, tint: 1, m: trs(0.17, 0.19, 0) },
    { geo: box(0.02, 0.06, 0.18), color: 0x9fd8ff, glow: 0.7, m: trs(0.247, 0.215, 0) },
    { geo: box(0.3, 0.1, 0.24), color: STEEL, tint: 0.45, m: trs(-0.08, 0.165, 0) },
    { geo: box(0.1, 0.006, 0.03), color: 0xffffff, glow: 0.9, m: trs(-0.08, 0.218, 0) },
    { geo: box(0.03, 0.006, 0.1), color: 0xffffff, glow: 0.9, m: trs(-0.08, 0.218, 0) },
    { geo: box(0.3, 0.024, 0.024), color: 0x3a3f48, m: trs(-0.06, 0.3, 0.07, 0, 0, 0.5) },
    { geo: sph(0.02, 6, 4), color: 0xffb547, glow: 2, m: trs(0.17, 0.275, 0.06) },
  ];
  for (const x of [0.16, 0, -0.16]) for (const z of [0.125, -0.125]) parts.push({ geo: cyl(0.045, 0.045, 0.03, 8), color: 0x111317, m: trs(x, 0.045, z, PI / 2, 0, 0) });
  return buildParts(parts);
}

export function artilleryCarriageGeometry(): THREE.BufferGeometry {
  return buildParts([
    { geo: box(0.44, 0.08, 0.07), color: DARK, m: trs(0, 0.05, 0.12) },
    { geo: box(0.44, 0.08, 0.07), color: DARK, m: trs(0, 0.05, -0.12) },
    { geo: box(0.36, 0.1, 0.19), color: 0xffffff, tint: 1, m: trs(-0.02, 0.13, 0) },
    { geo: cyl(0.1, 0.115, 0.06, 8), color: STEEL, tint: 0.5, m: trs(0.02, 0.21, 0) },
    { geo: box(0.34, 0.012, 0.012), color: 0xffffff, tint: 1, glow: 1.2, m: trs(-0.02, 0.183, 0.096) },
    { geo: box(0.34, 0.012, 0.012), color: 0xffffff, tint: 1, glow: 1.2, m: trs(-0.02, 0.183, -0.096) },
    { geo: box(0.08, 0.05, 0.16), color: GUN, m: trs(-0.2, 0.1, 0) },
  ]);
}

/** Barrel pivoting at the trunnion (origin), pointing +x. */
export function artilleryBarrelGeometry(): THREE.BufferGeometry {
  const b = cyl(0.022, 0.03, 0.56, 8);
  b.rotateZ(-PI / 2);
  return buildParts([
    { geo: b, color: GUN, m: trs(0.27, 0, 0) },
    { geo: box(0.1, 0.075, 0.075), color: STEEL, tint: 0.4, m: trs(0, 0, 0) },
    { geo: cyl(0.032, 0.032, 0.05, 8).rotateZ(-PI / 2), color: DARK, m: trs(0.54, 0, 0) },
  ]);
}

// ------------------------------------------------------------------ structures
const CONCRETE = 0x4b5059, PLATE = 0x8b94a3;

export function coreBaseGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geo: cyl(0.78, 0.86, 0.22, 6), color: 0x5a6270, tint: 0.5, m: trs(0, 0.11, 0) },
    { geo: cyl(0.8, 0.8, 0.026, 6), color: 0xffffff, tint: 1, glow: 1.1, m: trs(0, 0.233, 0) },
    { geo: cyl(0.36, 0.48, 0.9, 6), color: PLATE, tint: 0.6, m: trs(0, 0.69, 0) },
    { geo: cyl(0.43, 0.43, 0.03, 6), color: 0xffffff, tint: 1, glow: 1.3, m: trs(0, 0.55, 0) },
    { geo: cyl(0.385, 0.385, 0.03, 6), color: 0xffffff, tint: 1, glow: 1.3, m: trs(0, 0.95, 0) },
    { geo: cyl(0.22, 0.36, 0.12, 6), color: STEEL, tint: 0.45, m: trs(0, 1.2, 0) },
  ];
  for (let i = 0; i < 3; i++) {
    const a = (PI * 2 * i) / 3 + PI / 6;
    parts.push({ geo: box(0.3, 0.52, 0.13), color: CONCRETE, tint: 0.35, m: trs(Math.cos(a) * 0.5, 0.46, -Math.sin(a) * 0.5, 0, a, 0) });
  }
  return buildParts(parts);
}

export function coreCrystalGeometry(): THREE.BufferGeometry {
  return buildParts([{ geo: new THREE.OctahedronGeometry(0.2, 0), color: 0xffffff, tint: 0.75, glow: 2.2, m: trs(0, 0, 0, 0, 0, 0, 1, 1.6, 1) }]);
}

/** Three flat arcs around the core. Laid flat first, then yawed: trs() composes XYZ Euler order, which would
 * yaw before tipping and tilt two of the arcs 60 degrees. */
export function coreRingGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [];
  for (let i = 0; i < 3; i++) {
    const g = new THREE.TorusGeometry(1.0, 0.032, 5, 18, 1.3);
    g.rotateX(PI / 2);
    g.rotateY((PI * 2 * i) / 3);
    parts.push({ geo: g, color: 0xffffff, tint: 1, glow: 2.2 });
  }
  return buildParts(parts);
}

export function depotGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [{ geo: box(0.92, 0.03, 0.82), color: 0x2a2620, m: trs(0, 0.015, 0) }];
  const crates: [number, number, number, number][] = [[-0.24, -0.06, 0.32, 0.2], [0.14, -0.2, 0.3, -0.15], [-0.02, 0.22, 0.34, 0.1]];
  for (const [x, z, s, r] of crates) {
    parts.push({ geo: box(s, s * 0.8, s * 0.92), color: 0x5b5346, m: trs(x, s * 0.4 + 0.03, z, 0, r, 0) });
    parts.push({ geo: box(s * 1.02, 0.035, s * 0.94), color: 0xffffff, tint: 1, glow: 0.4, m: trs(x, s * 0.8 + 0.045, z, 0, r, 0) });
  }
  parts.push({ geo: box(0.2, 0.16, 0.2), color: 0x6a604f, m: trs(-0.22, 0.38, -0.05, 0, 0.5, 0) });
  return buildParts(parts);
}

export function towerGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [];
  const top = 1.25;
  for (let i = 0; i < 3; i++) {
    const a = (PI * 2 * i) / 3, b = (PI * 2 * (i + 1)) / 3;
    parts.push(beam(Math.cos(a) * 0.3, 0, Math.sin(a) * 0.3, Math.cos(a) * 0.07, top, Math.sin(a) * 0.07, 0.022, PLATE, 0.15));
    for (const y of [0.42, 0.84]) {
      const ra = 0.3 - (0.23 * y) / top;
      parts.push(beam(Math.cos(a) * ra, y, Math.sin(a) * ra, Math.cos(b) * ra, y, Math.sin(b) * ra, 0.012, PLATE, 0.1));
    }
  }
  parts.push({ geo: cyl(0.21, 0.21, 0.05, 6), color: PLATE, tint: 0.3, m: trs(0, top + 0.02, 0) });
  parts.push({ geo: box(0.2, 0.12, 0.2), color: STEEL, tint: 0.6, m: trs(0, top + 0.1, 0) });
  parts.push({ geo: box(0.21, 0.025, 0.21), color: 0xffffff, tint: 1, glow: 1, m: trs(0, top + 0.13, 0) });
  return buildParts(parts);
}

export function lampGeometry(r = 0.08): THREE.BufferGeometry {
  return buildParts([{ geo: sph(r, 10, 8), color: 0xffffff, tint: 1, glow: 2.4, smooth: true }]);
}

export function bunkerGeometry(): THREE.BufferGeometry {
  return buildParts([
    { geo: cyl(0.5, 0.57, 0.08, 10), color: 0x3a3f48, m: trs(0, 0.04, 0) },
    { geo: new THREE.SphereGeometry(0.46, 14, 7, 0, PI * 2, 0, PI / 2), color: 0x5e646e, tint: 0.15, m: trs(0, 0.07, 0, 0, 0, 0, 1, 0.62, 1), smooth: true },
    { geo: box(0.1, 0.035, 0.42), color: 0xffffff, tint: 1, glow: 2.2, m: trs(0.365, 0.16, 0, 0, 0, -0.5) },
    { geo: cyl(0.08, 0.09, 0.04, 8), color: CONCRETE, m: trs(-0.05, 0.36, 0) },
    { geo: box(0.08, 0.03, 0.5), color: 0x2b3038, m: trs(0.36, 0.12, 0, 0, 0, -0.5) },
  ]);
}

/** Half width of the bridge deck: units cross on it (UnitLayer keeps them within BRIDGE_LANE of the axis). */
export const BRIDGE_HALF = 0.45;

export function bridgeGeometry(): THREE.BufferGeometry {
  const W = BRIDGE_HALF * 2, R = BRIDGE_HALF - 0.015;
  const parts: Part[] = [
    { geo: box(2.2, 0.07, W), color: 0x6a5a44, m: trs(0, 0, 0) },
    { geo: box(2.2, 0.06, 0.03), color: 0x3a3026, m: trs(0, 0.06, R) },
    { geo: box(2.2, 0.06, 0.03), color: 0x3a3026, m: trs(0, 0.06, -R) },
  ];
  for (let i = -5; i <= 5; i++) parts.push({ geo: box(0.02, 0.075, W - 0.02), color: 0x2e251a, m: trs(i * 0.19, 0.003, 0) });
  for (const x of [-0.5, 0.5]) for (const z of [-0.36, 0.36]) parts.push({ geo: cyl(0.05, 0.065, 0.75, 6), color: 0x2e251a, m: trs(x, -0.4, z) });
  for (const x of [-1.05, 1.05]) for (const z of [-R, R]) parts.push({ geo: sph(0.028, 6, 4), color: 0xffd9a0, glow: 1.6, m: trs(x, 0.12, z) });
  return buildParts(parts);
}

export function bridgeBrokenGeometry(): THREE.BufferGeometry {
  const W = BRIDGE_HALF * 2, R = BRIDGE_HALF - 0.015;
  const parts: Part[] = [];
  for (const s of [-1, 1]) {
    parts.push({ geo: box(0.62, 0.07, W), color: 0x5a4c3a, m: trs(s * 0.79, 0, 0, 0, 0, s * 0.06) });
    parts.push({ geo: box(0.62, 0.06, 0.03), color: 0x3a3026, m: trs(s * 0.79, 0.06, R, 0, 0, s * 0.06) });
    parts.push({ geo: cyl(0.05, 0.065, 0.75, 6), color: 0x2e251a, m: trs(s * 0.6, -0.4, 0.36) });
  }
  const debris: [number, number, number, number][] = [[-0.25, -0.5, 0.1, 0.6], [0.15, -0.55, -0.12, -0.4], [0.32, -0.48, 0.15, 1.1], [-0.05, -0.58, -0.02, 0.2]];
  for (const [x, y, z, r] of debris) parts.push({ geo: box(0.22, 0.05, 0.16), color: 0x3a3026, m: trs(x, y, z, r, r * 0.7, r * 0.4) });
  return buildParts(parts);
}

export function relayGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [{ geo: cyl(0.26, 0.31, 0.06, 6), color: 0x3a3f48, m: trs(0, 0.03, 0) }];
  for (let i = 0; i < 3; i++) {
    const a = (PI * 2 * i) / 3;
    parts.push(beam(Math.cos(a) * 0.27, 0.05, Math.sin(a) * 0.27, 0, 0.82, 0, 0.018, 0x9aa3b0));
  }
  parts.push(beam(0, 0, 0, 0, 0.98, 0, 0.022, 0x9aa3b0));
  parts.push({ geo: cyl(0.3, 0.05, 0.09, 14), color: PLATE, tint: 0.55, m: trs(0.04, 1.0, 0, 0, 0, -0.55) });
  parts.push({ geo: sph(0.05, 8, 6), color: 0xffffff, tint: 1, glow: 3, m: trs(0.12, 1.1, 0) });
  parts.push(beam(0.04, 1.0, 0, 0.12, 1.1, 0, 0.008, 0x9aa3b0));
  return buildParts(parts);
}

export function mineGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geo: cyl(0.52, 0.4, 0.05, 12), color: 0x14110e, m: trs(0, 0.0, 0) },
    { geo: new THREE.TorusGeometry(0.52, 0.045, 5, 16), color: 0x3d342a, m: trs(0, 0.03, 0, PI / 2, 0, 0) },
    beam(-0.26, 0, -0.12, 0, 0.86, 0, 0.024, 0x7d7468),
    beam(0.26, 0, -0.12, 0, 0.86, 0, 0.024, 0x7d7468),
    beam(0, 0, 0.3, 0, 0.86, 0, 0.024, 0x7d7468),
    { geo: new THREE.TorusGeometry(0.12, 0.018, 4, 12), color: 0x9aa3b0, m: trs(0, 0.87, 0) },
    { geo: sph(0.05, 8, 6), color: 0xffffff, tint: 1, glow: 2.6, m: trs(0, 1.0, 0) },
    { geo: box(0.17, 0.08, 0.1), color: 0x5b5346, m: trs(0.46, 0.06, 0.32, 0, 0.6, 0) },
  ];
  for (let i = 0; i < 5; i++) {
    const a = i * 1.3;
    parts.push({ geo: box(0.06, 0.04, 0.05), color: 0xc07a3a, glow: 1.3, m: trs(Math.cos(a) * 0.25, 0.02, Math.sin(a) * 0.22, 0, a, 0.3) });
  }
  return buildParts(parts);
}

export function refineryGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [{ geo: box(1.0, 0.05, 0.75), color: 0x2b3038, m: trs(0, 0.025, 0) }];
  for (const [x, z] of [[-0.26, 0], [0.24, -0.06]] as const) {
    parts.push({ geo: cyl(0.2, 0.2, 0.56, 12), color: 0x4d535d, tint: 0.1, m: trs(x, 0.33, z), smooth: true });
    parts.push({ geo: cyl(0.17, 0.17, 0.03, 12), color: 0x9ff4ff, tint: 0.55, glow: 1.3, m: trs(x, 0.625, z) });
    parts.push({ geo: cyl(0.205, 0.205, 0.03, 12), color: 0xffffff, tint: 1, glow: 0.8, m: trs(x, 0.2, z) });
  }
  parts.push(beam(-0.26, 0.45, 0, 0.24, 0.45, -0.06, 0.03, STEEL));
  parts.push({ geo: cyl(0.05, 0.065, 0.75, 8), color: 0x3a3f48, m: trs(0.3, 0.4, 0.27) });
  return buildParts(parts);
}

export function hubGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geo: box(1.15, 0.04, 0.85), color: 0x2b3038, m: trs(0, 0.02, 0) },
    { geo: box(0.95, 0.34, 0.62), color: 0x3e434c, tint: 0.15, m: trs(0, 0.21, 0) },
    { geo: box(0.96, 0.04, 0.63), color: 0xffffff, tint: 1, glow: 1.1, m: trs(0, 0.07, 0) },
    { geo: cyl(0.05, 0.06, 0.5, 8), color: 0x3a3f48, m: trs(0.38, 0.58, -0.22) },
    { geo: box(0.02, 0.18, 0.2), color: 0xffd9a0, glow: 0.9, m: trs(0.48, 0.13, 0.12) },
  ];
  for (const x of [-0.32, 0, 0.32]) {
    const roof = cyl(0.17, 0.17, 0.62, 3);
    roof.rotateX(-PI / 2);
    parts.push({ geo: roof, color: 0x555c67, tint: 0.2, m: trs(x, 0.42, 0, 0, 0, 0.35, 1, 0.75, 1) });
    parts.push({ geo: box(0.02, 0.09, 0.58), color: 0xffe2b0, glow: 1.3, tint: 0.2, m: trs(x + 0.075, 0.44, 0, 0, 0, 0.35) });
  }
  return buildParts(parts);
}

export function citadelGeometry(): THREE.BufferGeometry {
  const parts: Part[] = [
    { geo: starGeometry(1.25, 0.8, 0.3), color: STEEL, tint: 0.45 },
    { geo: starGeometry(1.27, 0.82, 0.025), color: 0xffffff, tint: 1, glow: 0.55, m: trs(0, 0.3, 0) },
    { geo: cyl(0.62, 0.62, 0.06, 6), color: 0x3a3f48, m: trs(0, 0.33, 0) },
    { geo: cyl(0.3, 0.38, 0.8, 6), color: PLATE, tint: 0.55, m: trs(0, 0.7, 0) },
    { geo: cyl(0.22, 0.3, 0.06, 6), color: 0xffffff, tint: 1, glow: 2.6, m: trs(0, 1.13, 0) },
    { geo: new THREE.ConeGeometry(0.1, 0.42, 6), color: 0x9aa3b0, tint: 0.5, m: trs(0, 1.37, 0) },
  ];
  for (let k = 0; k < 8; k++) {
    const a = (PI / 4) * k + PI / 2;
    parts.push({ geo: sph(0.045, 6, 4), color: 0xffffff, tint: 1, glow: 2, m: trs(Math.cos(a) * 1.18, 0.34, -Math.sin(a) * 1.18) });
  }
  return buildParts(parts);
}

export function objectiveGeometry(): THREE.BufferGeometry {
  return buildParts([
    { geo: new THREE.OctahedronGeometry(0.17, 0), color: 0xffd166, glow: 1.5, m: trs(0, 0, 0, 0, 0, 0, 1, 1.45, 1) },
    { geo: cyl(0.012, 0.012, 1.1, 4), color: 0xffd166, glow: 0.8, m: trs(0, -0.68, 0) },
  ]);
}
