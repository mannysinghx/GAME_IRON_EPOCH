// Material factories. Lit meshes use MeshStandardMaterial with small shader patches (per-vertex part
// tint/glow, water shimmer, scenery fog boost) so instanced meshes keep one material per kind and the
// lighting, fog and shadow code stays three's own. Custom ShaderMaterials share one time uniform.

import * as THREE from 'three';

/** Seconds since the renderer started; written once per frame. */
export const TIME: { value: number } = { value: 0 };

/** Fog factor for custom shaders (additive ones fade to black instead of mixing toward the fog colour). */
export const FOG_FACTOR_GLSL = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogF = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogF = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
#else
  float fogF = 0.0;
#endif
`;

export function fogUniforms(): Record<string, THREE.IUniform> {
  return THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
}

const PART_COLOR_VERTEX = /* glsl */ `
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  vColor = vec3( 1.0 );
#endif
#ifdef USE_COLOR
  vColor *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  vColor = mix( vColor, vColor * instanceColor.xyz, aPart.x );
#endif
vGlow = aPart.y;
`;

// hologram: every part takes the instance colour; albedo only modulates it (dark parts read dimmer) so the
// model keeps its shape but reads as one cyan projection
const HOLO_COLOR_VERTEX = /* glsl */ `
vColor = vec3( 1.0 );
#ifdef USE_INSTANCING_COLOR
  vColor = instanceColor.xyz;
#endif
#ifdef USE_COLOR
  vColor *= 0.6 + 0.4 * clamp( dot( color, vec3( 0.3, 0.59, 0.11 ) ) * 2.5, 0.0, 1.0 );
#endif
vGlow = aPart.y;
`;

/**
 * Edge of the streamed land: beyond uFadeR.x..uFadeR.y world units from uFadeC (xz) everything that opts in
 * melts fully into the fog colour, so the end of the loaded chunks (and the bare ground disc beyond) never
 * shows at low pitch, without thickening the fog over the battlefield itself. SceneryField writes it.
 */
export const EDGE_FADE = { uFadeC: { value: new THREE.Vector2(0, 0) }, uFadeR: { value: new THREE.Vector2(1e8, 2e8) } };
const FADE_PARS = 'uniform vec2 uFadeC;\nuniform vec2 uFadeR;\nvarying vec3 vWp;';
const FADE_GLSL = 'fogFactor = max( fogFactor, smoothstep( uFadeR.x, uFadeR.y, length( vWp.xz - uFadeC ) ) );';
const WORLD_POS_VERTEX = /* glsl */ `#include <project_vertex>
#ifdef USE_INSTANCING
  vWp = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
#else
  vWp = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
#endif`;

function fogBoostFragment(fade: boolean): string {
  return /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  fogFactor = clamp( fogFactor * uFogBoost + uFogBias, 0.0, 1.0 );
  ${fade ? FADE_GLSL : ''}
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif
`;
}
const FOG_BOOST_FRAGMENT = fogBoostFragment(false);

export interface PartOpts {
  glow?: number; roughness?: number; metalness?: number; transparent?: boolean; opacity?: number;
  fogBoost?: number; fogBias?: number; emissive?: number; emissiveIntensity?: number; depthWrite?: boolean;
  /** Every part takes the instance colour (construction hologram) instead of only tint parts. */
  holo?: boolean;
  /** Per-instance brightness from an `iDim` instanced attribute (fog view); the geometry must carry it. */
  dim?: boolean;
}

/**
 * Lit material for merged "part" geometry: vertex colour = part albedo, attribute aPart = (tint, glow).
 * tint 1 multiplies the albedo by the per-instance faction colour; glow adds albedo * colour as emission
 * scaled by uGlow so accents bloom. The uniform object lives in userData.uGlow for later tweaks.
 */
export function partMaterial(o: PartOpts = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: o.roughness ?? 0.72, metalness: o.metalness ?? 0.18,
    transparent: o.transparent ?? false, opacity: o.opacity ?? 1, depthWrite: o.depthWrite ?? !(o.transparent ?? false),
    emissive: o.emissive ?? 0x000000, emissiveIntensity: o.emissiveIntensity ?? 1,
  });
  const uGlow = { value: o.glow ?? 2.6 };
  const boost = o.fogBoost !== undefined;
  const uFogBoost = { value: o.fogBoost ?? 1 }, uFogBias = { value: o.fogBias ?? 0 };
  const holo = o.holo === true, dim = o.dim === true;
  m.userData.uGlow = uGlow;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uGlow = uGlow;
    // vColor feeds both albedo and glow, so scaling it by iDim dims the whole instance, accents included
    const colorCode = (holo ? HOLO_COLOR_VERTEX : PART_COLOR_VERTEX) + (dim ? 'vColor *= iDim;\n' : '');
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec2 aPart;\nvarying float vGlow;${dim ? '\nattribute float iDim;' : ''}`)
      .replace('#include <color_vertex>', colorCode);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;\nuniform float uGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n#ifdef USE_COLOR\n  totalEmissiveRadiance += vColor.rgb * vGlow * uGlow;\n#endif');
    if (boost) {
      shader.uniforms.uFogBoost = uFogBoost;
      shader.uniforms.uFogBias = uFogBias;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uFogBoost;\nuniform float uFogBias;')
        .replace('#include <fog_fragment>', FOG_BOOST_FRAGMENT);
    }
  };
  const key = `ie-part${boost ? '-fog' : ''}${holo ? '-holo' : ''}${dim ? '-dim' : ''}`;
  m.customProgramCacheKey = () => key;
  return m;
}

