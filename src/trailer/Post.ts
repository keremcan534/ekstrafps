import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * Trailer-only post chain: HDR scene (+ optional viewmodel layer) → bloom →
 * depth of field → ACES tone map / sRGB → grade (cold industrial shadows, warm
 * and red accents kept saturated) → chromatic fringe, vignette, grain.
 * The game itself never uses this; it only runs under ?trailer.
 */
export interface PostSettings {
  exposure: number;
  bloom: { strength: number; radius: number; threshold: number };
  /** Focus distance (m); aperture = blur per metre off focus (uv); null = everything sharp. */
  dof: { focus: number; aperture: number; maxblur: number } | null;
  contrast: number;
  saturation: number;
  /** 0..1: how much reds/oranges keep their saturation when the rest is desaturated. */
  warmKeep: number;
  /** Multiplied into shadows (cold), and into highlights. */
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  lift: number;
  vignette: number;
  grain: number;
  fringe: number;
  /** 0..1 fade to black (cuts to black, flash frames use the scene itself). */
  black: number;
}

export const DEFAULT_POST: PostSettings = {
  exposure: 1.0,
  bloom: { strength: 0.55, radius: 0.55, threshold: 0.92 },
  dof: null,
  contrast: 1.1,
  saturation: 0.78,
  warmKeep: 0.85,
  shadowTint: [0.86, 0.97, 1.08],
  highlightTint: [1.03, 1.0, 0.96],
  lift: 0.004,
  vignette: 0.38,
  grain: 0.045,
  fringe: 0.0022,
  black: 0,
};

/** Renders several scene/camera layers into the composer's read buffer (world, then viewmodel on top). */
class LayersPass extends Pass {
  layers: { scene: THREE.Scene; camera: THREE.Camera }[] = [];

  constructor() {
    super();
    this.needsSwap = false;
  }

  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
    renderer.setRenderTarget(this.renderToScreen ? null : read);
    renderer.clear();
    this.layers.forEach((l, i) => {
      if (i) renderer.clearDepth();
      renderer.render(l.scene, l.camera);
    });
  }
}

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    time: { value: 0 },
    res: { value: new THREE.Vector2(1920, 1080) },
    contrast: { value: 1 },
    saturation: { value: 1 },
    warmKeep: { value: 0 },
    shadowTint: { value: new THREE.Vector3(1, 1, 1) },
    highlightTint: { value: new THREE.Vector3(1, 1, 1) },
    lift: { value: 0 },
    vignette: { value: 0 },
    grain: { value: 0 },
    fringe: { value: 0 },
    black: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time, contrast, saturation, warmKeep, lift, vignette, grain, fringe, black;
    uniform vec2 res;
    uniform vec3 shadowTint, highlightTint;
    varying vec2 vUv;
    float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      vec3 c;
      c.r = texture2D(tDiffuse, vUv - d * fringe * r2 * 4.0).r;
      c.g = texture2D(tDiffuse, vUv).g;
      c.b = texture2D(tDiffuse, vUv + d * fringe * r2 * 4.0).b;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // Split tone: cold shadows, slightly warm highlights.
      float sh = 1.0 - smoothstep(0.0, 0.45, l);
      float hi = smoothstep(0.55, 1.0, l);
      c *= mix(vec3(1.0), shadowTint, sh) * mix(vec3(1.0), highlightTint, hi);
      // Selective saturation: reds / oranges / warm flashes keep their colour.
      float warm = clamp((c.r - max(c.g * 0.85, c.b)) * 4.0, 0.0, 1.0);
      l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, mix(saturation, 1.0, warm * warmKeep));
      // Contrast around display mid-grey, deep blacks with a hair of lift.
      c = (c - 0.42) * contrast + 0.42;
      c = max(c, 0.0) * (1.0 - lift) + lift;
      // Vignette.
      c *= 1.0 - vignette * smoothstep(0.18, 0.75, length(d * vec2(1.0, 0.85)) * 1.25);
      // Grain: stronger in mids, animated.
      float n = hash(vUv * res + fract(time * 13.37) * 113.0) - 0.5;
      c += n * grain * (0.35 + 0.65 * (1.0 - abs(l - 0.45) * 1.6));
      c *= 1.0 - black;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

export class Post {
  readonly composer: EffectComposer;
  readonly layers = new LayersPass();
  readonly bloom: UnrealBloomPass;
  readonly bokeh: BokehPass;
  readonly grade: ShaderPass;
  settings: PostSettings = structuredClone(DEFAULT_POST);
  private frame = 0;

  constructor(private renderer: THREE.WebGLRenderer, w: number, h: number, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.setPixelRatio(1);
    this.composer.setSize(w, h);
    this.composer.addPass(this.layers);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.5, 0.5, 0.9);
    this.composer.addPass(this.bloom);
    this.bokeh = new BokehPass(scene, camera, { focus: 1, aperture: 0, maxblur: 0.01 });
    this.composer.addPass(this.bokeh);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.res.value.set(w, h);
    this.composer.addPass(this.grade);
  }

  set(partial: Partial<PostSettings>): void {
    this.settings = { ...structuredClone(DEFAULT_POST), ...partial };
  }

  render(layers: { scene: THREE.Scene; camera: THREE.Camera }[]): void {
    const s = this.settings;
    this.renderer.toneMappingExposure = s.exposure;
    this.layers.layers = layers;
    this.bloom.strength = s.bloom.strength;
    this.bloom.radius = s.bloom.radius;
    this.bloom.threshold = s.bloom.threshold;
    this.bokeh.enabled = !!s.dof;
    if (s.dof) {
      const u = this.bokeh.uniforms as Record<string, THREE.IUniform>;
      u.focus.value = s.dof.focus;
      u.aperture.value = s.dof.aperture;
      u.maxblur.value = s.dof.maxblur;
    }
    const g = this.grade.uniforms;
    g.time.value = this.frame++ / 60;
    g.contrast.value = s.contrast;
    g.saturation.value = s.saturation;
    g.warmKeep.value = s.warmKeep;
    g.shadowTint.value.set(...s.shadowTint);
    g.highlightTint.value.set(...s.highlightTint);
    g.lift.value = s.lift;
    g.vignette.value = s.vignette;
    g.grain.value = s.grain;
    g.fringe.value = s.fringe;
    g.black.value = s.black;
    this.composer.render();
  }
}
