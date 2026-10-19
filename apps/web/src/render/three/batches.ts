// Preallocated dynamic primitive batches. Each batch is one draw call whose buffers are refilled in place
// (begin/push/end) so hot paths never allocate: ribbons (ground-hugging or camera-facing thick lines),
// ground rings/discs/hex flashes, screen-space HUD sprites, world-size billboards and soft particles.

import * as THREE from 'three';
import { FOG_FACTOR_GLSL, TIME, fogUniforms } from './materials.ts';

function dyn(arr: Float32Array, size: number, instanced = false): THREE.BufferAttribute {
  const a = instanced ? new THREE.InstancedBufferAttribute(arr, size) : new THREE.BufferAttribute(arr, size);
  a.setUsage(THREE.DynamicDrawUsage);
  return a;
}

// one reusable range object per attribute: addUpdateRange() allocates a fresh {start, count} per call, and
// three only mutates ranges when merging two or more, then empties the list after the upload
const RANGES = new WeakMap<THREE.BufferAttribute, { start: number; count: number }>();

/** Marks the first `count` items for upload without allocating; nothing to draw means nothing to upload. */
export function touchRange(a: THREE.BufferAttribute, count: number): void {
  if (count <= 0) return;
  let r = RANGES.get(a);
  if (!r) { r = { start: 0, count: 0 }; RANGES.set(a, r); }
  r.start = 0; r.count = count * a.itemSize;
  a.updateRanges.length = 0;
  a.updateRanges.push(r);
  a.needsUpdate = true;
}
const touch = touchRange;

/** Fragment tail shared by additive/normal batches: fog fade (additive -> toward black). */
function outFrag(additive: boolean): string {
  return additive
    ? `${FOG_FACTOR_GLSL}\n  gl_FragColor = vec4( col, a * ( 1.0 - fogF ) );`
    : `${FOG_FACTOR_GLSL}\n  #ifdef USE_FOG\n  col = mix( col, fogColor, fogF );\n  #endif\n  gl_FragColor = vec4( col, a );`;
}

// =====================================================================================================
export interface RibbonOpts { ground: boolean; additive: boolean; depthTest?: boolean; renderOrder?: number }

/**
 * Thick line segments. Ground ribbons extrude sideways in the XZ plane (fronts, roads of light, region
 * borders); billboard ribbons extrude perpendicular to the view ray (tracers, arcs, lightning).
 * Per segment: width, rgba at both ends, arc-length u for dashes, dash period/speed and a pulse amount.
 */
export class RibbonBatch {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly tint: THREE.Color;
  readonly opacity: { value: number };
  /** Multiplies every segment width; raised with camera distance so lines never go sub-pixel. */
  readonly widthScale: { value: number } = { value: 1 };
  n = 0;
  private cap = 0;
  private geo = new THREE.BufferGeometry();
  private aA!: Float32Array; private aB!: Float32Array; private aCol!: Float32Array; private aSty!: Float32Array; private aU!: Float32Array;
  private attrs: THREE.BufferAttribute[] = [];

