/**
 * GLSL for the "Colour Sweep" style.
 *
 * Canvas state lives in two RGBA textures:
 *   uSrc0 = top layer   (rgb = colour, a = wet thickness 0..1)
 *   uSrc1 = under layer (rgb = colour, a = thickness) — paint buried by the white pour
 */

const HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vPos;
in vec2 vAttr;
`;

const STATE_IO = /* glsl */ `
uniform highp sampler2D uSrc0;
uniform highp sampler2D uSrc1;
layout(location = 0) out vec4 oTop;
layout(location = 1) out vec4 oUnder;
`;

const COMMON = /* glsl */ `
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise1(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash11(i), hash11(i + 1.0), f);
}
float vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
/** How much of the buried layer a brush of depth D reaches through the top layer. */
float revealAmount(float ht, float hu, float D) {
  float a = hu * D;
  return clamp(a / (a + ht * (1.0 - D) + 1e-4), 0.0, 1.0);
}
`;

const FETCH = /* glsl */ `
uniform vec2 uSize;
vec4 fetchTop(vec2 p) {
  ivec2 ip = clamp(ivec2(floor(p)), ivec2(0), ivec2(uSize) - 1);
  return texelFetch(uSrc0, ip, 0);
}
vec4 fetchUnder(vec2 p) {
  ivec2 ip = clamp(ivec2(floor(p)), ivec2(0), ivec2(uSize) - 1);
  return texelFetch(uSrc1, ip, 0);
}
`;

/**
 * Thickness-weighted bilinear sample. Colour is averaged only over paint that is present,
 * so moving paint over bare canvas does not pick up the canvas colour.
 */
const SAMPLE = /* glsl */ `
uniform vec2 uSize;
uniform vec3 uBg;
vec4 sampleLayer(highp sampler2D tex, vec2 p) {
  vec2 q = p - 0.5;
  ivec2 i0 = ivec2(floor(q));
  vec2 f = q - vec2(i0);
  ivec2 mx = ivec2(uSize) - 1;
  vec4 a = texelFetch(tex, clamp(i0, ivec2(0), mx), 0);
  vec4 b = texelFetch(tex, clamp(i0 + ivec2(1, 0), ivec2(0), mx), 0);
  vec4 c = texelFetch(tex, clamp(i0 + ivec2(0, 1), ivec2(0), mx), 0);
  vec4 d = texelFetch(tex, clamp(i0 + ivec2(1, 1), ivec2(0), mx), 0);
  float wa = (1.0 - f.x) * (1.0 - f.y);
  float wb = f.x * (1.0 - f.y);
  float wc = (1.0 - f.x) * f.y;
  float wd = f.x * f.y;
  float h = a.a * wa + b.a * wb + c.a * wc + d.a * wd;
  vec3 col = a.rgb * (a.a * wa) + b.rgb * (b.a * wb) + c.rgb * (c.a * wc) + d.rgb * (d.a * wd);
  return h > 1e-5 ? vec4(col / h, h) : vec4(uBg, 0.0);
}
/**
 * Sharper thickness-weighted sample for passes that move paint every tick: bilinear with
 * eased weights. Unlike plain bilinear it barely blurs colour bands over many ticks, and
 * unlike cubic filters it never overshoots (every result is a mix of existing paint).
 */
