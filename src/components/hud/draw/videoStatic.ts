/**
 * Analogue interference, drawn.
 *
 * What a 5.8 GHz picture does as it runs out of link: grey, black and white
 * snow over the picture, a band of torn sync rolling down the frame, and the
 * occasional white flash where a whole line gives up. The behaviour — how much
 * of any of it, and when — is decided in `sim/hud/videoNoise`; everything here
 * is paint.
 *
 * The snow is generated into a small offscreen buffer and blown up over the
 * frame with smoothing off. A 5.8 GHz picture is 640 lines of composite video
 * on a good day, so the coarse speckle is closer to the truth than a
 * pixel-perfect one would be, and it costs a fraction of the fill.
 */

import type { VideoNoiseFrame } from "@/sim/hud/videoNoise";

/** Width of the offscreen snow buffer, in pixels. */
const NOISE_WIDTH = 224;
/** Height of it. Roughly 16:9, and small enough to regenerate every frame. */
const NOISE_HEIGHT = 126;

/** The scratch buffer the snow is generated into, kept between frames. */
export interface VideoStaticBuffer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly image: ImageData;
}

/** Builds the offscreen buffer. Call once and hand it back every frame. */
export function createVideoStaticBuffer(): VideoStaticBuffer | null {
  const canvas = document.createElement("canvas");
  canvas.width = NOISE_WIDTH;
  canvas.height = NOISE_HEIGHT;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;
  return {
    canvas,
    ctx,
    image: ctx.createImageData(NOISE_WIDTH, NOISE_HEIGHT),
  };
}

/**
 * Fills the buffer with one frame of snow.
 *
 * Analogue noise is luminance only — every pixel is a grey, and the extremes
 * are what the eye reads as static, so the distribution is pushed towards
 * black and white rather than left flat.
 */
function generateSnow(buffer: VideoStaticBuffer, density: number): void {
  const data = buffer.image.data;
  for (let i = 0; i < data.length; i += 4) {
    let level = Math.random();
    // Contrast: with a dense picture most samples end up hard black or hard
    // white, and a weak one keeps more of the mid greys.
    level = level < 0.5 ? level * (1 - density) : 1 - (1 - level) * (1 - density);
    const value = Math.round(level * 255);
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  buffer.ctx.putImageData(buffer.image, 0, 0);
}

/**
 * Draws one frame of interference over the whole viewport.
 *
 * Nothing is drawn for a clean link, so this is safe to call every frame
 * whatever the signal is doing.
 */
export function drawVideoStatic(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: VideoNoiseFrame,
  buffer: VideoStaticBuffer,
): void {
  if (frame.opacity <= 0.002) return;

  generateSnow(buffer, frame.snow);

  ctx.save();
  ctx.imageSmoothingEnabled = false;

  // The snow itself, over the whole picture.
  ctx.globalAlpha = frame.opacity;
  ctx.drawImage(buffer.canvas, 0, 0, width, height);

  // The rolling band: a stretch of the frame that has lost sync entirely, so
  // it is louder than the snow around it and smeared sideways.
  if (frame.bandStrength > 0.02) {
    const bandTop = frame.bandOffset * height;
    const bandHeight = Math.max(frame.bandHeight * height, 2);
    const shear = (frame.bandStrength - 0.5) * width * 0.08;

    // Sheared sideways and drawn wider than the frame, so the tear never
    // leaves a clean strip down one edge.
    const bandSource = Math.max(
      Math.round(buffer.canvas.height * frame.bandHeight),
      1,
    );
    ctx.globalAlpha = Math.min(frame.opacity + frame.bandStrength * 0.35, 1);
    const drawBand = (top: number): void => {
      ctx.drawImage(
        buffer.canvas,
        0,
        0,
        buffer.canvas.width,
        bandSource,
        shear,
        top,
        width + Math.abs(shear),
        bandHeight,
      );
    };
    drawBand(bandTop);
    // The band wraps: what leaves the bottom of the frame is arriving at the
    // top of it, which is what makes it read as rolling rather than jumping.
    if (bandTop + bandHeight > height) drawBand(bandTop - height);

    // A blown-out line at the leading edge of the band, the way a composite
    // picture flares where the sync pulse is missing.
    ctx.globalAlpha = frame.bandStrength * frame.opacity * 0.8;
    ctx.fillStyle = "rgba(235, 240, 245, 0.9)";
    ctx.fillRect(0, bandTop, width, Math.max(height * 0.004, 1));
  }

  // Once the picture has gone entirely there is nothing behind the snow, so
  // the corners are crushed to black — an analogue receiver with no carrier
  // is darker at the edges than a live picture ever is.
  if (frame.blackout) {
    ctx.globalAlpha = 1;
    const vignette = ctx.createRadialGradient(
      width / 2,
      height / 2,
      Math.min(width, height) * 0.25,
      width / 2,
      height / 2,
      Math.max(width, height) * 0.72,
    );
    vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
    vignette.addColorStop(1, "rgba(0, 0, 0, 0.75)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);
  }

  ctx.restore();
}