  constructor(cap: number, o: RibbonOpts) {
    this.tint = new THREE.Color(1, 1, 1);
    this.opacity = { value: 1 };
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...fogUniforms(), uTime: TIME, uTint: { value: this.tint }, uOpacity: this.opacity, uWidth: this.widthScale },
      defines: o.ground ? { GROUND: 1 } : {},
      fog: true, transparent: true, depthWrite: false, depthTest: o.depthTest ?? true, side: THREE.DoubleSide,
      blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      polygonOffset: o.ground, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      vertexShader: /* glsl */ `
        attribute vec3 aA; attribute vec3 aB; attribute vec2 aCorner; attribute vec4 aColor; attribute vec4 aStyle; attribute vec2 aU;
        uniform float uWidth;
        varying vec4 vColor; varying float vSide; varying float vU; varying vec4 vStyle;
        #include <fog_pars_vertex>
        void main() {
          #ifdef GROUND
            vec3 dir = aB - aA;
            vec2 h = vec2( dir.x, dir.z );
            float hl = length( h );
            h = hl > 1e-6 ? h / hl : vec2( 1.0, 0.0 );
            vec3 p = mix( aA, aB, aCorner.x ) + vec3( -h.y, 0.0, h.x ) * ( aCorner.y * aStyle.x * uWidth * 0.5 );
            vec4 mvPosition = modelViewMatrix * vec4( p, 1.0 );
          #else
            vec4 ma = modelViewMatrix * vec4( aA, 1.0 );
            vec4 mb = modelViewMatrix * vec4( aB, 1.0 );
            vec4 mvPosition = mix( ma, mb, aCorner.x );
            vec3 s = cross( mb.xyz - ma.xyz, mvPosition.xyz );
            float sl = length( s );
            s = sl > 1e-6 ? s / sl : vec3( 0.0, 1.0, 0.0 );
            mvPosition.xyz += s * ( aCorner.y * aStyle.x * uWidth * 0.5 );
          #endif
          gl_Position = projectionMatrix * mvPosition;
          vColor = aColor; vSide = aCorner.y; vU = mix( aU.x, aU.y, aCorner.x ); vStyle = aStyle;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uTint; uniform float uOpacity;
        varying vec4 vColor; varying float vSide; varying float vU; varying vec4 vStyle;
        #include <fog_pars_fragment>
        void main() {
          float e = 1.0 - abs( vSide );
          float a = vColor.a * smoothstep( 0.0, 0.75, e ) * uOpacity;
          if ( vStyle.y > 0.0 ) {
            float ph = fract( vU / vStyle.y - uTime * vStyle.z );
            a *= smoothstep( 0.0, 0.07, ph ) * ( 1.0 - smoothstep( 0.46, 0.53, ph ) );
          }
          if ( vStyle.w > 0.0 ) a *= 1.0 + vStyle.w * sin( uTime * 2.6 + vU * 0.9 );
          if ( a <= 0.002 ) discard;
          vec3 col = vColor.rgb * uTint;
          ${outFrag(o.additive)}
        }`,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = o.renderOrder ?? 3;
    this.mesh.matrixAutoUpdate = false;
    this.alloc(cap);
  }

  private alloc(cap: number): void {
    const old = this.cap > 0 ? { a: this.aA, b: this.aB, c: this.aCol, s: this.aSty, u: this.aU } : null;
    this.cap = cap;
    const v = cap * 4;
    this.aA = new Float32Array(v * 3); this.aB = new Float32Array(v * 3);
    this.aCol = new Float32Array(v * 4); this.aSty = new Float32Array(v * 4); this.aU = new Float32Array(v * 2);
    if (old) { this.aA.set(old.a); this.aB.set(old.b); this.aCol.set(old.c); this.aSty.set(old.s); this.aU.set(old.u); }
    const corner = new Float32Array(v * 2);
    const idx = new Uint32Array(cap * 6);
    for (let i = 0; i < cap; i++) {
      corner.set([0, -1, 0, 1, 1, -1, 1, 1], i * 8);
      const b = i * 4;
      idx.set([b, b + 2, b + 1, b + 1, b + 2, b + 3], i * 6);
    }
    this.geo.dispose();
    this.geo = new THREE.BufferGeometry();
    const aA = dyn(this.aA, 3), aB = dyn(this.aB, 3), aC = dyn(this.aCol, 4), aS = dyn(this.aSty, 4), aU = dyn(this.aU, 2);
    this.geo.setAttribute('aA', aA); this.geo.setAttribute('aB', aB); this.geo.setAttribute('aColor', aC);
    this.geo.setAttribute('aStyle', aS); this.geo.setAttribute('aU', aU);
    this.geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    // three needs a position attribute for draw-range bookkeeping; aA doubles as it
    this.geo.setAttribute('position', aA);
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.attrs = [aA, aB, aC, aS, aU];
    this.mesh.geometry = this.geo;
    this.geo.setDrawRange(0, this.n * 6);
  }

  begin(): void { this.n = 0; }

  /** Appends one segment; grows when `grow` is set (static rebuilds), otherwise drops when full. */
  seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number, width: number,
    r: number, g: number, b: number, a0: number, a1: number, u0 = 0, u1 = 0, dash = 0, dashSpeed = 0, pulse = 0, grow = false): boolean {
    if (this.n >= this.cap) {
      if (!grow) return false;
      this.alloc(this.cap * 2);
    }
    const i = this.n++;
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      this.aA[v * 3] = ax; this.aA[v * 3 + 1] = ay; this.aA[v * 3 + 2] = az;
      this.aB[v * 3] = bx; this.aB[v * 3 + 1] = by; this.aB[v * 3 + 2] = bz;
      const a = k < 2 ? a0 : a1;
      this.aCol[v * 4] = r; this.aCol[v * 4 + 1] = g; this.aCol[v * 4 + 2] = b; this.aCol[v * 4 + 3] = a;
      this.aSty[v * 4] = width; this.aSty[v * 4 + 1] = dash; this.aSty[v * 4 + 2] = dashSpeed; this.aSty[v * 4 + 3] = pulse;
      this.aU[v * 2] = u0; this.aU[v * 2 + 1] = u1;
    }
    return true;
  }

  end(): void {
    const v = this.n * 4;
    for (const a of this.attrs) touch(a, v);
    this.geo.setDrawRange(0, this.n * 6);
    this.mesh.visible = this.n > 0;
  }

  dispose(): void { this.geo.dispose(); this.material.dispose(); }
}