vec4 sampleSharp(highp sampler2D tex, vec2 p) {
  vec2 q = p - 0.5;
  vec2 fi = floor(q);
  vec2 f = q - fi;
  f = f * f * (3.0 - 2.0 * f);
  return sampleLayer(tex, fi + 0.5 + f);
}
float heightAt(vec2 p) {
  ivec2 ip = clamp(ivec2(floor(p)), ivec2(0), ivec2(uSize) - 1);
  return texelFetch(uSrc0, ip, 0).a + texelFetch(uSrc1, ip, 0).a;
}
`;

/** Streak pattern across the brush (u) that drifts slowly along the stroke. */
const BRISTLES = /* glsl */ `
uniform float uSeed;
uniform float uDistance;
uniform float uWidthPx;
float bristleNoise(float u) {
  float along = uDistance / max(uWidthPx, 1.0);
  float coarse = vnoise2(vec2(u * 28.0 + uSeed, along * 0.6));
  float fine = vnoise2(vec2(u * 140.0 - uSeed * 3.1, along * 2.0));
  return clamp(coarse * 0.6 + fine * 0.4, 0.0, 1.0);
}
`;

/** Organic outline: radius multiplier for an angle. */
const WOBBLE = /* glsl */ `
uniform vec4 uPhase;
uniform float uWobble;
float wobble(float ang) {
  return 1.0 + uWobble * (0.09 * sin(3.0 * ang + uPhase.x) + 0.06 * sin(5.0 * ang + uPhase.y)
       + 0.03 * sin(9.0 * ang + uPhase.z) + 0.015 * sin(14.0 * ang + uPhase.w));
}
`;

/**
 * Pour colour into the wet paint. New paint appears at the centre and pushes the existing
 * paint radially outward, preserving its area (like pouring into a puddle): earlier colours
 * become rings around the new one instead of mixing with it.
 */
export const INJECT_FS =
  HEADER +
  STATE_IO +
  SAMPLE +
  WOBBLE +
  /* glsl */ `
uniform vec2 uCenter;
uniform float uArea;     // added r² (px²)
uniform float uReach0;   // push is full up to here …
uniform float uReach1;   // … and fades out until here
uniform vec3 uColor;
uniform float uAmount;
void main() {
  vec2 d = vPos - uCenter;
  float dist = length(d);
  float s = wobble(atan(d.y, d.x));
  float q = dist / s;
  float w = 1.0 - smoothstep(uReach0, uReach1, q);
  float q2 = q * q - uArea * w;
  vec2 dir = dist > 1e-4 ? d / dist : vec2(1.0, 0.0);
  vec4 under;
  vec4 top;
  if (q2 <= 0.0) {
    under = sampleSharp(uSrc1, uCenter);
    top = vec4(uColor, uAmount);
  } else {
    vec2 src = uCenter + dir * sqrt(q2) * s;
    top = sampleSharp(uSrc0, src);
    under = sampleSharp(uSrc1, src);
    // Anti-alias the boundary of the newly poured paint.
    float core = sqrt(uArea * w);
    float aa = 1.0 - smoothstep(0.0, 1.0, q - core);
    top = mix(top, vec4(uColor, max(uAmount, top.a)), aa * step(0.5, core));
  }
  oTop = vec4(top.rgb, clamp(top.a, 0.0, 1.0));
  oUnder = vec4(under.rgb, clamp(under.a, 0.0, 1.0));
}`;

/**
 * One simulation tick of a spreading puddle: a radial stretch around the pour point.
 * Every ring inside the puddle is stretched by the same factor (so poured colours stay
 * separate) and gets thinner; beyond the puddle the stretch fades out, pushing neighbours.
 */
export const SPREAD_FS =
  HEADER +
  STATE_IO +
  SAMPLE +
  WOBBLE +
  /* glsl */ `
uniform vec2 uCenter;
uniform float uScale;   // > 1
uniform float uRadius;  // current puddle radius (px)
void main() {
  vec2 d = vPos - uCenter;
  float dist = length(d);
  float s = wobble(atan(d.y, d.x));
  float q = dist / s;
  float reach0 = uRadius * 1.1;
  float reach1 = reach0 + max(40.0, uRadius * 0.7);
  float w = 1.0 - smoothstep(reach0, reach1, q);
  float m = 1.0 + (uScale - 1.0) * w;
  vec2 dir = dist > 1e-4 ? d / dist : vec2(1.0, 0.0);
  vec2 src = uCenter + dir * (q / m) * s;
  vec4 top = sampleSharp(uSrc0, src);
  vec4 under = sampleSharp(uSrc1, src);
  // Area grows by m², so thickness shrinks by the same factor.
  float thin = 1.0 / (m * m);
  oTop = vec4(top.rgb, clamp(top.a * thin, 0.0, 1.0));
  oUnder = vec4(under.rgb, clamp(under.a * thin, 0.0, 1.0));
}`;

/** A droplet of paint flung from the brush: an elongated blob coloured by its bristle. */
export const DROPLET_FS =
  HEADER +
  STATE_IO +
  /* glsl */ `
