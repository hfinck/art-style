import type { ViewTransform } from '../view/ViewTransform';
import { fullRect } from '../util/rect';
import type { WebGLToolkit } from './GpuToolkit';
import type { Program } from './Program';
import type { RenderTarget } from './RenderTarget';

const VS = /* glsl */ `#version 300 es
layout(location = 0) in vec4 aVertex;
uniform mat3 uMatrix;
uniform vec2 uCanvasSize;
out vec2 vUV;
void main() {
  vUV = aVertex.zw;
  vec3 p = uMatrix * vec3(aVertex.xy, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uImage;
out vec4 outColor;
void main() {
  outColor = vec4(texture(uImage, vUV).rgb, 1.0);
}`;

/** Draws the finished painting to the screen with the current pan / zoom / rotation. */
export class Presenter {
  private readonly program: Program;
  background: [number, number, number] = [0.11, 0.11, 0.12];

  constructor(private readonly gpu: WebGLToolkit) {
    this.program = gpu.createRawProgram(VS, FS);
  }

  draw(image: RenderTarget, view: ViewTransform, viewW: number, viewH: number, dpr: number): void {
    const gl = this.gpu.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, viewW, viewH);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(this.background[0], this.background[1], this.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.program.setUniforms({
      uMatrix: view.clipMatrix(viewW, viewH, dpr),
      uImage: image.textures[0]!,
    });
    this.gpu.drawRaw(this.program, fullRect(image.width, image.height));
  }
}