// =====================================================================================================
export const RING = 0, HEX_FILL = 1, DISC = 2, HEX_LINE = 3;

/** Ground-plane rings, filled discs and hex flashes as instanced quads (one draw call). */
export class RingBatch {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  n = 0;
  private cap: number;
  private geo: THREE.InstancedBufferGeometry;
  private iPos: Float32Array; private iShape: Float32Array; private iCol: Float32Array;
  private attrs: THREE.BufferAttribute[];

  constructor(cap: number, additive = true, renderOrder = 4) {
    this.cap = cap;
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]), 3));
    this.geo.setIndex([0, 2, 1, 0, 3, 2]);
    this.iPos = new Float32Array(cap * 3); this.iShape = new Float32Array(cap * 4); this.iCol = new Float32Array(cap * 4);
    const a = dyn(this.iPos, 3, true), b = dyn(this.iShape, 4, true), c = dyn(this.iCol, 4, true);
    this.geo.setAttribute('iPos', a); this.geo.setAttribute('iShape', b); this.geo.setAttribute('iColor', c);
    this.attrs = [a, b, c];
    this.geo.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...fogUniforms() },
      fog: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      vertexShader: /* glsl */ `
        attribute vec3 iPos; attribute vec4 iShape; attribute vec4 iColor;
        varying vec2 vLocal; varying vec4 vShape; varying vec4 vColor;
        #include <fog_pars_vertex>
        void main() {
          float ext = iShape.x + iShape.y * 1.6 + 0.02;
          vec3 wp = iPos + vec3( position.x, 0.0, position.z ) * ext;
          vLocal = position.xz * ext; vShape = iShape; vColor = iColor;
          vec4 mvPosition = modelViewMatrix * vec4( wp, 1.0 );
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vLocal; varying vec4 vShape; varying vec4 vColor;
        #include <fog_pars_fragment>
        void main() {
          float R = vShape.x, W = max( vShape.y, 0.004 ), mode = vShape.z, fill = vShape.w;
          float d = length( vLocal );
          float hx = abs( vLocal.x ), hz = abs( vLocal.y );
          float din = max( hx, hx * 0.5 + hz * 0.8660254 );
          float a;
          if ( mode < 0.5 ) {
            float q = abs( d - R );
            a = 1.0 - smoothstep( W * 0.2, W * 0.5, q );
            a += ( 1.0 - smoothstep( 0.0, W * 1.6, q ) ) * 0.3;
          } else if ( mode < 1.5 ) {
            a = 1.0 - smoothstep( R * 0.866 - W, R * 0.866, din );
          } else if ( mode < 2.5 ) {
            float inside = 1.0 - smoothstep( R - W * 0.5, R, d );
            float edge = 1.0 - smoothstep( 0.0, W * 0.5, abs( d - R + W * 0.25 ) );
            a = max( inside * fill * ( 0.55 + 0.45 * d / max( R, 0.001 ) ), edge );
          } else {
            a = 1.0 - smoothstep( W * 0.2, W * 0.5, abs( din - R * 0.866 ) );
          }
          a *= vColor.a;
          if ( a <= 0.002 ) discard;
          vec3 col = vColor.rgb;
          ${outFrag(additive)}
        }`,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.matrixAutoUpdate = false;
  }

  begin(): void { this.n = 0; }

  push(x: number, y: number, z: number, radius: number, width: number, mode: number, r: number, g: number, b: number, a: number, fill = 0): void {
    if (this.n >= this.cap || a <= 0.002 || radius <= 0) return;
    const i = this.n++;
    this.iPos[i * 3] = x; this.iPos[i * 3 + 1] = y; this.iPos[i * 3 + 2] = z;
    this.iShape[i * 4] = radius; this.iShape[i * 4 + 1] = width; this.iShape[i * 4 + 2] = mode; this.iShape[i * 4 + 3] = fill;
    this.iCol[i * 4] = r; this.iCol[i * 4 + 1] = g; this.iCol[i * 4 + 2] = b; this.iCol[i * 4 + 3] = a;
  }

  end(): void {
    for (const a of this.attrs) touch(a, this.n);
    this.geo.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
  }

  dispose(): void { this.geo.dispose(); this.material.dispose(); }
}