uniform highp sampler2D uHistory;
uniform float uRow;
uniform float uCount;
uniform vec2 uCenter;
uniform vec2 uAxis;
uniform vec2 uRadii;
uniform float uU;
uniform float uAmount;
void main() {
  ivec2 ip = ivec2(floor(vPos));
  vec4 top = texelFetch(uSrc0, ip, 0);
  vec4 under = texelFetch(uSrc1, ip, 0);
  vec2 d = vPos - uCenter;
  vec2 local = vec2(dot(d, uAxis), dot(d, vec2(-uAxis.y, uAxis.x))) / uRadii;
  float e = length(local);
  float soft = 1.5 / max(min(uRadii.x, uRadii.y), 1.0);
  float cov = 1.0 - smoothstep(1.0 - soft, 1.0, e);
  vec4 B = texelFetch(uHistory, ivec2(int(clamp(uU, 0.0, 0.9999) * uCount), int(uRow)), 0);
  cov *= clamp(B.a * 8.0, 0.0, 1.0);
  float h = uAmount * sqrt(max(0.0, 1.0 - e * e));
  top.rgb = mix(top.rgb, B.rgb, cov);
  top.a = mix(top.a, clamp(max(top.a, h + top.a * 0.3), 0.0, 1.0), cov);
  oTop = top;
  oUnder = under;
}`;

/** Pour white: everything that is not already white goes under a fresh white layer. */
export const POUR_FS =
  HEADER +
  STATE_IO +
  COMMON +
  /* glsl */ `
uniform vec2 uCenter;
uniform float uRadius;
uniform float uFull;
uniform vec3 uWhite;
uniform float uThickness;
uniform float uSeed;
void main() {
  ivec2 ip = ivec2(floor(vPos));
  vec4 top = texelFetch(uSrc0, ip, 0);
  vec4 under = texelFetch(uSrc1, ip, 0);
  float cov = 1.0;
  if (uFull < 0.5) {
    vec2 d = vPos - uCenter;
    float ang = atan(d.y, d.x);
    float edgeNoise = vnoise1(ang * 2.5 + uSeed) * 0.12 + vnoise1(ang * 7.0 - uSeed) * 0.05;
    float dist = length(d) / (uRadius * (1.0 - edgeNoise));
    cov = 1.0 - smoothstep(0.82, 1.0, dist);
  }
  if (cov <= 0.0) { oTop = top; oUnder = under; return; }
  float T = uThickness * (0.8 + 0.4 * vnoise2(vPos / 220.0 + uSeed));
  float whiteness = 1.0 - smoothstep(0.03, 0.12, distance(top.rgb, uWhite));
  float moved = top.a * (1.0 - whiteness) * cov;
  float hu = under.a + moved;
  vec3 underRgb = hu > 1e-5 ? (under.rgb * under.a + top.rgb * moved) / hu : under.rgb;
  float remaining = top.a - moved;
  // Poured white is self-levelling: it is thin over buried blobs and thick in between.
  float level = max(T - hu, T * 0.3);
  float ht = mix(top.a, max(remaining, level), cov);
  oTop = vec4(mix(top.rgb, uWhite, cov), clamp(ht, 0.0, 1.0));
  oUnder = vec4(underRgb, clamp(hu, 0.0, 1.0));
}`;

/**
 * Sweep, pass 1: every bristle records what it picks up at this step into one row of the
 * brush's paint history (a ring buffer of rows).
 */
export const PICKUP_FS =
  HEADER +
  /* glsl */ `
uniform highp sampler2D uSrc0;
uniform highp sampler2D uSrc1;
uniform float uCount;
uniform vec2 uPrevPos;
uniform vec2 uCurPos;
uniform vec2 uPrevNormal;
uniform vec2 uCurNormal;
uniform float uDepth;
uniform vec3 uBg;
out vec4 oPicked;
` +
  COMMON +
  FETCH +
  /* glsl */ `
