import * as THREE from 'three';

/**
 * Desktop colour grade (one extra full-screen pass): the frame renders into an
 * HDR target, then a quad tone-maps it and grades it — cold, slightly
 * desaturated shadows, reds and warm flashes kept saturated, a touch more
 * contrast and a vignette. `mood` 0..1 scales it (darker, redder when the
 * power is out).
 */
export class ScreenGrade {
  readonly target: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  mood = 0;

  constructor(private renderer: THREE.WebGLRenderer) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.target.texture },
        mood: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float mood;
        varying vec2 vUv;
        void main() {
          gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0);
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
          // Contrast round mid-grey.
          c = (c - 0.42) * mix(1.05, 1.12, mood) + 0.42;
          // Vignette (on top of the CSS one, stronger in the dark).
          vec2 d = vUv - 0.5;
          c *= 1.0 - mix(0.12, 0.32, mood) * smoothstep(0.2, 0.75, length(d * vec2(1.0, 0.85)) * 1.25);
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
  }

  /** Point rendering at the HDR target (call before drawing the frame). */
  begin(): void {
    this.renderer.setRenderTarget(this.target);
  }

  /** Grade the target onto the screen. */
  end(): void {
    this.renderer.setRenderTarget(null);
    this.mat.uniforms.mood.value = this.mood;
    this.renderer.render(this.scene, this.camera);
  }
}