// =====================================================================================================
export const SH_RECT = 0, SH_DIAMOND_LINE = 1, SH_STAR = 2, SH_CHEVRON = 3, SH_DOT = 4, SH_DIAMOND = 5;

/**
 * Screen-space sprites anchored to world points (health bars, markers, ghosts): constant pixel size,
 * one draw call. Offsets and half sizes are CSS pixels, +y up. Rendered after the post chain directly to
 * the canvas, so colours are display sRGB and bars stay crisp and untouched by tone mapping or bloom.
 */
export class SpriteBatch {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  n = 0;
  private cap: number;
  private geo: THREE.InstancedBufferGeometry;
  private iC: Float32Array; private iR: Float32Array; private iCol: Float32Array; private iS: Float32Array;
  private attrs: THREE.BufferAttribute[];
  readonly res: THREE.Vector2 = new THREE.Vector2(1, 1);
  readonly pr: { value: number } = { value: 1 };

  constructor(cap: number, renderOrder = 9) {
    this.cap = cap;
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.iC = new Float32Array(cap * 3); this.iR = new Float32Array(cap * 4); this.iCol = new Float32Array(cap * 4); this.iS = new Float32Array(cap);
    const a = dyn(this.iC, 3, true), b = dyn(this.iR, 4, true), c = dyn(this.iCol, 4, true), d = dyn(this.iS, 1, true);
    this.geo.setAttribute('iCenter', a); this.geo.setAttribute('iRect', b); this.geo.setAttribute('iColor', c); this.geo.setAttribute('iShape', d);
    this.attrs = [a, b, c, d];
    this.geo.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uRes: { value: this.res }, uPr: this.pr },
      // drawn in a separate pass straight to the canvas after tone mapping: colours are sRGB, no depth
      transparent: true, depthWrite: false, depthTest: false,
      vertexShader: /* glsl */ `
        attribute vec3 iCenter; attribute vec4 iRect; attribute vec4 iColor; attribute float iShape;
        uniform vec2 uRes; uniform float uPr;
        varying vec2 vUv; varying vec4 vColor; varying float vShape;
        void main() {
          vec4 clip = projectionMatrix * modelViewMatrix * vec4( iCenter, 1.0 );
          if ( clip.w <= 0.0 ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); return; }
          vec2 px = ( iRect.xy + position.xy * iRect.zw ) * uPr;
          clip.xy += px * 2.0 / uRes * clip.w;
          gl_Position = clip;
          vUv = position.xy; vColor = iColor; vShape = iShape;
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying vec4 vColor; varying float vShape;
        float sdStar5( vec2 p, float r, float rf ) {
          const vec2 k1 = vec2( 0.809016994375, -0.587785252292 );
          const vec2 k2 = vec2( -k1.x, k1.y );
          p.x = abs( p.x );
          p -= 2.0 * max( dot( k1, p ), 0.0 ) * k1;
          p -= 2.0 * max( dot( k2, p ), 0.0 ) * k2;
          p.x = abs( p.x );
          p.y -= r;
          vec2 ba = rf * vec2( -k1.y, k1.x ) - vec2( 0.0, 1.0 );
          float h = clamp( dot( p, ba ) / dot( ba, ba ), 0.0, r );
          return length( p - ba * h ) * sign( p.y * ba.x - p.x * ba.y );
        }
        void main() {
          float a = 1.0;
          vec2 p = vUv;
          if ( vShape > 4.5 ) a = 1.0 - smoothstep( 0.82, 1.0, abs( p.x ) + abs( p.y ) );
          else if ( vShape > 3.5 ) a = 1.0 - smoothstep( 0.6, 1.0, length( p ) );
          else if ( vShape > 2.5 ) a = 1.0 - smoothstep( -0.08, 0.08, abs( p.y ) - ( p.x + 1.0 ) * 0.5 );
          else if ( vShape > 1.5 ) a = 1.0 - smoothstep( -0.06, 0.06, sdStar5( vec2( p.x, -p.y ) * 1.05 + vec2( 0.0, 0.08 ), 0.9, 0.45 ) );
          else if ( vShape > 0.5 ) { float d = abs( p.x ) + abs( p.y ); a = ( 1.0 - smoothstep( 0.86, 1.0, d ) ) * smoothstep( 0.52, 0.68, d ); }
          a *= vColor.a;
          if ( a <= 0.003 ) discard;
          gl_FragColor = vec4( vColor.rgb, a );
        }`,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.matrixAutoUpdate = false;
  }

  begin(): void { this.n = 0; }

  push(x: number, y: number, z: number, ox: number, oy: number, hw: number, hh: number, shape: number, r: number, g: number, b: number, a: number): void {
    if (this.n >= this.cap || a <= 0.003) return;
    const i = this.n++;
    this.iC[i * 3] = x; this.iC[i * 3 + 1] = y; this.iC[i * 3 + 2] = z;
    this.iR[i * 4] = ox; this.iR[i * 4 + 1] = oy; this.iR[i * 4 + 2] = hw; this.iR[i * 4 + 3] = hh;
    this.iCol[i * 4] = r; this.iCol[i * 4 + 1] = g; this.iCol[i * 4 + 2] = b; this.iCol[i * 4 + 3] = a;
    this.iS[i] = shape;
  }

  /** A left-anchored bar: background plus fill fraction `f` in colour (r,g,b). */
  bar(x: number, y: number, z: number, oy: number, w: number, f: number, r: number, g: number, b: number, a: number): void {
    this.push(x, y, z, 0, oy, w / 2 + 1, 2.2, SH_RECT, 0.012, 0.016, 0.022, 0.86 * a);
    const fw = (w * Math.max(0, Math.min(1, f))) / 2;
    if (fw > 0.05) this.push(x, y, z, -w / 2 + fw, oy, fw, 1.2, SH_RECT, r, g, b, a);
  }

  end(): void {
    for (const a of this.attrs) touch(a, this.n);
    this.geo.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
  }

  dispose(): void { this.geo.dispose(); this.material.dispose(); }
}

