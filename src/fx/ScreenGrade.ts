import * as THREE from 'three';

/**
 * Colour grade (one extra full-screen pass): the frame renders into an HDR target, then
 * a quad tone-maps it and grades it — a light sharpen (desktop), cold, slightly
 * desaturated shadows, reds and warm flashes kept saturated, a filmic toe (blacks lifted
 * a hair, so dark rooms read as murk rather than void), a touch more contrast, a vignette
 * and film grain (in the shader: free here, unlike a blended CSS overlay). `mood` 0..1
 * scales it (darker, redder when the power is out).
 */
export class ScreenGrade {
  readonly target: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  mood = 0;

  /** @param samples MSAA on the HDR target (phones: 0, multisampled half-float targets are expensive there). */
  constructor(private renderer: THREE.WebGLRenderer, samples = 4, sharpen = samples > 0) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples });
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.target.texture },
        mood: { value: 0 },
        texel: { value: new THREE.Vector2(1 / size.x, 1 / size.y) },
        time: { value: 0 },
      },
      defines: sharpen ? { SHARPEN: 1 } : {},
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float mood;
        uniform vec2 texel;
        uniform float time;
        varying vec2 vUv;
        void main() {
          vec3 src = texture2D(tDiffuse, vUv).rgb;
          #ifdef SHARPEN
            // Unsharp mask on the four neighbours (crisp edges, no halo at this strength).
            vec3 nb = texture2D(tDiffuse, vUv + vec2(texel.x, 0.0)).rgb + texture2D(tDiffuse, vUv - vec2(texel.x, 0.0)).rgb
                    + texture2D(tDiffuse, vUv + vec2(0.0, texel.y)).rgb + texture2D(tDiffuse, vUv - vec2(0.0, texel.y)).rgb;
            src = max(src + (src - nb * 0.25) * 0.45, 0.0);
          #endif
          gl_FragColor = vec4(src, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          vec3 c = gl_FragColor.rgb;
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          // Split tone: cold shadows, a hair warm in the highlights.
          float sh = 1.0 - smoothstep(0.0, 0.45, l);
          float hi = smoothstep(0.55, 1.0, l);
          vec3 shadowTint = mix(vec3(1.0), vec3(0.88, 0.97, 1.07), 0.6 + 0.4 * mood);
          c *= mix(vec3(1.0), shadowTint, sh) * mix(vec3(1.0), vec3(1.03, 1.0, 0.97), hi);
          // Selective saturation: reds / oranges keep their colour, the rest goes greyer.
          float warm = clamp((c.r - max(c.g * 0.85, c.b)) * 4.0, 0.0, 1.0);
          l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          float sat = mix(0.9, 0.74, mood);
          c = mix(vec3(l), c, mix(sat, 1.08, warm));
          // Filmic toe: the darkest values lifted a hair and tinted cold (murk, not void).
          c = c + vec3(0.010, 0.013, 0.018) * (1.0 - smoothstep(0.0, 0.12, l));
          // Contrast round mid-grey.
          c = (c - 0.42) * mix(1.05, 1.12, mood) + 0.42;
          // Vignette (on top of the CSS one, stronger in the dark).
          vec2 d = vUv - 0.5;
          c *= 1.0 - mix(0.12, 0.32, mood) * smoothstep(0.2, 0.75, length(d * vec2(1.0, 0.85)) * 1.25);
          // Film grain: strongest in the mid-darks, gone in the highlights.
          vec2 gp = floor(vUv / texel) + fract(time * vec2(37.0, 17.0)) * 113.0;
          float grain = fract(sin(dot(gp, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
          float gl = dot(c, vec3(0.2126, 0.7152, 0.0722));
          c += grain * (0.045 + 0.02 * mood) * (1.0 - smoothstep(0.25, 0.85, gl));
          gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  resize(): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target.setSize(size.x, size.y);
    this.mat.uniforms.texel.value.set(1 / size.x, 1 / size.y);
  }

  /** Point rendering at the HDR target (call before drawing the frame). */
  begin(): void {
    this.renderer.setRenderTarget(this.target);
  }

  /** Grade the target onto the screen. */
  end(): void {
    this.renderer.setRenderTarget(null);
    this.mat.uniforms.mood.value = this.mood;
    // Grain moves 24 times a second (film), not every frame.
    this.mat.uniforms.time.value = Math.floor(performance.now() / 41.7) * 0.0137;
    this.renderer.render(this.scene, this.camera);
  }
}
