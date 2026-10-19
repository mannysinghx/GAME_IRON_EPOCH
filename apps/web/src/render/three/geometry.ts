// Geometry builders: bevelled hex prisms and a small "part" merger that bakes primitives into one
// non-indexed geometry with flat normals, per-vertex albedo (color) and aPart = (tint, glow) so a whole
// model draws as a single instanced mesh. All of this runs at build time only.

import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CORNER_X, CORNER_Z, linRGB } from './common.ts';

export interface Part {
  geo: THREE.BufferGeometry;
  color: number; // sRGB hex albedo
  tint?: number; // 0..1, how much the per-instance faction colour multiplies the albedo
  glow?: number; // emission weight (x material uGlow)
  m?: THREE.Matrix4;
  smooth?: boolean; // keep the primitive's smooth normals instead of faceting
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Translation + Euler rotation (XYZ order) + scale. */
export function trs(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

const _rgb = new Float32Array(3);
export function buildParts(parts: Part[]): THREE.BufferGeometry {
  let total = 0;
  const prepared: { g: THREE.BufferGeometry; p: Part }[] = [];
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    if (p.m) g.applyMatrix4(p.m);
    if (!p.smooth || !g.getAttribute('normal')) g.computeVertexNormals();
    total += g.getAttribute('position').count;
    prepared.push({ g, p });
    p.geo.dispose();
  }
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3), prt = new Float32Array(total * 2);
  let o = 0;
  for (const { g, p } of prepared) {
    const pa = g.getAttribute('position'), na = g.getAttribute('normal');
    linRGB(p.color, _rgb);
    for (let i = 0; i < pa.count; i++, o++) {
      pos[o * 3] = pa.getX(i); pos[o * 3 + 1] = pa.getY(i); pos[o * 3 + 2] = pa.getZ(i);
      nor[o * 3] = na.getX(i); nor[o * 3 + 1] = na.getY(i); nor[o * 3 + 2] = na.getZ(i);
      col[o * 3] = _rgb[0]; col[o * 3 + 1] = _rgb[1]; col[o * 3 + 2] = _rgb[2];
      prt[o * 2] = p.tint ?? 0; prt[o * 2 + 1] = p.glow ?? 0;
    }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setAttribute('aPart', new THREE.BufferAttribute(prt, 2));
  // index identical corners (flat quads share two per face): same image, fewer vertex shader runs per instance
  const ix = mergeVertices(out);
  out.dispose();
  ix.computeBoundingSphere();
  ix.computeBoundingBox();
  return ix;
}

/** A thin square beam between two points (lattice masts, braces). */
export function beam(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, color: number, tint = 0, glow = 0): Part {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz) || 1e-3;
  const geo = new THREE.CylinderGeometry(r, r, len, 4);
  _q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / len, dy / len, dz / len));
  const m = new THREE.Matrix4().compose(_p.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), _q, _s.set(1, 1, 1));
  return { geo, color, tint, glow, m };
}

/**
 * Hex prism with its top face at y = 0, pointy-top (corner 0 toward -z), sides reaching down to -depth.
 * Optional bevel insets the top so lit edges read at a distance. Vertex colours darken bevel and walls
 * (cheap ambient occlusion); the per-instance colour supplies the tile albedo.
 */
export function hexPrismGeometry(bevel: number, depth: number, inset = 0.93): THREE.BufferGeometry {
  const P: number[] = [];
  const C: number[] = [];
  const rt = bevel > 0 ? inset : 1;
  const v = (x: number, y: number, z: number, c: number) => { P.push(x, y, z); C.push(c, c, c); };
  // top: 4-triangle fan from corner 0; (C0, C[k+1], C[k]) winds counter-clockwise seen from +y
  for (let k = 1; k < 5; k++) {
    v(CORNER_X[0] * rt, 0, CORNER_Z[0] * rt, 1); v(CORNER_X[k + 1] * rt, 0, CORNER_Z[k + 1] * rt, 1); v(CORNER_X[k] * rt, 0, CORNER_Z[k] * rt, 1);
  }
  const band = (r0: number, y0: number, c0: number, r1: number, y1: number, c1: number) => {
    for (let k = 0; k < 6; k++) {
      const k1 = (k + 1) % 6;
      const tx = CORNER_X[k] * r0, tz = CORNER_Z[k] * r0, t1x = CORNER_X[k1] * r0, t1z = CORNER_Z[k1] * r0;
      const bx = CORNER_X[k] * r1, bz = CORNER_Z[k] * r1, b1x = CORNER_X[k1] * r1, b1z = CORNER_Z[k1] * r1;
      // (T_k, B_k+1, B_k) and (T_k, T_k+1, B_k+1) face outward
      v(tx, y0, tz, c0); v(b1x, y1, b1z, c1); v(bx, y1, bz, c1);
      v(tx, y0, tz, c0); v(t1x, y0, t1z, c0); v(b1x, y1, b1z, c1);
    }
  };
  let y = 0;
  if (bevel > 0) { band(rt, 0, 0.86, 1, -bevel, 0.7); y = -bevel; }
  // one wall band; the gradient over its full depth leaves the visible upper part around 0.45..0.6
  band(1, y, 0.62, 1, -depth, 0.08);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.computeVertexNormals(); // non-indexed: flat face normals
  // index it: corners shared within a face (same position, normal and colour) are shaded once, which cuts
  // the vertex work of the tens of thousands of instanced prisms by about a third
  const ix = mergeVertices(g);
  g.dispose();
  ix.computeBoundingSphere();
  return ix;
}

/** Eight-point star outline in the XZ plane (citadel), extruded upward by `h`. */
export function starGeometry(rOut: number, rIn: number, h: number, points = 8): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  for (let k = 0; k < points * 2; k++) {
    const a = (Math.PI / points) * k + Math.PI / 2;
    const r = k % 2 ? rIn : rOut;
    if (k === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, steps: 1 });
  g.rotateX(-Math.PI / 2); // extrusion +z -> +y
  return g;
}

/** Two quads crossed at right angles: a cheap vertical "card" used for reeds and grass blades. */
export function bladeCluster(n: number, h: number, w: number, spread: number, color: number, seed: number): Part[] {
  const out: Part[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i * 2.399 + seed) % (Math.PI * 2));
    const r = spread * (0.3 + ((i * 0.618 + seed * 0.13) % 1) * 0.7);
    const hh = h * (0.7 + ((i * 0.37 + seed * 0.21) % 1) * 0.5);
    const geo = new THREE.ConeGeometry(w, hh, 3);
    out.push({ geo, color, m: trs(Math.cos(a) * r, hh / 2, Math.sin(a) * r, Math.sin(a) * 0.25, a, Math.cos(a) * 0.25) });
  }
  return out;
}