// =====================================================================================================
/** World-size camera-facing soft billboards (storm clouds). Normal blending, procedural puffy noise. */
export class BillboardBatch {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  n = 0;
  private cap: number;
  private geo: THREE.InstancedBufferGeometry;
  private iC: Float32Array; private iSz: Float32Array; private iCol: Float32Array;
  private attrs: THREE.BufferAttribute[];

  constructor(cap: number, renderOrder = 8) {
    this.cap = cap;
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.iC = new Float32Array(cap * 3); this.iSz = new Float32Array(cap * 3); this.iCol = new Float32Array(cap * 4);
    const a = dyn(this.iC, 3, true), b = dyn(this.iSz, 3, true), c = dyn(this.iCol, 4, true);
    this.geo.setAttribute('iCenter', a); this.geo.setAttribute('iSize', b); this.geo.setAttribute('iColor', c);
    this.attrs = [a, b, c];
    this.geo.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...fogUniforms(), uTime: TIME },
      fog: true, transparent: true, depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec3 iCenter; attribute vec3 iSize; attribute vec4 iColor;
        varying vec2 vUv; varying vec4 vColor; varying float vSeed;
        #include <fog_pars_vertex>
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4( iCenter, 1.0 );
          float c = cos( iSize.z ), s = sin( iSize.z );
          vec2 q = vec2( position.x * c - position.y * s, position.x * s + position.y * c );
          mvPosition.xy += q * iSize.xy;
          gl_Position = projectionMatrix * mvPosition;
          vUv = position.xy; vColor = iColor; vSeed = iSize.z;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv; varying vec4 vColor; varying float vSeed;
        #include <fog_pars_fragment>
        float h21( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
        float vn( vec2 p ) {
          vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
          return mix( mix( h21( i ), h21( i + vec2( 1.0, 0.0 ) ), f.x ), mix( h21( i + vec2( 0.0, 1.0 ) ), h21( i + 1.0 ), f.x ), f.y );
        }
        void main() {
          float r = length( vUv );
          if ( r > 1.0 ) discard;
          vec2 p = vUv * 2.2 + vec2( vSeed * 3.7, vSeed * 1.3 ) + vec2( uTime * 0.03, 0.0 );
          float n = vn( p ) * 0.55 + vn( p * 2.1 ) * 0.3 + vn( p * 4.3 ) * 0.15;
          float a = ( 1.0 - smoothstep( 0.25, 1.0, r ) ) * smoothstep( 0.25, 0.75, n + 0.35 * ( 1.0 - r ) ) * vColor.a;
          if ( a <= 0.003 ) discard;
          vec3 col = vColor.rgb * ( 0.8 + 0.4 * n );
          ${outFrag(false)}
        }`,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.matrixAutoUpdate = false;
  }

  begin(): void { this.n = 0; }

  push(x: number, y: number, z: number, sx: number, sy: number, rot: number, r: number, g: number, b: number, a: number): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.iC[i * 3] = x; this.iC[i * 3 + 1] = y; this.iC[i * 3 + 2] = z;
    this.iSz[i * 3] = sx; this.iSz[i * 3 + 1] = sy; this.iSz[i * 3 + 2] = rot;
    this.iCol[i * 4] = r; this.iCol[i * 4 + 1] = g; this.iCol[i * 4 + 2] = b; this.iCol[i * 4 + 3] = a;
  }

  end(): void {
    for (const a of this.attrs) touch(a, this.n);
    this.geo.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
  }

  dispose(): void { this.geo.dispose(); this.material.dispose(); }
}

// =====================================================================================================
export const P_GLOW = 0, P_DOT = 1, P_SMOKE = 2;

/** Upper bound for gl_PointSize; the renderer replaces it with the GPU's ALIASED_POINT_SIZE_RANGE maximum. */
export const POINT_MAX: { value: number } = { value: 256 };

/** Soft sprite shapes shared by points and quads: glow (gaussian), dot (hard core) or smoke (puffy). */
const SPRITE_FRAG = /* glsl */ `
  float r2 = dot( p, p );
  if ( r2 > 1.0 ) discard;
  float a;
  if ( vKind < 0.5 ) a = exp( -r2 * 3.6 ) - 0.027;
  else if ( vKind < 1.5 ) { float q = 1.0 - r2; a = q * q * ( 0.6 + 0.4 * step( r2, 0.18 ) ); }
  else {
    float ang = atan( p.y, p.x );
    float lump = 0.82 + 0.18 * sin( ang * 3.0 + vSeed * 6.28 ) * sin( ang * 5.0 - vSeed * 9.0 );
    a = 1.0 - smoothstep( lump * 0.35, lump, sqrt( r2 ) );
  }
  a *= vColor.a;
  if ( a <= 0.003 ) discard;
  vec3 col = vColor.rgb;
`;

/** Points material with the soft sprite (small static dots such as supply markers). Size is world units. */
export function pointsMaterial(additive: boolean, scale: { value: number }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...fogUniforms(), uScale: scale, uMaxPt: POINT_MAX },
    fog: true, transparent: true, depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aColor; attribute vec2 aSK;
      uniform float uScale; uniform float uMaxPt;
      varying vec4 vColor; varying float vKind; varying float vSeed;
      #include <fog_pars_vertex>
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = clamp( aSK.x * uScale / max( 0.05, -mvPosition.z ), 1.0, uMaxPt );
        vColor = aColor; vKind = aSK.y; vSeed = fract( position.x * 3.17 + position.z * 1.71 );
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      varying vec4 vColor; varying float vKind; varying float vSeed;
      #include <fog_pars_fragment>
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        ${SPRITE_FRAG}
        ${outFrag(additive)}
      }`,
  });
}

