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

/**
 * Organic outline: radius multiplier for an angle. Surface tension keeps liquid acrylic
 * nearly round, so only gentle low-frequency deviations.
 */
const WOBBLE = /* glsl */ `
uniform vec4 uPhase;
uniform float uWobble;
float wobble(float ang) {
  return 1.0 + uWobble * (0.035 * sin(2.0 * ang + uPhase.x) + 0.025 * sin(3.0 * ang + uPhase.y)
       + 0.008 * sin(5.0 * ang + uPhase.z));
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
  cov *= clamp(B.a * 60.0, 0.0, 1.0);
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
 * Mixing wet paint by volume, weighted by tinting strength: a little saturated colour
 * stains a lot of white, as with real pigments.
 */
const PAINT_MIX = /* glsl */ `
float tint(vec3 c) {
  return 1.0 + 5.0 * (max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)));
}
vec3 mixPaint(vec3 a, float va, vec3 b, float vb) {
  float wa = max(va, 0.0) * tint(a);
  float wb = max(vb, 0.0) * tint(b);
  return wa + wb > 1e-7 ? (a * wa + b * wb) / (wa + wb) : a;
}
`;

/**
 * The brush model shared by the sweep passes. The brush carries paint in two places, per
 * bristle (colour + volume; volume in thickness·px per px of brush width, divided by the brush
 * width):
 * - the bead of liquid paint in front of it, which mixes and flows along the brush;
 * - the grooves between the bristles: paint drawn into a groove comes out behind the brush in
 *   the same order, unmixed, after a delay that differs from bristle to bristle. Neighbouring
 *   lines of the stroke therefore show colours from different points along the path: pure,
 *   fine streaks that stretch what the brush crossed.
 * At each step the brush scrapes most of the paint under it off the canvas: a little slips
 * straight under it, the rest is shared between grooves and bead. Behind the brush both leave a
 * film; the bead's is thicker the larger the bead is, and a bead larger than the brush can push
 * spills under it.
 */
const BRUSH = /* glsl */ `
uniform float uDepth;
uniform float uStreak;
uniform float uScrape;     // share of the paint under the brush that it moves
uniform float uPass;       // share of the scraped paint that slips under the brush at once
uniform float uGroove;     // share of the scraped paint that goes into the grooves
uniform float uFilm;       // film thickness a well-loaded bead leaves behind
uniform float uHalf;       // bead volume at which that film is half as thick
uniform float uCapacity;   // bead volume the brush can push
float brushEdge(float u) {
  return smoothstep(0.0, 0.035, u) * (1.0 - smoothstep(0.965, 1.0, u));
}
/** Paint the brush moves at one spot (rgb, amount); how deep into the buried layer it reaches. */
vec4 contact(vec4 top, vec4 under, float n, float edge, out float reach, out float scrape) {
  float D = clamp(uDepth * mix(1.0, 0.35 + 1.3 * n, uStreak * 0.7), 0.0, 1.0);
  reach = revealAmount(top.a, under.a, D);
  scrape = uScrape * edge * mix(1.0, 0.7 + 0.6 * n, uStreak * 0.5);
  return vec4(mix(top.rgb, under.rgb, reach), scrape * (top.a + reach * under.a));
}
float beadFilm(float bead, float n) {
  float f = min(1.0, uFilm * bead / (bead + uHalf) + 8.0 * max(bead - uCapacity, 0.0));
  // A bead running low only leaves paint with the fuller bristles (dry-brush streaks).
  float wet = 1.0 - clamp(f / 0.03, 0.0, 1.0);
  return f * smoothstep(wet - 0.15, wet + 0.1, n);
}
`;

/**
 * Sweep, pass 1: update the paint on the brush. One row per step of a ring buffer:
 * attachment 0 = the bead after this step, 1 = the paint drawn into the grooves at this step
 * (rgb, thickness). The bead flows sideways like a liquid: from
 * where it is high to where it is low, faster the more paint there is, so a big blob spreads
 * along the brush over some distance while a thin film hardly moves. Then the brush takes up
 * the paint scraped off the canvas and pays out the film.
 */
export const PICKUP_FS =
  HEADER +
  /* glsl */ `
uniform highp sampler2D uSrc0;
uniform highp sampler2D uPaint0;
uniform highp sampler2D uPaint1;
uniform vec2 uSize;
uniform vec3 uBg;
uniform float uCount;
uniform float uPrevRow;
uniform float uFresh;
uniform float uFlow;      // sideways exchange per step between neighbours of a full bead
uniform float uMobile;    // bead volume from which it flows freely
uniform float uStepFrac;  // step length / brush width
uniform vec2 uPrevPos;
uniform vec2 uCurPos;
uniform vec2 uPrevNormal;
uniform vec2 uCurNormal;
layout(location = 0) out vec4 oBead;
layout(location = 1) out vec4 oGroove;
` +
  COMMON +
  BRISTLES +
  PAINT_MIX +
  BRUSH +
  /* glsl */ `
