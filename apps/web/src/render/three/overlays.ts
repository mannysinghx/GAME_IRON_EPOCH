// Map overlays: territory front lines (contested faction-faction edges glow, faction-neutral edges are thin,
// faint dashed commander boundaries), supply dots, the amber frontier boundary between open and locked
// land, the sealed operation region (ground ribbon plus a translucent cylindrical force wall), the selected
// commander's plan (animated arc, target and candidate rings, danger discs) and fog-view ghosts.

import * as THREE from 'three';
import type { IntentOverlay, PlanOverlay } from '../api.ts';
import { CORNER_X, CORNER_Z, DIR_EDGE, FACTION_LIN, FACTION_SRGB, GROUND_Y, INTENT_FRESH_MS, fIdx, linRGB, mixHex, factionHex, RGB, type Theatre } from './common.ts';
import { DISC, HEX_LINE, P_GLOW, PointCloud, RING, RibbonBatch, SH_DIAMOND_LINE, pointsMaterial, type RingBatch, type SpriteBatch } from './batches.ts';
import { TIME, fogUniforms, FOG_FACTOR_GLSL } from './materials.ts';
import type { UnitLayer } from './units.ts';

const AMBER_HEX = 0xffb04a;

function edgeCorners(th: Theatre, t: number, d: number, radius: number, out: Float32Array): void {
  const e = DIR_EDGE[d], e2 = (e + 1) % 6;
  out[0] = th.x[t] + CORNER_X[e] * radius; out[1] = th.z[t] + CORNER_Z[e] * radius;
  out[2] = th.x[t] + CORNER_X[e2] * radius; out[3] = th.z[t] + CORNER_Z[e2] * radius;
}

const _e = new Float32Array(4);
function inTh(th: Theatre, t: number): boolean { return t >= 0 && t < th.n; }

export class OverlayLayer {
  readonly group = new THREE.Group();
  private fronts = new RibbonBatch(4096, { ground: true, additive: true, renderOrder: 3 });
  private frontier = new RibbonBatch(1024, { ground: true, additive: true, renderOrder: 3 });
  private opLine = new RibbonBatch(512, { ground: true, additive: true, renderOrder: 3 });
  private plan = new RibbonBatch(160, { ground: false, additive: true, renderOrder: 7 });
  private supplyScale = { value: 600 };
  private supply: PointCloud;
  private wall: THREE.Mesh;
  private wallU: { uColor: { value: THREE.Color }; uAlpha: { value: number } };
  private opCenter = new Float32Array(3);
  opActive = false;
  private th: Theatre | null = null;