/**
 * The same soft sprite drawn as instanced camera-facing quads (particles). Unlike points, quads have no
 * driver size cap (big glows stay big up close) and clip per pixel instead of popping out when their
 * centre leaves the screen. iPos/aColor/aSK per instance; size is the diameter in world units, at least
 * about one pixel like the point path.
 */
export function spriteMaterial(additive: boolean, scale: { value: number }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...fogUniforms(), uScale: scale },
    fog: true, transparent: true, depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    vertexShader: /* glsl */ `
      attribute vec3 iPos; attribute vec4 aColor; attribute vec2 aSK;
      uniform float uScale;
      varying vec4 vColor; varying float vKind; varying float vSeed; varying vec2 vP;
      #include <fog_pars_vertex>
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4( iPos, 1.0 );
        float hs = max( aSK.x * 0.5, 0.5 * max( 0.05, -mvPosition.z ) / uScale );
        mvPosition.xy += position.xy * hs;
        gl_Position = projectionMatrix * mvPosition;
        vP = position.xy; vColor = aColor; vKind = aSK.y; vSeed = fract( iPos.x * 3.17 + iPos.z * 1.71 );
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      varying vec4 vColor; varying float vKind; varying float vSeed; varying vec2 vP;
      #include <fog_pars_fragment>
      void main() {
        vec2 p = vP;
        ${SPRITE_FRAG}
        ${outFrag(additive)}
      }`,
  });
}

