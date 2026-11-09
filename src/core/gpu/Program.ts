import type { GpuProgram, UniformValue } from '../plugin-api/types';

interface UniformInfo {
  location: WebGLUniformLocation;
  type: number;
  size: number;
  /** Texture unit for sampler uniforms, -1 otherwise. */
  unit: number;
}

const SAMPLER_TYPES = new Set<number>([
  WebGL2RenderingContext.SAMPLER_2D,
  WebGL2RenderingContext.INT_SAMPLER_2D,
  WebGL2RenderingContext.UNSIGNED_INT_SAMPLER_2D,
]);

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    const numbered = source
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(3)}: ${l}`)
      .join('\n');
    throw new Error(`Shader compile error:\n${log}\n${numbered}`);
  }
  return shader;
}

/**
 * A linked WebGL program with reflection-based uniform setting.
 * Textures are remembered and (re)bound right before each draw so programs never
 * fight over texture units.
 */
export class Program implements GpuProgram {
  readonly handle: WebGLProgram;
  private readonly uniforms = new Map<string, UniformInfo>();
  private readonly textures = new Map<number, WebGLTexture>();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    vertexSource: string,
    fragmentSource: string,
  ) {
    const vs = compile(gl, gl.VERTEX_SHADER, vertexSource);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    if (!program) throw new Error('createProgram failed');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'aVertex');
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`);
    }
    this.handle = program;

    gl.useProgram(program);
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    let unit = 0;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      if (!info) continue;
      const location = gl.getUniformLocation(program, info.name);
      if (!location) continue;
      const name = info.name.replace(/\[0\]$/, '');
      const isSampler = SAMPLER_TYPES.has(info.type);
      const u: UniformInfo = { location, type: info.type, size: info.size, unit: isSampler ? unit++ : -1 };
      if (isSampler) gl.uniform1i(location, u.unit);
      this.uniforms.set(name, u);
    }
  }

  has(name: string): boolean {
    return this.uniforms.has(name);
  }

  setUniforms(values: Record<string, UniformValue>): void {
    const gl = this.gl;
    gl.useProgram(this.handle);
    for (const name in values) {
      const u = this.uniforms.get(name);
      if (!u) continue; // optimised out or unused: ignore silently
      const v = values[name]!;
      if (u.unit >= 0) {
        this.textures.set(u.unit, v as WebGLTexture);
        continue;
      }
      const arr = typeof v === 'number' ? null : (v as ArrayLike<number>);
      switch (u.type) {
        case gl.FLOAT:
          if (arr && u.size > 1) gl.uniform1fv(u.location, arr as Float32List);
          else gl.uniform1f(u.location, arr ? arr[0]! : (v as number));
          break;
        case gl.FLOAT_VEC2:
          gl.uniform2fv(u.location, arr as Float32List);
          break;
        case gl.FLOAT_VEC3:
          gl.uniform3fv(u.location, arr as Float32List);
          break;
        case gl.FLOAT_VEC4:
          gl.uniform4fv(u.location, arr as Float32List);
          break;
        case gl.INT:
        case gl.BOOL:
          gl.uniform1i(u.location, arr ? arr[0]! : (v as number));
          break;
        case gl.FLOAT_MAT3:
          gl.uniformMatrix3fv(u.location, false, arr as Float32List);
          break;
        default:
          throw new Error(`Unsupported uniform type for ${name}`);
      }
    }
  }

  /** Bind the program and every texture it references. */
  bind(): void {
    const gl = this.gl;
    gl.useProgram(this.handle);
    for (const [unit, tex] of this.textures) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    }
  }

  dispose(): void {
    this.gl.deleteProgram(this.handle);
    this.textures.clear();
  }
}