  constructor(pointScale: { value: number }) {
    this.supplyScale = pointScale;
    this.supply = new PointCloud(pointsMaterial(true, this.supplyScale), 4);
    this.wallU = { uColor: { value: new THREE.Color(1, 1, 1) }, uAlpha: { value: 0 } };
    const wallGeo = new THREE.CylinderGeometry(1, 1, 1, 96, 1, true);
    wallGeo.translate(0, 0.5, 0);
    const wallMat = new THREE.ShaderMaterial({
      uniforms: { ...fogUniforms(), uTime: TIME, uColor: this.wallU.uColor, uAlpha: this.wallU.uAlpha },
      fog: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying float vEdge;
        #include <fog_pars_vertex>
        void main() {
          vUv = uv;
          vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
          vec3 n = normalize( normalMatrix * normal );
          vEdge = 1.0 - abs( dot( n, normalize( -mvPosition.xyz ) ) );
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uColor; uniform float uAlpha;
        varying vec2 vUv; varying float vEdge;
        #include <fog_pars_fragment>
        void main() {
          float fall = pow( clamp( 1.0 - vUv.y, 0.0, 1.0 ), 1.7 ); // clamp: pow of a negative is NaN, which bloom smears
          float scan = smoothstep( 0.86, 1.0, fract( vUv.y * 7.0 - uTime * 0.35 ) ) * 0.45;
          float streak = 0.5 + 0.5 * sin( vUv.x * 380.0 + uTime * 0.6 );
          float a = max( 0.0, uAlpha * ( fall * ( 0.35 + 0.65 * vEdge * vEdge ) + scan * fall + streak * 0.08 * fall ) );
          ${FOG_FACTOR_GLSL}
          gl_FragColor = vec4( uColor, a * ( 1.0 - fogF ) );
        }`,
    });
    this.wall = new THREE.Mesh(wallGeo, wallMat);
    this.wall.visible = false;
    this.wall.renderOrder = 6;
    this.wall.frustumCulled = false;
    this.group.add(this.fronts.mesh, this.frontier.mesh, this.opLine.mesh, this.plan.mesh, this.supply.points, this.wall);
  }

  setTheatre(th: Theatre): void {
    this.th = th;
    this.fronts.begin(); this.fronts.end();
    this.frontier.begin(); this.frontier.end();
    this.opLine.begin(); this.opLine.end();
    this.supply.begin(); this.supply.end();
    this.wall.visible = false;
    this.opActive = false;
  }

  // ------------------------------------------------------------------ territory fronts
  rebuildFronts(territory: Int8Array, owner: Int16Array, on: boolean): void {
    const th = this.th, B = this.fronts;
    B.begin();
    if (!th || !on || territory.length !== th.n) { B.end(); return; }
    const nb = th.grid.nb;
    for (let t = 0; t < th.n; t++) {
      const f = territory[t];
      if (f < 0) continue;
      const fo = fIdx(f);
      const fr = FACTION_LIN[fo], fg = FACTION_LIN[fo + 1], fb = FACTION_LIN[fo + 2];
      const y = th.top[t] + 0.03;
      for (let d = 0; d < 6; d++) {
        const v = nb[t * 6 + d];
        const of = v >= 0 ? territory[v] : -1;
        if (of === f) {
          // commander boundary inside a faction: faint dashed hairline on the shared edge
          if (v > t && owner.length === th.n && owner[v] >= 0 && owner[v] !== owner[t]) {
            edgeCorners(th, t, d, 1, _e);
            const yy = Math.max(th.top[t], th.top[v]) + 0.03;
            B.seg(_e[0], yy, _e[1], _e[2], yy, _e[3], 0.04, fr * 0.7 + 0.15, fg * 0.7 + 0.15, fb * 0.7 + 0.15, 0.2, 0.2, 0, 1, 0.22, 0, 0, true);
          }
          continue;
        }
        edgeCorners(th, t, d, 0.88, _e);
        if (of >= 0) {
          B.seg(_e[0], y, _e[1], _e[2], y, _e[3], 0.44, fr * 1.1, fg * 1.1, fb * 1.1, 0.22, 0.22, 0, 0, 0, 0, 0, true);
          linRGB(mixHex(factionHex(f), 0xffffff, 0.35), RGB, 0, 2.6);
          B.seg(_e[0], y + 0.005, _e[1], _e[2], y + 0.005, _e[3], 0.12, RGB[0], RGB[1], RGB[2], 0.95, 0.95, 0, 1, 0, 0, 0.22, true);
        } else {
          B.seg(_e[0], y, _e[1], _e[2], y, _e[3], 0.075, fr * 1.3, fg * 1.3, fb * 1.3, 0.62, 0.62, 0, 0, 0, 0, 0, true);
        }
      }
    }
    B.end();
  }

  rebuildSupply(supply: Uint8Array, on: boolean): void {
    const th = this.th, P = this.supply;
    P.begin();
    if (th && on && supply.length === th.n) {
      for (let t = 0; t < th.n; t++) {
        const m = supply[t];
        if (!m) continue;
        for (let f = 0; f < 4; f++) {
          if (!(m & (1 << f))) continue;
          const fo = fIdx(f);
          P.push(th.x[t] + (f - 1.5) * 0.14, th.walk[t] + 0.07, th.z[t], 0.16, P_GLOW, FACTION_LIN[fo] * 2, FACTION_LIN[fo + 1] * 2, FACTION_LIN[fo + 2] * 2, 0.75);
        }
      }
    }
    P.end();
  }

  // ------------------------------------------------------------------ frontier boundary
  rebuildFrontier(active: Uint8Array): void {
    const th = this.th, B = this.frontier;
    B.begin();
    if (!th || active.length !== th.n) { B.end(); return; }
    let cx = 0, cz = 0, cn = 0;
    for (let t = 0; t < th.n; t++) if (active[t]) { cx += th.x[t]; cz += th.z[t]; cn++; }
    if (!cn || cn === th.n) { B.end(); return; }
    cx /= cn; cz /= cn;
    let rsum = 0, rn = 0;
    const nb = th.grid.nb;
    for (let t = 0; t < th.n; t++) {
      if (!active[t]) continue;
      for (let d = 0; d < 6; d++) {
        const v = nb[t * 6 + d];
        if (v < 0 || active[v]) continue;
        rsum += Math.hypot(th.x[t] - cx, th.z[t] - cz); rn++;
      }
    }
    const R = rn ? rsum / rn : 1;
    linRGB(AMBER_HEX, RGB, 0, 1);
    const ar = RGB[0], ag = RGB[1], ab = RGB[2];
    for (let t = 0; t < th.n; t++) {
      if (!active[t]) continue;
      for (let d = 0; d < 6; d++) {
        const v = nb[t * 6 + d];
        if (v < 0 || active[v]) continue;
        edgeCorners(th, t, d, 1, _e);
        const y = Math.max(th.top[t], th.top[v]) + 0.035;
        const u0 = Math.atan2(_e[1] - cz, _e[0] - cx) * R, u1 = u0 + Math.hypot(_e[2] - _e[0], _e[3] - _e[1]) * Math.sign(((_e[0] - cx) * (_e[3] - cz) - (_e[1] - cz) * (_e[2] - cx)) || 1);
        B.seg(_e[0], y, _e[1], _e[2], y, _e[3], 0.34, ar, ag, ab, 0.15, 0.15, u0, u1, 0, 0, 0.3, true);
        B.seg(_e[0], y + 0.004, _e[1], _e[2], y + 0.004, _e[3], 0.08, ar * 2.0, ag * 2.0, ab * 2.0, 0.9, 0.9, u0, u1, 0.55, 0.45, 0, true);
      }
    }
    B.end();
  }

  // ------------------------------------------------------------------ operation region
  setOpRegion(region: Int32Array | null): void {
    const th = this.th, B = this.opLine;
    B.begin();
    this.opActive = false;
    this.wall.visible = false;
    if (!th || !region || !region.length) { B.end(); return; }
    const inR = new Uint8Array(th.n);
    let cx = 0, cz = 0, cy = 0, cn = 0;
    for (let i = 0; i < region.length; i++) {
      const t = region[i];
      if (t < 0 || t >= th.n) continue;
      inR[t] = 1; cx += th.x[t]; cz += th.z[t]; cy += th.top[t]; cn++;
    }
    if (!cn) { B.end(); return; }
    cx /= cn; cz /= cn; cy /= cn;
    let maxR = 0;
    for (let i = 0; i < region.length; i++) {
      const t = region[i];
      if (t >= 0 && t < th.n) maxR = Math.max(maxR, Math.hypot(th.x[t] - cx, th.z[t] - cz));
    }
    const nb = th.grid.nb;
    const R = maxR + 0.9;
    for (let i = 0; i < region.length; i++) {
      const t = region[i];
      if (t < 0 || t >= th.n) continue;
      for (let d = 0; d < 6; d++) {
        const v = nb[t * 6 + d];
        if (v >= 0 && inR[v]) continue;
        edgeCorners(th, t, d, 1, _e);
        const y = (v >= 0 ? Math.max(th.top[t], th.top[v]) : th.top[t]) + 0.045;
        const u0 = Math.atan2(_e[1] - cz, _e[0] - cx) * R;
        const u1 = u0 + Math.hypot(_e[2] - _e[0], _e[3] - _e[1]) * Math.sign(((_e[0] - cx) * (_e[3] - cz) - (_e[1] - cz) * (_e[2] - cx)) || 1);
        B.seg(_e[0], y, _e[1], _e[2], y, _e[3], 0.5, 0.5, 0.5, 0.5, 0.18, 0.18, u0, u1, 0, 0, 0.25, true);
        B.seg(_e[0], y + 0.004, _e[1], _e[2], y + 0.004, _e[3], 0.1, 2, 2, 2, 0.9, 0.9, u0, u1, 0.9, 0.5, 0, true);
      }
    }
    B.end();
    this.opCenter[0] = cx; this.opCenter[1] = cy; this.opCenter[2] = cz;
    this.wall.position.set(cx, Math.min(cy, GROUND_Y) - 0.4, cz);
    this.wall.scale.set(R + 0.3, 4.6, R + 0.3);
    this.wall.visible = true;
    this.opActive = true;
  }

  /** Ground ribbons widen with camera distance (strategic zoom keeps fronts legible). */
  setWidthScale(ground: number, arc: number): void {
    this.fronts.widthScale.value = ground; this.frontier.widthScale.value = ground; this.opLine.widthScale.value = ground;
    this.plan.widthScale.value = arc;
  }

  /** Op centre in world space (x, y, z) when a region is sealed. */
  opCentre(out: Float32Array): boolean {
    if (!this.opActive) return false;
    out[0] = this.opCenter[0]; out[1] = this.opCenter[1]; out[2] = this.opCenter[2];
    return true;
  }

  updateOp(now: number, running: boolean): void {
    if (!this.opActive) return;
    const pulse = 0.62 + 0.38 * Math.sin(now / 420);
    const hex = running ? 0xffd166 : 0xc8d0dc;
    const c = this.opLine.tint;
    c.setHex(hex);
    const k = running ? 1.25 : 0.8;
    c.multiplyScalar(k * (0.75 + 0.25 * pulse));
    this.wallU.uColor.value.setHex(hex);
    this.wallU.uAlpha.value = (running ? 0.42 : 0.2) * pulse;
  }

  // ------------------------------------------------------------------ plan overlay
  drawPlan(now: number, p: PlanOverlay | null, showPlans: boolean, showDanger: boolean, units: UnitLayer, rings: RingBatch): void {
    const th = this.th, B = this.plan;
    B.begin();
    if (!th || !p) { B.end(); return; }
    const fo = fIdx(p.faction);
    const fr = FACTION_LIN[fo], fg = FACTION_LIN[fo + 1], fb = FACTION_LIN[fo + 2];
    if (showDanger) {
      for (let i = 0; i < p.danger.length; i++) {
        const d = p.danger[i];
        if (!inTh(th, d.tile)) continue;
        const r = (10 + d.conf * 30) / 18;
        rings.push(th.x[d.tile], th.walk[d.tile] + 0.045, th.z[d.tile], r, 0.08, DISC, 1.6, 0.18, 0.18, 0.42, (0.06 + d.conf * 0.12) / 0.42);
      }
    }
    if (!showPlans || !inTh(th, p.target)) { B.end(); return; }
    for (let i = 0; i < p.candidates.length; i++) {
      const c = p.candidates[i];
      if (c.chosen || !inTh(th, c.tile)) continue;
      rings.push(th.x[c.tile], th.walk[c.tile] + 0.04, th.z[c.tile], 0.5, 0.055, RING, fr * 1.5, fg * 1.5, fb * 1.5, 0.38);
    }
    const tx = th.x[p.target], ty = th.walk[p.target], tz = th.z[p.target];
    const tr = (14 + Math.sin(now / 250) * 2) / 18;
    rings.push(tx, ty + 0.05, tz, tr, 0.11, RING, fr * 2.2, fg * 2.2, fb * 2.2, 0.9);
    rings.push(tx, ty + 0.05, tz, tr * 0.45, 0.06, DISC, fr * 1.6, fg * 1.6, fb * 1.6, 0.5, 0.7);
    rings.push(tx, ty + 0.05, tz, 1, 0.05, HEX_LINE, fr * 1.4, fg * 1.4, fb * 1.4, 0.35 + 0.15 * Math.sin(now / 300));
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (let i = 0; i < p.group.length; i++) {
      const u = units.units.get(p.group[i]);
      if (u) { cx += u.x; cy += u.y; cz += u.z; n++; }
    }
    if (!n) { B.end(); return; }
    cx /= n; cy /= n; cz /= n;
    const ax = cx, ay = cy + 0.35, az = cz, bx = tx, by = ty + 0.35, bz = tz;
    const dist = Math.hypot(bx - ax, bz - az);
    const mx = (ax + bx) / 2, my = Math.max(ay, by) + dist * 0.22 + 0.8, mz = (az + bz) / 2;
    linRGB(mixHex(factionHex(p.faction), 0xffffff, 0.3), RGB, 0, 2.4);
    const lr = RGB[0], lg = RGB[1], lb = RGB[2];
    const steps = 28;
    let px = ax, py = ay, pz = az, u = 0, qx = 0, qz = 0;
    for (let k = 1; k <= steps; k++) {
      const q = k / steps, w0 = (1 - q) * (1 - q), w1 = 2 * (1 - q) * q, w2 = q * q;
      const x = w0 * ax + w1 * mx + w2 * bx, y = w0 * ay + w1 * my + w2 * by, z = w0 * az + w1 * mz + w2 * bz;
      const len = Math.hypot(x - px, y - py, z - pz);
      B.seg(px, py, pz, x, y, z, 0.5, fr * 1.2, fg * 1.2, fb * 1.2, 0.13, 0.13);
      B.seg(px, py, pz, x, y, z, 0.13, lr, lg, lb, 0.92, 0.92, u, u + len, 0.9, 1.4);
      u += len; qx = x - px; qz = z - pz; px = x; py = y; pz = z;
    }
    // arrowhead on the last tangent, flattened to the horizontal so it reads from any yaw
    const hl = Math.hypot(qx, qz) || 1;
    const dx = qx / hl, dz = qz / hl;
    const wx = -dz * 0.42, wz = dx * 0.42;
    const backX = bx - dx * 0.75, backZ = bz - dz * 0.75;
    B.seg(backX + wx, by + 0.25, backZ + wz, bx, by, bz, 0.14, lr, lg, lb, 0.95, 0.95);
    B.seg(backX - wx, by + 0.25, backZ - wz, bx, by, bz, 0.14, lr, lg, lb, 0.95, 0.95);
    B.end();
  }

  /**
   * Every commander's announced target: a quiet faction ring that stays while the plan stands, and for a fresh
   * announcement an expanding pulse and hex outline that fade out over INTENT_FRESH_MS. `skip` is drawn by drawPlan.
   */
  drawIntents(now: number, list: IntentOverlay[], age: (owner: number, now: number) => number, show: boolean, skip: number, rings: RingBatch): void {
    const th = this.th;
    if (!th || !show) return;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it.owner === skip || !inTh(th, it.tile)) continue;
      const fo = fIdx(it.faction);
      const fr = FACTION_LIN[fo], fg = FACTION_LIN[fo + 1], fb = FACTION_LIN[fo + 2];
      const x = th.x[it.tile], y = th.walk[it.tile] + 0.045, z = th.z[it.tile];
      rings.push(x, y, z, 0.52, 0.05, RING, fr * 1.5, fg * 1.5, fb * 1.5, 0.45);
      rings.push(x, y, z, 0.16, 0.05, DISC, fr * 1.4, fg * 1.4, fb * 1.4, 0.55, 0.8);
      const a = age(it.owner, now);
      if (a < 0 || a >= INTENT_FRESH_MS) continue;
      const k = 1 - a / INTENT_FRESH_MS;
      const q = (a % 1400) / 1400;
      rings.push(x, y + 0.005, z, 0.6 + q * 1.9, 0.09, RING, fr * 2.4, fg * 2.4, fb * 2.4, (1 - q) * 0.85 * k);
      rings.push(x, y, z, 1, 0.06, HEX_LINE, fr * 2, fg * 2, fb * 2, 0.55 * k);
    }
  }

  /** Fog view: last-known enemy markers (stride 4: tile, cls, faction, age in ticks). */
  drawGhosts(ghosts: Float32Array | null, hud: SpriteBatch, rings: RingBatch): void {
    const th = this.th;
    if (!th || !ghosts) return;
    for (let i = 0; i + 3 < ghosts.length; i += 4) {
      const tile = ghosts[i], f = ghosts[i + 2], age = ghosts[i + 3];
      if (tile < 0 || tile >= th.n) continue;
      const a = Math.max(0.15, 1 - age / 900);
      const fo = fIdx(f);
      hud.push(th.x[tile], th.walk[tile] + 0.35, th.z[tile], 0, 0, 7, 7, SH_DIAMOND_LINE, FACTION_SRGB[fo], FACTION_SRGB[fo + 1], FACTION_SRGB[fo + 2], a);
      rings.push(th.x[tile], th.walk[tile] + 0.04, th.z[tile], 0.8, 0.04, HEX_LINE, FACTION_LIN[fo], FACTION_LIN[fo + 1], FACTION_LIN[fo + 2], a * 0.5);
    }
  }

  dispose(): void {
    this.fronts.dispose(); this.frontier.dispose(); this.opLine.dispose(); this.plan.dispose(); this.supply.dispose();
    (this.supply.points.material as THREE.Material).dispose();
    this.wall.geometry.dispose(); (this.wall.material as THREE.Material).dispose();
  }
}