/** Static or rebuilt-on-change point cloud using the soft sprite material (supply dots). */
export class PointCloud {
  readonly points: THREE.Points;
  private geo = new THREE.BufferGeometry();
  private cap = 0;
  n = 0;
  private pos = new Float32Array(0); private col = new Float32Array(0); private sk = new Float32Array(0);

  constructor(material: THREE.ShaderMaterial, renderOrder = 4) {
    this.points = new THREE.Points(this.geo, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
    this.points.matrixAutoUpdate = false;
    this.alloc(256);
  }

  private alloc(cap: number): void {
    const op = this.pos, oc = this.col, os = this.sk;
    this.cap = cap;
    this.pos = new Float32Array(cap * 3); this.col = new Float32Array(cap * 4); this.sk = new Float32Array(cap * 2);
    this.pos.set(op.subarray(0, Math.min(op.length, this.pos.length))); this.col.set(oc.subarray(0, Math.min(oc.length, this.col.length))); this.sk.set(os.subarray(0, Math.min(os.length, this.sk.length)));
    this.geo.dispose();
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', dyn(this.pos, 3));
    this.geo.setAttribute('aColor', dyn(this.col, 4));
    this.geo.setAttribute('aSK', dyn(this.sk, 2));
    this.points.geometry = this.geo;
  }

  begin(): void { this.n = 0; }

  push(x: number, y: number, z: number, size: number, kind: number, r: number, g: number, b: number, a: number): void {
    if (this.n >= this.cap) this.alloc(this.cap * 2);
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = a;
    this.sk[i * 2] = size; this.sk[i * 2 + 1] = kind;
  }

  end(): void {
    touch(this.geo.getAttribute('position') as THREE.BufferAttribute, this.n);
    touch(this.geo.getAttribute('aColor') as THREE.BufferAttribute, this.n);
    touch(this.geo.getAttribute('aSK') as THREE.BufferAttribute, this.n);
    this.geo.setDrawRange(0, this.n);
    this.points.visible = this.n > 0;
  }

  dispose(): void { this.geo.dispose(); }
}

/**
 * Simulated particles in struct-of-arrays form with swap-remove, so spawning and ageing never allocate.
 * Velocities are world units per second; life in ms; negative life is a start delay. Drawn as one batch of
 * instanced camera-facing quads (spriteMaterial).
 */
export class ParticleSystem {
  readonly mesh: THREE.Mesh;
  readonly cap: number;
  n = 0;
  private px: Float32Array; private py: Float32Array; private pz: Float32Array;
  private vx: Float32Array; private vy: Float32Array; private vz: Float32Array;
  private life: Float32Array; private max: Float32Array; private s0: Float32Array; private s1: Float32Array;
  private a0: Float32Array; private grav: Float32Array; private drag: Float32Array;
  private cr: Float32Array; private cg: Float32Array; private cb: Float32Array; private kind: Uint8Array;
  private geo = new THREE.InstancedBufferGeometry();
  private pos: Float32Array; private col: Float32Array; private sk: Float32Array;
  private aPos: THREE.BufferAttribute; private aCol: THREE.BufferAttribute; private aSK: THREE.BufferAttribute;
  private extra = 0; // one-frame points appended after the simulated ones
  private extraCap: number;

