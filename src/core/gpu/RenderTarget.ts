import type { GpuTarget, TextureFormat } from '../plugin-api/types';

export interface TargetOptions {
  attachments: number;
  format: TextureFormat;
  linear?: boolean;
  /** Allocate a full mip chain (core-internal; used for the display image). */
  mipmaps?: boolean;
}

/** One framebuffer with N colour attachments of identical size and format. */
export class RenderTarget implements GpuTarget {
  readonly textures: WebGLTexture[] = [];
  readonly framebuffer: WebGLFramebuffer;
  readonly format: TextureFormat;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly width: number,
    readonly height: number,
    readonly options: TargetOptions,
  ) {
    this.format = options.format;
    const fb = gl.createFramebuffer();
    if (!fb) throw new Error('createFramebuffer failed');
    this.framebuffer = fb;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const internal = options.format === 'rgba16f' ? gl.RGBA16F : gl.RGBA8;
    const levels = options.mipmaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
    const drawBuffers: number[] = [];
    for (let i = 0; i < options.attachments; i++) {
      const tex = gl.createTexture();
      if (!tex) throw new Error('createTexture failed');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, levels, internal, width, height);
      const minFilter = options.mipmaps ? gl.LINEAR_MIPMAP_LINEAR : options.linear ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, options.linear || options.mipmaps ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0);
      drawBuffers.push(gl.COLOR_ATTACHMENT0 + i);
      this.textures.push(tex);
    }
    gl.drawBuffers(drawBuffers);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) {
      this.dispose();
      throw new Error(`Framebuffer incomplete (${options.format}, status ${status})`);
    }
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of this.textures) gl.deleteTexture(t);
    this.textures.length = 0;
    gl.deleteFramebuffer(this.framebuffer);
  }
}