vec4 paintAt(highp sampler2D tex, vec2 p) {
  return texelFetch(tex, clamp(ivec2(floor(p)), ivec2(0), ivec2(uSize) - 1), 0);
}
vec4 bead(int i) {
  return texelFetch(uSrc0, ivec2(i, int(uPrevRow)), 0);
}
void main() {
  int idx = int(floor(vPos.x));
  int count = int(uCount);
  if (uFresh > 0.5) {
    oBead = oGroove = vec4(uBg, 0.0);
    return;
  }

  // Pairwise exchange (antisymmetric, so no paint is created or lost; none leaves the brush).
  vec4 own = bead(idx);
  float gain = 0.0, loss = 0.0;
  vec3 inCol = vec3(0.0);
  for (int k = -8; k <= 8; k++) {
    int j = idx + k;
    if (k == 0 || j < 0 || j >= count) continue;
    vec4 nb = bead(j);
    float mobility = clamp(0.5 * (own.a + nb.a) / uMobile, 0.0, 1.0);
    float f = uFlow * mobility * (nb.a - own.a);
    if (f > 0.0) {
      gain += f;
      inCol += nb.rgb * f;
    } else {
      loss -= f;
    }
  }
  float v = own.a + gain - loss;
  vec3 col = gain > 1e-7 ? mixPaint(own.rgb, own.a - loss, inCol / gain, gain) : own.rgb;

  float u = (float(idx) + 0.5) / uCount;
  float n = bristleNoise(u);
  float edge = brushEdge(u);
  float off = (u - 0.5) * uWidthPx;
  vec2 a = uPrevPos + uPrevNormal * off;
  vec2 b = uCurPos + uCurNormal * off;
  vec3 sc = vec3(0.0);
  float sa = 0.0;
  for (int k = 0; k < 3; k++) {
    vec2 p = mix(a, b, (float(k) + 0.5) / 3.0);
    float reach, scrape;
    vec4 c = contact(paintAt(uPaint0, p), paintAt(uPaint1, p), n, edge, reach, scrape);
    sc += c.rgb * c.a;
    sa += c.a;
  }
  sa /= 3.0;
  vec3 scraped = sa > 1e-6 ? sc / (3.0 * sa) : col;
  float kept = max(v - beadFilm(v, n) * edge * uStepFrac, 0.0);
  float taken = (1.0 - uPass - uGroove) * sa * uStepFrac;
  oBead = vec4(mixPaint(col, kept, scraped, taken), kept + taken);
  oGroove = vec4(scraped, uGroove * sa);
}`;

/** The paint on the brush at position u, interpolated between bristles. */
const BEAD = /* glsl */ `
uniform highp sampler2D uHistory;
uniform highp sampler2D uGrooves;
uniform float uCount;
uniform float uRow;
vec4 brushRow(highp sampler2D tex, float u, float row) {
  float x = clamp(u, 0.0, 1.0) * uCount - 0.5;
  float i0 = clamp(floor(x), 0.0, uCount - 1.0);
  float i1 = min(i0 + 1.0, uCount - 1.0);
  float f = clamp(x - i0, 0.0, 1.0);
  vec4 c0 = texelFetch(tex, ivec2(int(i0), int(row)), 0);
  vec4 c1 = texelFetch(tex, ivec2(int(i1), int(row)), 0);
  return vec4(mixPaint(c0.rgb, c0.a * (1.0 - f), c1.rgb, c1.a * f), mix(c0.a, c1.a, f));
}
vec4 brushAt(highp sampler2D tex, float u) {
  return brushRow(tex, u, uRow);
}
`;

/**
 * Groove paint due behind the brush at u. A line of bristles releases what it drew in evenly
 * over its delay, so its paint is stretched over that distance without being mixed with the
 * neighbouring lines. Delays vary in broad ribbons across the brush plus a little per line
 * (the streak setting).
 */
const GROOVES = /* glsl */ `
uniform float uStep;
uniform float uRows;
uniform float uLagMax;
const int GROOVE_TAPS = 8;
vec4 grooveDue(float u) {
  float line = floor(u * uWidthPx / 3.0);
  float coarse = 0.65 * vnoise2(vec2(u * 6.0 + uSeed, 1.3)) + 0.35 * vnoise2(vec2(u * 40.0 - uSeed, 2.9));
  float fine = hash11(line * 1.37 + uSeed);
  float d = mix(coarse, fine, 0.5 * uStreak);
  float lag = max(1.0, uLagMax * (0.15 + 0.85 * d * d));
  vec3 col = vec3(0.0);
  float amount = 0.0, weight = 0.0;
  for (int k = 0; k < GROOVE_TAPS; k++) {
    float drawn = floor(uStep - lag * (float(k) + 0.5) / float(GROOVE_TAPS));
    if (drawn < 0.0) continue;
    vec4 g = brushRow(uGrooves, u, mod(drawn, uRows));
    float w = g.a * tint(g.rgb);
    col += g.rgb * w;
    weight += w;
    amount += g.a;
  }
  return vec4(weight > 1e-7 ? col / weight : vec3(0.0), amount / float(GROOVE_TAPS));
}
`;

/**
 * Sweep, pass 2: the canvas side of pass 1. The brush scrapes the paint off (leaving a thin
 * mark of what was there and lifting buried colour it reaches), lets part of it slip
 * underneath, and lays the film from grooves and bead on top, with fine ridges.
 */
export const DEPOSIT_FS =
  HEADER +
  STATE_IO +
  /* glsl */ `