  constructor(cap: number, material: THREE.ShaderMaterial, renderOrder: number, extraCap = 256) {
    this.cap = cap;
    this.extraCap = extraCap;
    const f = () => new Float32Array(cap);
    this.px = f(); this.py = f(); this.pz = f(); this.vx = f(); this.vy = f(); this.vz = f();
    this.life = f(); this.max = f(); this.s0 = f(); this.s1 = f(); this.a0 = f(); this.grav = f(); this.drag = f();
    this.cr = f(); this.cg = f(); this.cb = f(); this.kind = new Uint8Array(cap);
    const tot = cap + extraCap;
    this.pos = new Float32Array(tot * 3); this.col = new Float32Array(tot * 4); this.sk = new Float32Array(tot * 2);
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.aPos = dyn(this.pos, 3, true); this.aCol = dyn(this.col, 4, true); this.aSK = dyn(this.sk, 2, true);
    this.geo.setAttribute('iPos', this.aPos);
    this.geo.setAttribute('aColor', this.aCol);
    this.geo.setAttribute('aSK', this.aSK);
    this.geo.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, a0: number,
    r: number, g: number, b: number, kind: number, grav = 0, drag = 0, delay = 0): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z; this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = -delay; this.max[i] = life; this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = a0;
    this.grav[i] = grav; this.drag[i] = drag; this.cr[i] = r; this.cg[i] = g; this.cb[i] = b; this.kind[i] = kind;
  }

  /** A point drawn for this frame only (shell heads, flashes that follow other objects). */
  flash(x: number, y: number, z: number, size: number, kind: number, r: number, g: number, b: number, a: number): void {
    if (this.extra >= this.extraCap) return;
    const i = this.cap + this.extra++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = a;
    this.sk[i * 2] = size; this.sk[i * 2 + 1] = kind;
  }

  private kill(i: number): void {
    const j = --this.n;
    if (i === j) return;
    this.px[i] = this.px[j]; this.py[i] = this.py[j]; this.pz[i] = this.pz[j];
    this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j]; this.vz[i] = this.vz[j];
    this.life[i] = this.life[j]; this.max[i] = this.max[j]; this.s0[i] = this.s0[j]; this.s1[i] = this.s1[j];
    this.a0[i] = this.a0[j]; this.grav[i] = this.grav[j]; this.drag[i] = this.drag[j];
    this.cr[i] = this.cr[j]; this.cg[i] = this.cg[j]; this.cb[i] = this.cb[j]; this.kind[i] = this.kind[j];
  }

  /** Ages, integrates and writes the draw buffers: live particles first, then this frame's flashes. */
  update(dtMs: number): void {
    const dt = dtMs / 1000;
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      this.life[i] += dtMs;
      const life = this.life[i];
      if (life >= this.max[i]) { this.kill(i); i--; continue; }
      if (life < 0) continue;
      const q = life / this.max[i];
      if (this.drag[i] > 0) {
        const d = Math.exp(-this.drag[i] * dt);
        this.vx[i] *= d; this.vy[i] *= d; this.vz[i] *= d;
      }
      this.vy[i] -= this.grav[i] * dt;
      this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
      if (this.grav[i] > 0 && this.py[i] < 0.15) { this.py[i] = 0.15; this.vy[i] *= -0.25; this.vx[i] *= 0.5; this.vz[i] *= 0.5; }
      const fade = q < 0.08 ? q / 0.08 : 1;
      this.pos[w * 3] = this.px[i]; this.pos[w * 3 + 1] = this.py[i]; this.pos[w * 3 + 2] = this.pz[i];
      this.col[w * 4] = this.cr[i]; this.col[w * 4 + 1] = this.cg[i]; this.col[w * 4 + 2] = this.cb[i];
      this.col[w * 4 + 3] = this.a0[i] * (1 - q) * fade;
      this.sk[w * 2] = this.s0[i] + (this.s1[i] - this.s0[i]) * q; this.sk[w * 2 + 1] = this.kind[i];
      w++;
    }
    // compact the one-frame flashes right after the live particles
    for (let k = 0; k < this.extra; k++) {
      const s = this.cap + k;
      this.pos[w * 3] = this.pos[s * 3]; this.pos[w * 3 + 1] = this.pos[s * 3 + 1]; this.pos[w * 3 + 2] = this.pos[s * 3 + 2];
      this.col[w * 4] = this.col[s * 4]; this.col[w * 4 + 1] = this.col[s * 4 + 1]; this.col[w * 4 + 2] = this.col[s * 4 + 2]; this.col[w * 4 + 3] = this.col[s * 4 + 3];
      this.sk[w * 2] = this.sk[s * 2]; this.sk[w * 2 + 1] = this.sk[s * 2 + 1];
      w++;
    }
    this.extra = 0;
    touch(this.aPos, w); touch(this.aCol, w); touch(this.aSK, w);
    this.geo.instanceCount = w;
    this.mesh.visible = w > 0;
  }

  clear(): void { this.n = 0; this.extra = 0; }

  dispose(): void { this.geo.dispose(); }
}
