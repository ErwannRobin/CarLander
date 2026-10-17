/**
 * Blending presets for FX materials.
 *
 * All FX shaders output premultiplied color. Alpha is handled explicitly so the HDR render target's
 * alpha channel stays in [0, 1] (three's built-in AdditiveBlending uses SRC_ALPHA for the alpha
 * channel too, which accumulates alpha > 1 in half-float buffers and breaks later compositing).
 */
import {
  AddEquation,
  CustomBlending,
  type Blending,
  type BlendingDstFactor,
  type BlendingEquation,
  type BlendingSrcFactor,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ZeroFactor,
} from 'three';

interface BlendProps {
  blending: Blending;
  blendEquation: BlendingEquation;
  blendSrc: BlendingSrcFactor;
  blendDst: BlendingDstFactor;
  blendSrcAlpha: BlendingSrcFactor;
  blendDstAlpha: BlendingDstFactor;
}

/** dst.rgb += src.rgb ; dst.a unchanged. */
export const ADDITIVE: Readonly<BlendProps> = Object.freeze({
  blending: CustomBlending,
  blendEquation: AddEquation,
  blendSrc: OneFactor,
  blendDst: OneFactor,
  blendSrcAlpha: ZeroFactor,
  blendDstAlpha: OneFactor,
});

/** Premultiplied "over": dst = src + dst * (1 - src.a) (src.a = 0 gives pure additive). */
export const PREMULTIPLIED: Readonly<BlendProps> = Object.freeze({
  blending: CustomBlending,
  blendEquation: AddEquation,
  blendSrc: OneFactor,
  blendDst: OneMinusSrcAlphaFactor,
  blendSrcAlpha: OneFactor,
  blendDstAlpha: OneMinusSrcAlphaFactor,
});