uniform float uRidge;
uniform float uMargin;
` +
  COMMON +
  BRISTLES +
  PAINT_MIX +
  BRUSH +
  BEAD +
  GROOVES +
  /* glsl */ `
void main() {
  ivec2 ip = ivec2(floor(vPos));
  vec4 top = texelFetch(uSrc0, ip, 0);
  vec4 under = texelFetch(uSrc1, ip, 0);
  float u = vAttr.x;
  vec4 B = brushAt(uHistory, u);

  if (u < 0.0 || u > 1.0) {
    // Just outside the brush: paint pushed aside forms a soft ridge.
    float d = u < 0.0 ? -u : u - 1.0;
    float bump = (1.0 - smoothstep(0.0, uMargin, d)) * uRidge * clamp(B.a / uHalf * 3.0, 0.0, 1.0);
    top.rgb = mixPaint(top.rgb, top.a, B.rgb, 0.03 * bump);
    top.a = clamp(top.a + 0.035 * bump, 0.0, 1.0);
    oTop = top;
    oUnder = under;
    return;
  }

  float n = bristleNoise(u);
  float edge = brushEdge(u);
  float reach, scrape;
  vec4 c = contact(top, under, n, edge, reach, scrape);
  float rest = top.a * (1.0 - scrape);
  float through = uPass * c.a;
  vec4 G = grooveDue(u);
  float fb = beadFilm(B.a, n) * edge;
  float fg = G.a * edge;
  vec3 col = mixPaint(top.rgb, rest, c.rgb, through);
  col = mixPaint(col, rest + through, B.rgb, fb);
  col = mixPaint(col, rest + through + fb, G.rgb, fg);
  float ht = rest + through + fb + fg + (n - 0.5) * uStreak * 0.04 * edge;
  float hu = under.a * (1.0 - reach * scrape);
  oTop = vec4(col, clamp(ht, 0.0, 1.0));
  oUnder = vec4(under.rgb, clamp(hu, 0.0, 1.0));
}`;

/** Lifting the brush leaves part of its bead behind as a low mound just ahead of it. */
export const RELEASE_FS =
  HEADER +
  STATE_IO +
  /* glsl */ `
uniform float uWidthPx;
uniform float uMaxLength;
` +
  COMMON +
  PAINT_MIX +
  BEAD +
  /* glsl */ `
void main() {
  ivec2 ip = ivec2(floor(vPos));
  vec4 top = texelFetch(uSrc0, ip, 0);
  vec4 under = texelFetch(uSrc1, ip, 0);
  vec4 B = brushAt(uHistory, vAttr.x);
  float area = 0.2 * B.a * uWidthPx;  // thickness·px per px of brush width
  float len = clamp(area / 0.2, 0.3 * uMaxLength, uMaxLength) * (0.7 + 0.6 * vnoise1(vAttr.x * 12.0));
  float t = vAttr.y / len;
  float h = t >= 0.0 && t < 1.0 ? 1.5 * (area / len) * (1.0 - (2.0 * t - 1.0) * (2.0 * t - 1.0)) : 0.0;
  h *= smoothstep(0.0, 0.02, vAttr.x) * (1.0 - smoothstep(0.98, 1.0, vAttr.x));
  top.rgb = mixPaint(top.rgb, top.a, B.rgb, h);
  oTop = vec4(top.rgb, clamp(top.a + h, 0.0, 1.0));
  oUnder = under;
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