uniform float uWidthPx;
void main() {
  float u = (floor(vPos.x) + 0.5) / uCount;
  float off = (u - 0.5) * uWidthPx;
  vec2 a = uPrevPos + uPrevNormal * off;
  vec2 b = uCurPos + uCurNormal * off;
  vec3 col = vec3(0.0);
  float amount = 0.0;
  for (int k = 0; k < 3; k++) {
    vec2 p = mix(a, b, (float(k) + 0.5) / 3.0);
    vec4 t = fetchTop(p);
    vec4 un = fetchUnder(p);
    float r = revealAmount(t.a, un.a, uDepth);
    float am = t.a + r * un.a;
    col += mix(t.rgb, un.rgb, r) * am;
    amount += am;
  }
  oPicked = vec4(amount > 1e-5 ? col / amount : uBg, amount / 3.0);
}`;

/**
 * Sample and hold: each bristle keeps laying down the colour it picked up at its last
 * "reload" and reloads periodically. Neighbouring bristles reload at slightly different
 * moments, so they hold different colours: long, pure, parallel bands along the stroke.
 */
const CONVEYOR = /* glsl */ `
uniform highp sampler2D uHistory;
uniform float uCount;
uniform float uRows;
uniform float uStep;
uniform float uLagMax;
vec4 carriedAt(float idx, out float age) {
  float coarse = vnoise2(vec2(idx / uCount * 3.0 + uSeed, 3.7));
  float fine = hash11(idx * 1.37 + uSeed);
  float period = max(4.0, uLagMax * (0.4 + 0.6 * coarse));
  float offset = period * fract(coarse * 1.3) + period * fine * 0.06 * uStreak;
  float reload = floor((uStep - offset) / period) * period + offset;
  float oldest = max(uStep - uRows + 1.0, 0.0);
  reload = clamp(reload, oldest, uStep);
  age = (uStep - reload) / period;
  vec4 now = texelFetch(uHistory, ivec2(int(idx), int(mod(reload, uRows))), 0);
  // Blend from the previously held colour over the first part of the period (no hard ends).
  float prev = reload - period;
  if (prev < oldest) return now;
  vec4 before = texelFetch(uHistory, ivec2(int(idx), int(mod(prev, uRows))), 0);
  float b = smoothstep(0.0, 0.18, age);
  if (before.a < 1e-4) return now;
  if (now.a < 1e-4) return vec4(before.rgb, before.a * (1.0 - b));
  return mix(before, now, b);
}
// Neighbouring bristles reload together (broad ribbons); the streak setting adds a little
// per-bristle variation (fine lines inside the ribbons). Interpolated between bristles so
// colour boundaries are smooth instead of stair-stepped.
vec4 carried(float u, out float age) {
  float x = clamp(u, 0.0, 1.0) * uCount - 0.5;
  float i0 = clamp(floor(x), 0.0, uCount - 1.0);
  float i1 = min(i0 + 1.0, uCount - 1.0);
  float f = clamp(x - i0, 0.0, 1.0);
  float a0, a1;
  vec4 c0 = carriedAt(i0, a0);
  vec4 c1 = carriedAt(i1, a1);
  age = mix(a0, a1, f);
  float h = mix(c0.a, c1.a, f);
  vec3 col = h > 1e-5 ? (c0.rgb * c0.a * (1.0 - f) + c1.rgb * c1.a * f) / h : c0.rgb;
  return vec4(col, h);
}
`;

/**
 * Sweep, pass 2: lay down paint the bristles picked up earlier along the stroke (a conveyor,
 * not an average, so colours stay pure and rings get stretched into bands), lift buried
 * colour, and level the surface.
 */
export const DEPOSIT_FS =
  HEADER +
  STATE_IO +
  /* glsl */ `
uniform float uDepth;
uniform float uDeposit;
uniform float uStreak;
uniform float uRidge;
uniform float uMargin;
` +
  COMMON +
  BRISTLES +
  CONVEYOR +
  /* glsl */ `
