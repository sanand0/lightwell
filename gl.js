// @ts-check
// WebGL2 stage for experimental effects. One context per page draws an effect into its canvas, and the caller
// copies that canvas with drawImage straight away, so every layer can share it.
// Coordinates: shaders work in image space q (0,0 top-left), like the 2D canvas and the uploaded `src` texture.
// Simulation textures (water height, smudge flow) are read with at(), which flips rows for framebuffer storage.
(() => {
  const lab = globalThis.Lightwell;
  const vertex = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }`;
  const head = `#version 300 es
precision highp float;
in vec2 uv; out vec4 color;
uniform vec2 size; uniform float time, amount; uniform int count; uniform vec4 touches[8];
vec2 img() { return vec2(uv.x, 1. - uv.y); }
vec4 at(sampler2D t, vec2 q) { return texture(t, vec2(q.x, 1. - q.y)); }
vec4 pick(sampler2D t, vec2 q) { return any(lessThan(q, vec2(0.))) || any(greaterThan(q, vec2(1.))) ? vec4(0.) : texture(t, q); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`;
  // Each touch: xy image position, z radius (height units), w strength. aspect makes radii round.
  const shaders = {
    // Height field wave equation: r = height now, g = height before. Touches drop ripples.
    "water-step": `uniform sampler2D state; uniform vec2 texel;
void main() {
  vec2 q = img();
  vec4 s = at(state, q);
  float sum = at(state, q + vec2(texel.x, 0.)).r + at(state, q - vec2(texel.x, 0.)).r + at(state, q + vec2(0., texel.y)).r + at(state, q - vec2(0., texel.y)).r;
  float h = (sum * .5 - s.g) * .986;
  vec2 aspect = vec2(size.x / size.y, 1.);
  for (int i = 0; i < 8; i++) {
    if (i >= count) break;
    vec2 d = (q - touches[i].xy) * aspect;
    h += touches[i].w * exp(-dot(d, d) / (touches[i].z * touches[i].z));
  }
  color = vec4(h, s.r, 0., 1.);
}`,
    // Refract the layer through the water surface and add a sun glint on the slopes.
    "water-draw": `uniform sampler2D src, state; uniform vec2 texel;
void main() {
  vec2 q = img();
  vec2 grad = vec2(at(state, q + vec2(texel.x, 0.)).r - at(state, q - vec2(texel.x, 0.)).r,
                   at(state, q + vec2(0., texel.y)).r - at(state, q - vec2(0., texel.y)).r);
  vec4 c = pick(src, q - grad * (.1 + .22 * amount));
  vec3 n = normalize(vec3(-grad * 24., 1.));
  float glint = pow(max(dot(n, normalize(vec3(-.45, -.55, 1.))), 0.), 40.) * .8;
  c.rgb = min(c.rgb + glint * c.a, vec3(c.a));
  color = c;
}`,
    // A glass sphere: magnifies toward its centre, splits colour at the rim and casts a soft shadow.
    lens: `uniform sampler2D src; uniform vec2 center; uniform float radius;
void main() {
  vec2 q = img();
  vec2 aspect = vec2(size.x / size.y, 1.);
  vec2 d = q - center;
  float r = length(d * aspect) / radius;
  if (r >= 1.) {
    vec4 c = pick(src, q);
    float shadow = (1. - smoothstep(1., 1.14, r)) * .28;
    color = vec4(c.rgb, c.a + shadow * (1. - c.a));
    return;
  }
  float z = sqrt(1. - r * r);
  float zoom = mix(1., .42 - .18 * amount, z);
  vec2 base = center + d * zoom;
  vec2 split = d * zoom * (1. - z) * .09;
  vec4 c = vec4(pick(src, base - split).r, pick(src, base).g, pick(src, base + split).b, pick(src, base).a);
  float rim = smoothstep(.84, .97, r) * (1. - smoothstep(.97, 1., r)) * .7 + pow(max(0., 1. - length(d * aspect / radius - vec2(-.35, -.4)) * 2.2), 3.) * .5;
  color = c * (1. - rim) + vec4(rim);
}`,
    // A flow field: each touch pushes paint along its motion; the field relaxes so the layer heals.
    "smudge-step": `uniform sampler2D state;
void main() {
  vec2 q = img();
  vec2 flow = at(state, q).xy;
  vec2 carried = at(state, q - flow * .5).xy;
  vec2 next = mix(flow, carried, .5) * .982;
  vec2 aspect = vec2(size.x / size.y, 1.);
  for (int i = 0; i < 8; i++) {
    if (i >= count) break;
    vec2 d = (q - touches[i].xy) * aspect;
    next += touches[i].zw * exp(-dot(d, d) / .01);
  }
  color = vec4(next, 0., 1.);
}`,
    "smudge-draw": `uniform sampler2D src, state;
void main() { vec2 q = img(); color = pick(src, q - at(state, q).xy); }`,
    // Rain on a window: a fogged view, sharp drops that refract it upside down, and drops that run down.
    rain: `uniform sampler2D src;
vec3 drop(vec2 q, float cells, float speed, float seed) {
  vec2 aspect = vec2(size.x / size.y, 1.);
  vec2 p = q * aspect * cells;
  vec2 id = floor(p);
  float h = hash(id + seed);
  if (h < .35) return vec3(0.);
  vec2 f = fract(p) - .5;
  vec2 c = vec2(hash(id + seed + 1.) - .5, hash(id + seed + 2.) - .5) * .5;
  if (speed > 0.) c.y = fract(time * speed * (.4 + h) + h * 9.) - .5;
  float r = .12 + .18 * hash(id + seed + 3.);
  vec2 d = (f - c) / r;
  float inside = 1. - smoothstep(.8, 1., length(d));
  return vec3(d * inside, inside);
}
void main() {
  vec2 q = img();
  vec2 px = 1. / size;
  vec4 fog = (pick(src, q + px * vec2(3., 2.)) + pick(src, q - px * vec2(3., 2.)) + pick(src, q + px * vec2(-2., 3.)) + pick(src, q - px * vec2(-2., 3.))) * .25;
  vec3 a = drop(q, 26., 0., 1.);
  vec3 b = drop(q, 9., .18, 7.);
  vec3 d = b.z > 0. ? b : a;
  vec4 sharp = pick(src, q - d.xy * (.012 + .02 * amount));
  vec4 c = mix(mix(pick(src, q), fog, .45 + .45 * amount), sharp, d.z);
  float shine = pow(max(0., d.z * (1. - length(d.xy - vec2(-.3, -.35)))), 4.) * .5;
  c.rgb = min(c.rgb + shine * c.a, vec3(c.a));
  color = c;
}`,
    // Underwater: the layer wavers and dancing caustic light plays over it.
    pool: `uniform sampler2D src;
void main() {
  vec2 q = img();
  vec2 sway = vec2(sin(q.y * 26. + time * 1.7), cos(q.x * 22. + time * 1.3)) * .004 * (.5 + amount);
  vec4 c = pick(src, q + sway);
  // Caustics: warped sine grids; light gathers where their product crosses zero, in thin moving lines.
  vec2 p = q * vec2(size.x / size.y, 1.) * 7.;
  vec2 i = p;
  float k = 0.;
  for (int n = 0; n < 3; n++) {
    i = p + vec2(cos(time * .7 + i.y * 1.3 + float(n)), sin(time * .8 + i.x * 1.2 - float(n)));
    k += abs(sin(i.x) * sin(i.y));
  }
  float light = pow(max(0., 1. - k / 3. * 1.6), 5.) * (.5 + .7 * amount);
  c.rgb = min(c.rgb * vec3(.9, .98, 1.03) + vec3(.7, .93, 1.) * light * c.a, vec3(c.a));
  color = c;
}`,
  };

  let gl = null;
  let canvas = null;
  let quad = null;
  let epoch = 0;
  let failure = "";
  const programs = new Map();

  function context() {
    if (gl || failure) return gl;
    canvas = document.createElement("canvas");
    gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, depth: false });
    if (!gl || !gl.getExtension("EXT_color_buffer_float")) { failure = "WebGL2 with float targets is unavailable"; gl = null; return null; }
    canvas.addEventListener("webglcontextlost", event => { event.preventDefault(); gl = null; epoch++; programs.clear(); });
    quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    return gl;
  }
  function program(name) {
    if (programs.has(name)) return programs.get(name);
    const compile = (type, text) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, text);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(name + " shader: " + gl.getShaderInfoLog(shader));
      return shader;
    };
    const handle = gl.createProgram();
    gl.attachShader(handle, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(handle, compile(gl.FRAGMENT_SHADER, head + shaders[name]));
    gl.bindAttribLocation(handle, 0, "p");
    gl.linkProgram(handle);
    if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) throw new Error(name + " link: " + gl.getProgramInfoLog(handle));
    const uniforms = {};
    for (let i = 0; i < gl.getProgramParameter(handle, gl.ACTIVE_UNIFORMS); i++) {
      const { name: key } = gl.getActiveUniform(handle, i);
      uniforms[key.replace("[0]", "")] = gl.getUniformLocation(handle, key);
    }
    const entry = { handle, uniforms };
    programs.set(name, entry);
    return entry;
  }
  function texture(w, h, float) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, float ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }
  function target(w, h) {
    const tex = texture(w, h, true);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo };
  }
  // Per-layer GPU resources live in the layer's effect bag and are rebuilt after resize or context loss.
  function resources(bag, w, h, sim) {
    const key = [w, h, sim, epoch].join();
    if (bag.gl?.key === key) return bag.gl;
    if (bag.gl?.epoch === epoch) {
      for (const item of [bag.gl.a, bag.gl.b].filter(Boolean)) { gl.deleteTexture(item.tex); gl.deleteFramebuffer(item.fbo); }
      gl.deleteTexture(bag.gl.src);
    }
    const sw = sim ? Math.max(8, Math.round(Math.min(220, w))) : 0;
    const sh = sim ? Math.max(8, Math.round(sw * h / w)) : 0;
    bag.gl = { key, epoch, src: texture(1, 1, false), sw, sh, a: sim ? target(sw, sh) : null, b: sim ? target(sw, sh) : null, seen: Date.now() };
    return bag.gl;
  }
  function pass(name, fbo, w, h, textures, values) {
    const { handle, uniforms } = program(name);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(handle);
    gl.disable(gl.BLEND);
    Object.entries(textures).forEach(([key, tex], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(uniforms[key], unit);
    });
    for (const [key, value] of Object.entries(values)) {
      const location = uniforms[key];
      if (!location) continue;
      if (key === "count") gl.uniform1i(location, value);
      else if (typeof value === "number") gl.uniform1f(location, value);
      else if (value.length === 2) gl.uniform2fv(location, value);
      else gl.uniform4fv(location, value);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  const pack = list => {
    const data = new Float32Array(32);
    list.slice(-8).forEach((touch, i) => data.set(touch, i * 4));
    return { count: Math.min(8, list.length), touches: data };
  };

  // Turns item-local touches into shader inputs for each effect. w, h: layer size in stage units.
  const inputs = {
    water(touches, w, h, res) {
      // Each touch drops once; fingers drop a small ripple every frame they move, which leaves a wake.
      const fresh = touches.filter(touch => touch.at > res.seen);
      res.seen = Math.max(res.seen, ...touches.map(touch => touch.at));
      return pack(fresh.map(touch => [touch.x / w, touch.y / h, touch.kind === "finger" ? .025 : .035,
        touch.kind === "finger" ? Math.min(.25, Math.hypot(touch.vx, touch.vy) / h * .04) : touch.kind === "tap" ? .8 : .35]));
    },
    smudge(touches, w, h, res) {
      const fresh = touches.filter(touch => touch.at > res.seen && (touch.vx || touch.vy));
      res.seen = Math.max(res.seen, ...touches.map(touch => touch.at));
      return pack(fresh.map(touch => [touch.x / w, touch.y / h, touch.vx / w * .09, touch.vy / h * .09]));
    },
  };

  /**
   * Renders effect `name` over `src` (a canvas) and returns the WebGL canvas to draw at once, or null when
   * WebGL2 is unavailable. touches are item-local ({ x, y, at, age, kind, vx, vy }).
   */
  function run(name, { src, bag, w, h, amount, now, touches }) {
    if (!context()) return null;
    const sim = name === "water" || name === "smudge";
    const res = resources(bag, src.width, src.height, sim);
    if (canvas.width !== src.width || canvas.height !== src.height) { canvas.width = src.width; canvas.height = src.height; }
    gl.bindTexture(gl.TEXTURE_2D, res.src);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    const common = { size: [src.width, src.height], time: now / 1000, amount, count: 0, touches: new Float32Array(32) };
    if (sim) {
      const texel = [1 / res.sw, 1 / res.sh];
      const values = { ...common, size: [res.sw, res.sh], texel, ...inputs[name](touches, w, h, res) };
      for (let step = 0; step < (name === "water" ? 2 : 1); step++) {
        pass(name + "-step", res.b.fbo, res.sw, res.sh, { state: res.a.tex }, step ? { ...values, count: 0 } : values);
        [res.a, res.b] = [res.b, res.a];
      }
      pass(name + "-draw", null, src.width, src.height, { src: res.src, state: res.a.tex }, { ...common, texel });
      return canvas;
    }
    if (name === "lens") {
      // Follow the newest touch for 4 s, otherwise drift slowly so the lens is always doing something.
      const last = touches.at(-1);
      const drift = [.5 + .3 * Math.sin(now / 2300), .5 + .25 * Math.sin(now / 1700)];
      const goal = last && last.age < 4000 ? [last.x / w, last.y / h] : drift;
      res.center = res.center ? res.center.map((value, i) => value + (goal[i] - value) * .25) : goal;
      pass("lens", null, src.width, src.height, { src: res.src }, { ...common, center: res.center, radius: .2 + .14 * amount });
      return canvas;
    }
    pass(name, null, src.width, src.height, { src: res.src }, common);
    return canvas;
  }

  lab.gl = { run, get failure() { return failure; } };
})();
