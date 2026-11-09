import type { GpuCaps, GpuToolkit, Rect, TextureFormat, UniformValue } from '../plugin-api/types';
import { boundsOf, clipToBounds, fullRect, isEmpty } from '../util/rect';
import { Program } from './Program';
import { RenderTarget, type TargetOptions } from './RenderTarget';

/** Vertex shader shared by every plugin program. */
const VERTEX_SHADER = /* glsl */ `#version 300 es
layout(location = 0) in vec4 aVertex;
uniform vec2 uViewOrigin;
uniform vec2 uViewSize;
out vec2 vPos;
out vec2 vAttr;
void main() {
  vPos = aVertex.xy;
  vAttr = aVertex.zw;
  vec2 clip = (aVertex.xy - uViewOrigin) / uViewSize * 2.0 - 1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

function copyShader(attachments: number): string {
  let decl = '';
  let body = '';
  for (let i = 0; i < attachments; i++) {
    decl += `uniform highp sampler2D uScratch${i};\nlayout(location = ${i}) out vec4 o${i};\n`;
    body += `  o${i} = texelFetch(uScratch${i}, p, 0);\n`;
  }
  return `#version 300 es
precision highp float;
in vec2 vPos;
uniform vec2 uScratchOrigin;
${decl}
void main() {
  ivec2 p = ivec2(floor(vPos - uScratchOrigin));
${body}}`;
}

/** Side length of the scratch buffer used for in-place updates. */
const SCRATCH_SIZE = 512;

function detectStateFormat(gl: WebGL2RenderingContext): TextureFormat {
  const hasExt = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
  if (!hasExt) return 'rgba8';
  try {
    new RenderTarget(gl, 4, 4, { attachments: 2, format: 'rgba16f' }).dispose();
    return 'rgba16f';
  } catch {
    return 'rgba8';
  }
}

export class WebGLToolkit implements GpuToolkit {
  readonly caps: GpuCaps;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly scratch = new Map<string, RenderTarget>();
  private readonly copyPrograms = new Map<number, Program>();
  private readonly programs = new Set<Program>();

  constructor(readonly gl: WebGL2RenderingContext) {
    this.caps = {
      stateFormat: detectStateFormat(gl),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    };
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error('Failed to create vertex buffers');
    this.vao = vao;
    this.vbo = vbo;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, 64 * 16, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.DITHER);
  }

  createProgram(fragmentSource: string): Program {
    const p = new Program(this.gl, VERTEX_SHADER, fragmentSource);
    this.programs.add(p);
    return p;
  }

  createTarget(width: number, height: number, options: TargetOptions): RenderTarget {
    return new RenderTarget(this.gl, width, height, options);
  }

  clear(target: RenderTarget, values: readonly (readonly [number, number, number, number])[]): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.disable(gl.SCISSOR_TEST);
    values.forEach((v, i) => gl.clearBufferfv(gl.COLOR, i, [...v]));
  }

  private upload(vertices: Float32Array): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STREAM_DRAW);
  }

  private setView(program: Program, x: number, y: number, w: number, h: number): void {
    program.setUniforms({ uViewOrigin: [x, y], uViewSize: [w, h] });
  }

  private scratchFor(target: RenderTarget): RenderTarget {
    const key = `${target.format}:${target.textures.length}`;
    let s = this.scratch.get(key);
    if (!s) {
      s = new RenderTarget(this.gl, SCRATCH_SIZE, SCRATCH_SIZE, {
        attachments: target.textures.length,
        format: target.format,
      });
      this.scratch.set(key, s);
    }
    return s;
  }

  private copyProgram(attachments: number): Program {
    let p = this.copyPrograms.get(attachments);
    if (!p) {
      p = new Program(this.gl, VERTEX_SHADER, copyShader(attachments));
      this.copyPrograms.set(attachments, p);
    }
    return p;
  }

  updateInPlace(target: RenderTarget, program: Program, vertices: Float32Array): void {
    const gl = this.gl;
    const area = clipToBounds(boundsOf(vertices, 4), target.width, target.height);
    if (isEmpty(area)) return;
    const scratch = this.scratchFor(target);
    const copy = this.copyProgram(target.textures.length);
    const src: Record<string, WebGLTexture> = {};
    target.textures.forEach((t, i) => (src[`uSrc${i}`] = t));
    program.setUniforms(src);
    const scr: Record<string, WebGLTexture> = {};
    scratch.textures.forEach((t, i) => (scr[`uScratch${i}`] = t));
    copy.setUniforms(scr);
    this.upload(vertices);
    const count = vertices.length / 4;
    gl.enable(gl.SCISSOR_TEST);

    // Large polygons are processed in scratch-sized tiles.
    for (let ty = area.y; ty < area.y + area.h; ty += SCRATCH_SIZE) {
      for (let tx = area.x; tx < area.x + area.w; tx += SCRATCH_SIZE) {
        const tw = Math.min(SCRATCH_SIZE, area.x + area.w - tx);
        const th = Math.min(SCRATCH_SIZE, area.y + area.h - ty);
        // Pass 1: evaluate the program into the scratch buffer.
        gl.bindFramebuffer(gl.FRAMEBUFFER, scratch.framebuffer);
        gl.viewport(0, 0, SCRATCH_SIZE, SCRATCH_SIZE);
        gl.scissor(0, 0, tw, th);
        this.setView(program, tx, ty, SCRATCH_SIZE, SCRATCH_SIZE);
        program.bind();
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, count);
        // Pass 2: copy the same polygon back into the target. The viewport has the same size
        // and an integer offset, so both passes rasterise exactly the same pixels.
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.viewport(tx, ty, SCRATCH_SIZE, SCRATCH_SIZE);
        gl.scissor(tx, ty, tw, th);
        this.setView(copy, tx, ty, SCRATCH_SIZE, SCRATCH_SIZE);
        copy.setUniforms({ uScratchOrigin: [tx, ty] });
        copy.bind();
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, count);
      }
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  draw(target: RenderTarget, program: Program, vertices: Float32Array, scissor?: Rect): void {
    const gl = this.gl;
    this.upload(vertices);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    if (scissor) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(scissor.x, scissor.y, scissor.w, scissor.h);
    } else {
      gl.disable(gl.SCISSOR_TEST);
    }
    this.setView(program, 0, 0, target.width, target.height);
    program.bind();
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, vertices.length / 4);
    gl.disable(gl.SCISSOR_TEST);
  }

  copy(source: RenderTarget, destination: RenderTarget): void {
    const copy = this.copyProgram(source.textures.length);
    const uniforms: Record<string, UniformValue> = { uScratchOrigin: [0, 0] };
    source.textures.forEach((t, i) => (uniforms[`uScratch${i}`] = t));
    copy.setUniforms(uniforms);
    this.draw(destination, copy, fullRect(destination.width, destination.height));
  }

  /** Core-internal: draw with a program that has its own vertex shader into the bound framebuffer. */
  drawRaw(program: Program, vertices: Float32Array): void {
    this.upload(vertices);
    program.bind();
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, vertices.length / 4);
  }

  /** Core-internal: create a program with a custom vertex shader (attribute `aVertex` at location 0). */
  createRawProgram(vertexSource: string, fragmentSource: string): Program {
    const p = new Program(this.gl, vertexSource, fragmentSource);
    this.programs.add(p);
    return p;
  }

  dispose(): void {
    const gl = this.gl;
    for (const s of this.scratch.values()) s.dispose();
    for (const p of this.copyPrograms.values()) p.dispose();
    for (const p of this.programs) p.dispose();
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
  }
}
