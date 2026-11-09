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

/** Splodge: drop an organic blob of colour on top. */
export const SPLODGE_FS =
  HEADER +
  STATE_IO +
  COMMON +
  /* glsl */ `
uniform vec2 uCenter;
uniform float uRadius;
uniform vec3 uColor;
uniform float uAmount;
uniform vec4 uPhase;
uniform float uWobble;
void main() {
  ivec2 ip = ivec2(floor(vPos));
  vec4 top = texelFetch(uSrc0, ip, 0);
  vec4 under = texelFetch(uSrc1, ip, 0);
  vec2 d = vPos - uCenter;
  float ang = atan(d.y, d.x);
  float wob = 0.10 * sin(3.0 * ang + uPhase.x) + 0.07 * sin(5.0 * ang + uPhase.y)
            + 0.035 * sin(9.0 * ang + uPhase.z) + 0.02 * sin(14.0 * ang + uPhase.w);
  float R = uRadius * (1.0 + uWobble * wob);
  float dist = length(d) / R;
  float cov = 1.0 - smoothstep(1.0 - 1.5 / max(R, 2.0), 1.0, dist);
  float dome = sqrt(max(0.0, 1.0 - dist * dist));
  float h = uAmount * (0.45 + 0.55 * dome);
  top.rgb = mix(top.rgb, uColor, cov);
  top.a = mix(top.a, clamp(max(top.a, h + top.a * 0.25), 0.0, 1.0), cov);
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
  float level = max(T - hu, T * 0.1);
  float ht = mix(top.a, max(remaining, level), cov);
  oTop = vec4(mix(top.rgb, uWhite, cov), clamp(ht, 0.0, 1.0));
  oUnder = vec4(underRgb, clamp(hu, 0.0, 1.0));
}`;

/** Sweep, pass 1: every bristle picks up paint from the area it is about to cross. */
export const PICKUP_FS =
  HEADER +
  /* glsl */ `
uniform highp sampler2D uSrc0;
uniform highp sampler2D uSrc1;
uniform highp sampler2D uBristle;
uniform float uCount;
uniform vec2 uPrevPos;
uniform vec2 uCurPos;
uniform vec2 uPrevNormal;
uniform vec2 uCurNormal;
uniform float uDepth;
uniform float uPickup;
uniform float uPickupFast;
uniform float uStreak;
uniform float uFirst;
uniform vec3 uBg;
out vec4 oBristle;
` +
  COMMON +
  FETCH +
  BRISTLES +
  /* glsl */ `
void main() {
  int i = int(floor(vPos.x));
  float u = (float(i) + 0.5) / uCount;
  vec4 B = texelFetch(uBristle, ivec2(i, 0), 0);
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
  float avail = amount / 3.0;
  vec3 E = amount > 1e-5 ? col / amount : uBg;
  float n = bristleNoise(u);
  if (uFirst > 0.5) {
    oBristle = vec4(E, avail);
    return;
  }
  // Vivid paint sticks to the brush quickly; white only dilutes it slowly. This keeps
  // colour trails long and saturated, as when the real brush pushes a mass of paint.
  float chroma = max(E.r, max(E.g, E.b)) - min(E.r, min(E.g, E.b));
  float rate = mix(uPickup, uPickupFast, smoothstep(0.06, 0.3, chroma));
  float p = rate * mix(1.0, 0.2 + 1.6 * n, uStreak);
  p = clamp(p, 0.0, 1.0) * clamp(avail * 12.0, 0.0, 1.0);
  oBristle = vec4(mix(B.rgb, E, p), mix(B.a, avail, clamp(uPickup, 0.0, 1.0)));
}`;

/** Sweep, pass 2: lay the bristle paint down, lift buried colour, level the surface. */
export const DEPOSIT_FS =
  HEADER +
  STATE_IO +
  /* glsl */ `
uniform highp sampler2D uBristle;
uniform float uDepth;
uniform float uDeposit;
uniform float uStreak;
uniform float uRidge;
uniform float uMargin;
` +
  COMMON +
  BRISTLES +
  /* glsl */ `
void main() {
  ivec2 ip = ivec2(floor(vPos));
  vec4 top = texelFetch(uSrc0, ip, 0);
  vec4 under = texelFetch(uSrc1, ip, 0);
  float u = vAttr.x;
  vec4 B = texture(uBristle, vec2(clamp(u, 0.0, 1.0), 0.5));

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
  float dep = uDeposit * edge * mix(1.0, 0.45 + 1.1 * n, uStreak * 0.6) * clamp(B.a * 10.0, 0.0, 1.0);
  dep = clamp(dep, 0.0, 1.0);
  vec3 col = mix(exposed, B.rgb, dep);

  // Buried paint that the brush reached is mixed into the top layer.
  float lift = r * edge;
  float hu = under.a * (1.0 - lift);
  float ht = top.a + under.a * lift;
  // The brush levels the whole surface (both layers) towards the paint it carries,
  // so buried blob edges do not survive as relief. Fine bristle grooves are added on top.
  float total = ht + hu;
  float levelled = mix(total, max(B.a, hu + 0.02), 0.85 * edge);
  ht = max(levelled - hu, 0.0);
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
  base = mix(base, top.rgb, smoothstep(0.0, 0.05, top.a));

  float hl = heightAt(vPos - vec2(1.0, 0.0));
  float hr = heightAt(vPos + vec2(1.0, 0.0));
  float hu = heightAt(vPos - vec2(0.0, 1.0));
  float hd = heightAt(vPos + vec2(0.0, 1.0));
  vec3 n = normalize(vec3((hl - hr) * uRelief, (hu - hd) * uRelief, 1.0));
  vec3 L = normalize(vec3(-0.45, -0.6, 0.66));
  float diff = dot(n, L);
  float lit = 1.0 + 0.7 * (diff - L.z);
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float wet = smoothstep(0.0, 0.04, top.a + under.a);
  float spec = pow(max(dot(n, H), 0.0), 70.0) * uGloss * wet;
  vec3 col = base * lit + vec3(spec);
  oColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