/** Plain vertex-coloured lit material (terrain, decor). Optional scenery fog boost and streamed-edge fade. */
export function terrainMaterial(o: { roughness?: number; metalness?: number; fogBoost?: number; fogBias?: number; edgeFade?: boolean } = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: o.roughness ?? 0.92, metalness: o.metalness ?? 0.02 });
  if (o.fogBoost !== undefined) {
    const uFogBoost = { value: o.fogBoost }, uFogBias = { value: o.fogBias ?? 0 };
    const fade = o.edgeFade === true;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uFogBoost = uFogBoost;
      shader.uniforms.uFogBias = uFogBias;
      if (fade) {
        shader.uniforms.uFadeC = EDGE_FADE.uFadeC;
        shader.uniforms.uFadeR = EDGE_FADE.uFadeR;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vWp;')
          .replace('#include <project_vertex>', WORLD_POS_VERTEX);
      }
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform float uFogBoost;\nuniform float uFogBias;${fade ? `\n${FADE_PARS}` : ''}`)
        .replace('#include <fog_fragment>', fogBoostFragment(fade));
    };
    m.customProgramCacheKey = () => (fade ? 'ie-terrain-fog-fade' : 'ie-terrain-fog');
  }
  return m;
}

/**
 * Dark glossy water with a gentle animated shimmer: a moving interference pattern adds a faint blue
 * emission and tilts the shading normal slightly so the sun's specular highlight glints.
 */
export function waterMaterial(o: { fogBoost?: number; fogBias?: number; shimmer?: number; edgeFade?: boolean } = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.26, metalness: 0.12 });
  const uShimmer = { value: o.shimmer ?? 1 };
  const boost = o.fogBoost !== undefined;
  const fade = boost && o.edgeFade === true;
  const uFogBoost = { value: o.fogBoost ?? 1 }, uFogBias = { value: o.fogBias ?? 0 };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = TIME;
    shader.uniforms.uShimmer = uShimmer;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp;')
      .replace('#include <project_vertex>', WORLD_POS_VERTEX);
    let fs = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp;\nuniform float uTime;\nuniform float uShimmer;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  float sh1 = sin( vWp.x * 1.9 + uTime * 1.15 ) * sin( vWp.z * 1.55 - uTime * 0.85 );
  float sh2 = sin( ( vWp.x - vWp.z ) * 3.3 + uTime * 2.1 );
  normal = normalize( normal + vec3( sh1 * 0.06, 0.0, sh2 * 0.05 ) * uShimmer );`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance += vec3( 0.004, 0.012, 0.024 ) * ( 1.3 + sh1 + 0.5 * sh2 ) * uShimmer;`);
    if (boost) {
      shader.uniforms.uFogBoost = uFogBoost;
      shader.uniforms.uFogBias = uFogBias;
      if (fade) { shader.uniforms.uFadeC = EDGE_FADE.uFadeC; shader.uniforms.uFadeR = EDGE_FADE.uFadeR; }
      // vWp is already declared above for the shimmer, so the fade only adds its uniforms
      fs = fs.replace('#include <common>', `#include <common>\nuniform float uFogBoost;\nuniform float uFogBias;${fade ? '\nuniform vec2 uFadeC;\nuniform vec2 uFadeR;' : ''}`)
        .replace('#include <fog_fragment>', fogBoostFragment(fade));
    }
    shader.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => (fade ? 'ie-water-fog-fade' : boost ? 'ie-water-fog' : 'ie-water');
  return m;
}

/** Flickering self-lit embers (ruins) - unlit, HDR so they bloom. Optional streamed-edge fade (scenery). */
export function emberMaterial(hdr: THREE.Color, edgeFade = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...fogUniforms(), uTime: TIME, uColor: { value: hdr }, uFadeC: EDGE_FADE.uFadeC, uFadeR: EDGE_FADE.uFadeR },
    defines: edgeFade ? { EDGE_FADE: 1 } : {},
    fog: true,
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying float vF;
      varying vec3 vWp;
      #include <fog_pars_vertex>
      void main() {
        #ifdef USE_INSTANCING
          vec4 wp = modelMatrix * instanceMatrix * vec4( position, 1.0 );
        #else
          vec4 wp = modelMatrix * vec4( position, 1.0 );
        #endif
        float seed = wp.x * 12.9898 + wp.z * 78.233;
        vF = 0.55 + 0.45 * sin( uTime * ( 4.0 + fract( seed ) * 5.0 ) + seed ) * sin( uTime * 1.7 + seed * 0.3 );
        vWp = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform vec2 uFadeC; uniform vec2 uFadeR;
      varying float vF;
      varying vec3 vWp;
      #include <fog_pars_fragment>
      void main() {
        ${FOG_FACTOR_GLSL}
        #ifdef EDGE_FADE
          fogF = max( fogF, smoothstep( uFadeR.x, uFadeR.y, length( vWp.xz - uFadeC ) ) );
        #endif
        if ( fogF > 0.995 ) discard;
        gl_FragColor = vec4( uColor * vF * ( 1.0 - fogF ), 1.0 );
      }`,
  });
}

/** Material cache keyed by a caller-chosen string (one material per colour/variant, never per object). */
export class MaterialCache {
  private map = new Map<string, THREE.Material>();
  get<M extends THREE.Material>(key: string, make: () => M): M {
    let m = this.map.get(key);
    if (!m) { m = make(); this.map.set(key, m); }
    return m as M;
  }
  dispose(): void { for (const m of this.map.values()) m.dispose(); this.map.clear(); }
}