void main() {
  ivec2 ip = ivec2(floor(vPos));
  vec4 top = texelFetch(uSrc0, ip, 0);
  vec4 under = texelFetch(uSrc1, ip, 0);
  float u = vAttr.x;
  float age;
  vec4 B = carried(u, age);
  // A bristle slowly runs dry until it reloads.
  B.a *= 1.0 - 0.45 * age;

  if (u < 0.0 || u > 1.0) {
    // Just outside the brush: paint pushed aside forms a soft ridge.
    float d = u < 0.0 ? -u : u - 1.0;
    float bump = 1.0 - smoothstep(0.0, uMargin, d);
    top.a = clamp(top.a + uRidge * 0.035 * bump * clamp(B.a * 4.0, 0.0, 1.0), 0.0, 1.0);
    top.rgb = mix(top.rgb, B.rgb, 0.25 * bump * uRidge * clamp(B.a * 8.0, 0.0, 1.0));
    oTop = top;
    oUnder = under;
    return;
  }

  float edge = smoothstep(0.0, 0.035, u) * (1.0 - smoothstep(0.965, 1.0, u));
  float n = bristleNoise(u);
  float D = clamp(uDepth * mix(1.0, 0.35 + 1.3 * n, uStreak * 0.7), 0.0, 1.0);
  float r = revealAmount(top.a, under.a, D);
  vec3 exposed = mix(top.rgb, under.rgb, r);
  float dep = uDeposit * edge * mix(1.0, 0.6 + 0.8 * n, uStreak * 0.5) * clamp(B.a * 10.0, 0.0, 1.0);
  dep = clamp(dep, 0.0, 1.0);
  vec3 col = mix(exposed, B.rgb, dep);

  // Buried paint that the brush reached is mixed into the top layer.
  float lift = r * edge;
  float hu = under.a * (1.0 - lift);
  float ht = top.a + under.a * lift;
  // The brush levels the whole surface towards the paint it carries, with fine grooves.
  float total = ht + hu;
  float levelled = mix(total, max(B.a, hu + 0.02), 0.85 * edge * clamp(B.a * 10.0, 0.0, 1.0));
  // A brush never scrapes existing paint completely off the canvas.
  ht = max(levelled - hu, min(top.a, 0.05));
  ht += (n - 0.5) * uStreak * 0.05 * edge;
  oTop = vec4(col, clamp(ht, 0.0, 1.0));
  oUnder = vec4(under.rgb, clamp(hu, 0.0, 1.0));
}`;

/** Final image: colour from both layers, lit by the paint relief for a glossy look. */
export const RENDER_FS =
  HEADER +
  /* glsl */ `
uniform highp sampler2D uSrc0;
uniform highp sampler2D uSrc1;
uniform vec3 uBg;
uniform float uGloss;
uniform float uRelief;
out vec4 oColor;
` +
  FETCH +
  /* glsl */ `
float heightAt(vec2 p) {
  return fetchTop(p).a + fetchUnder(p).a;
}
void main() {
  vec4 top = fetchTop(vPos);
  vec4 under = fetchUnder(vPos);
  vec3 base = uBg;
  base = mix(base, under.rgb, smoothstep(0.0, 0.02, under.a));
  base = mix(base, top.rgb, smoothstep(0.0, 0.03, top.a));

  // Sobel gradient of the paint height: smooth relief without dark 1-pixel contour lines.
  float h00 = heightAt(vPos + vec2(-1.0, -1.0));
  float h10 = heightAt(vPos + vec2(0.0, -1.0));
  float h20 = heightAt(vPos + vec2(1.0, -1.0));
  float h01 = heightAt(vPos + vec2(-1.0, 0.0));
  float h21 = heightAt(vPos + vec2(1.0, 0.0));
  float h02 = heightAt(vPos + vec2(-1.0, 1.0));
  float h12 = heightAt(vPos + vec2(0.0, 1.0));
  float h22 = heightAt(vPos + vec2(1.0, 1.0));
  vec2 g = vec2((h20 + 2.0 * h21 + h22) - (h00 + 2.0 * h01 + h02), (h02 + 2.0 * h12 + h22) - (h00 + 2.0 * h10 + h20)) / 8.0;
  g = clamp(g * uRelief, vec2(-1.2), vec2(1.2));
  vec3 n = normalize(vec3(-g, 1.0));
  vec3 L = normalize(vec3(-0.45, -0.6, 0.66));
  float diff = dot(n, L);
  float lit = clamp(1.0 + 0.6 * (diff - L.z), 0.84, 1.12);
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float wet = smoothstep(0.0, 0.04, top.a + under.a);
  float spec = pow(max(dot(n, H), 0.0), 70.0) * uGloss * wet;
  vec3 col = base * lit + vec3(spec);
  oColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
