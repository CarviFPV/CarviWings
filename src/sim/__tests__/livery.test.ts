import { assert, assertClose, suite } from "./harness";
import {
  DEFAULT_LIVERY,
  LIVERY_PRESETS,
  hexOf,
  normaliseColor,
  normaliseLivery,
  rgbOf,
  sameLivery,
} from "../flight/livery";
import { PAINT, buildAircraftMesh, partColor } from "../render/aircraftMesh";
import {
  DEFAULT_PREVIEW_AZIMUTH,
  DEFAULT_PREVIEW_ELEVATION,
  cssColor,
  previewImage,
  previewTriangles,
} from "../render/aircraftPreview";
import {
  INTERCEPTOR_WING,
  SKYWALKER_X8_UAV,
  activeLivery,
  liveryFor,
  normaliseUavSettings,
  withLivery,
} from "../flight/uav";
import {
  applyBuild,
  buildFromSettings,
  buildMatchesSettings,
  normaliseBuild,
} from "../flight/builds";

const RED = "#ff0000";

function bench() {
  return normaliseUavSettings({ active: INTERCEPTOR_WING.id });
}

export function runLiveryTests(): void {
  suite("a colour is a colour or it is not stored at all", () => {
    assert(normaliseColor("#A1B2C3") === "#a1b2c3", "case is not part of one");
    assert(normaliseColor(" #abc ") === "#aabbcc", "and shorthand is expanded");
    assert(normaliseColor("cyan") === null, "a name is not one");
    assert(normaliseColor("#12345") === null, "and neither is a truncated one");
    assert(normaliseColor(17) === null, "nor a number");

    const rgb = rgbOf("#8040c0");
    assertClose(rgb[0], 128 / 255, 1e-9, "red comes back off the front");
    assertClose(rgb[1], 64 / 255, 1e-9, "green out of the middle");
    assertClose(rgb[2], 192 / 255, 1e-9, "and blue off the end");
    assert(hexOf(rgb) === "#8040c0", "and it survives the round trip");
  });

  suite("a livery nobody can read falls back to the delivered one", () => {
    const repaired = normaliseLivery(
      { shell: "not a colour" },
      SKYWALKER_X8_UAV.defaultLivery,
    );
    assert(
      repaired.shell === SKYWALKER_X8_UAV.defaultLivery.shell,
      "the shell is the one the airframe is delivered in",
    );
    assert(
      repaired.accent === SKYWALKER_X8_UAV.defaultLivery.accent,
      "and so is the accent that was not there at all",
    );
    assert(
      sameLivery(normaliseLivery(undefined), DEFAULT_LIVERY),
      "nothing stored at all is an aircraft that was never painted",
    );
  });

  suite("the delivered palette is the default livery, painted on", () => {
    const mesh = buildAircraftMesh();
    for (const part of mesh.staticParts) {
      const painted = partColor(part, DEFAULT_LIVERY);
      // Within half a byte: the livery is written the way a colour picker
      // writes one, and the mesh was drawn in decimals.
      for (let channel = 0; channel < 3; channel += 1) {
        assertClose(
          painted[channel] ?? 0,
          part.color[channel] ?? 0,
          1 / 255,
          `${part.name} is delivered in the colour it is drawn in`,
        );
      }
    }
  });

  suite("painting the aircraft moves the paint and nothing else", () => {
    const mesh = buildAircraftMesh();
    const livery = { shell: RED, accent: "#00ff00" };
    const shell = mesh.staticParts.find((part) => part.paint === PAINT.Shell);
    const accent = mesh.staticParts.find((part) => part.paint === PAINT.Accent);
    const fixed = mesh.staticParts.find((part) => part.paint === PAINT.Fixed);
    assert(shell !== undefined, "the shell is painted");
    assert(accent !== undefined, "so is the tape");
    assert(fixed !== undefined, "and the lens and the motor are not");
    if (!shell || !accent || !fixed) return;

    const paintedShell = partColor(shell, livery);
    assertClose(paintedShell[0], shell.shade, 1e-9, "the shell wears the shell");
    assertClose(paintedShell[1], 0, 1e-9, "and only the shell");
    assertClose(
      partColor(accent, livery)[1],
      accent.shade,
      1e-9,
      "the tape wears the accent",
    );
    assertClose(
      partColor(fixed, livery)[0],
      fixed.color[0] ?? 0,
      1e-9,
      "and the hardware is whatever it is made of",
    );

    const top = mesh.staticParts.find((part) => part.name === "shell-top");
    const bottom = mesh.staticParts.find(
      (part) => part.name === "shell-bottom",
    );
    assert(
      top !== undefined &&
        bottom !== undefined &&
        (partColor(bottom, livery)[0] ?? 0) < (partColor(top, livery)[0] ?? 0),
      "the underside stays darker than the top, whatever it is painted",
    );
  });

  suite("paint stays with the airframe it was put on", () => {
    const painted = withLivery(bench(), INTERCEPTOR_WING.id, { shell: RED });
    assert(
      liveryFor(painted, INTERCEPTOR_WING.id).shell === RED,
      "the aircraft that was painted is painted",
    );
    assert(
      liveryFor(painted, SKYWALKER_X8_UAV.id).shell ===
        SKYWALKER_X8_UAV.defaultLivery.shell,
      "and the one in the corner of the hangar is not",
    );
    assert(
      liveryFor(painted, INTERCEPTOR_WING.id).accent === DEFAULT_LIVERY.accent,
      "painting the shell leaves the tape alone",
    );
    assert(
      activeLivery(painted).shell === RED,
      "and the aircraft being flown is the one on the bench",
    );
    assert(
      withLivery(painted, INTERCEPTOR_WING.id, { shell: "purple" }).livery[
        INTERCEPTOR_WING.id
      ]?.shell === RED,
      "a colour that is not one leaves the aircraft as it was",
    );
  });

  suite("a saved aircraft is saved in its colours", () => {
    const painted = withLivery(bench(), INTERCEPTOR_WING.id, { shell: RED });
    const build = buildFromSettings(painted, "one", "Red one");
    assert(build.livery.shell === RED, "the paint is part of the build");
    assert(
      buildMatchesSettings(painted, build),
      "and the bench is holding it",
    );
    assert(
      !buildMatchesSettings(bench(), build),
      "an identical aircraft in different colours is a different aircraft",
    );
    assert(
      liveryFor(applyBuild(bench(), build), INTERCEPTOR_WING.id).shell === RED,
      "fitting it paints the bench back",
    );

    const stored = normaliseBuild(
      { ...build, id: "two", livery: { shell: "#zzz" } },
      [],
    );
    assert(
      stored?.livery.shell === DEFAULT_LIVERY.shell,
      "a stored build with paint nobody can read is delivered colours",
    );
  });

  suite("every scheme on offer is one the renderer can use", () => {
    for (const preset of LIVERY_PRESETS) {
      assert(
        sameLivery(normaliseLivery(preset.livery), preset.livery),
        `${preset.label} is stored exactly as it is offered`,
      );
    }
    assert(
      LIVERY_PRESETS.some((preset) => sameLivery(preset.livery, DEFAULT_LIVERY)),
      "and the delivered colours are one of them",
    );
  });

  suite("the picture is the aircraft, drawn into the box it is given", () => {
    const view = {
      azimuthDeg: DEFAULT_PREVIEW_AZIMUTH,
      elevationDeg: DEFAULT_PREVIEW_ELEVATION,
      width: 320,
      height: 180,
    };
    const triangles = previewTriangles(view);
    assert(triangles.length > 100, "there is an airframe in it");

    const mesh = buildAircraftMesh();
    const drawn =
      mesh.staticParts.reduce((sum, part) => sum + part.indices.length, 0) / 3;
    assert(
      triangles.length < drawn,
      "and the half of it facing away is not drawn",
    );

    let inside = true;
    let sorted = true;
    let previous = -Infinity;
    for (const triangle of triangles) {
      for (let i = 0; i < 6; i += 2) {
        const x = triangle.points[i] ?? 0;
        const y = triangle.points[i + 1] ?? 0;
        if (x < 0 || x > view.width || y < 0 || y > view.height) inside = false;
      }
      if (triangle.depth < previous) sorted = false;
      previous = triangle.depth;
    }
    assert(inside, "nothing is drawn outside the frame it was given");
    assert(sorted, "and what is nearer is drawn last, over what is behind it");

    const wide = previewTriangles({ ...view, width: 640 });
    let maxX = -Infinity;
    for (const triangle of wide) {
      maxX = Math.max(maxX, triangle.points[0], triangle.points[2], triangle.points[4]);
    }
    assert(maxX > view.width, "a wider box is a bigger aircraft, not a gap");

    const red = previewTriangles({ ...view, livery: { shell: RED, accent: RED } });
    assert(
      red.some((triangle) => (triangle.color[0] ?? 0) > (triangle.color[2] ?? 0) * 4),
      "and the picture is painted in the colours the aircraft is",
    );
    assert(cssColor([1, 0.5, 0]) === "rgb(255,128,0)", "a colour a canvas takes");
  });

  suite("what is in front is decided pixel by pixel", () => {
    const view = {
      azimuthDeg: DEFAULT_PREVIEW_AZIMUTH,
      elevationDeg: DEFAULT_PREVIEW_ELEVATION,
      width: 240,
      height: 140,
      livery: { shell: "#808080", accent: "#ff6b0d" },
    };
    const picture = previewImage(view);
    assert(
      picture.pixels.length === view.width * view.height * 4,
      "the buffer is the frame that was asked for",
    );

    let covered = 0;
    let part = 0;
    let border = 0;
    for (let y = 0; y < picture.height; y += 1) {
      for (let x = 0; x < picture.width; x += 1) {
        const alpha = picture.pixels[(y * picture.width + x) * 4 + 3] ?? 0;
        if (alpha === 255) covered += 1;
        else if (alpha !== 0) part += 1;
        if (alpha !== 0 && (x === 0 || y === 0)) border += 1;
      }
    }
    assert(covered > 1500, "the aircraft covers a good part of the frame");
    assert(part === 0, "and every pixel is either aircraft or nothing");
    // The padding is kept, so the aircraft never runs into the frame.
    assert(border === 0, "nothing is painted into the border");

    // The wing is grey and the pod hangs a couple of centimetres under it, so
    // an airframe drawn from above with anything darker than the shell showing
    // through the middle of the wing is one whose visibility is wrong.
    const shellGrey = 128;
    let leaked = 0;
    for (let i = 0; i < picture.pixels.length; i += 4) {
      const alpha = picture.pixels[i + 3] ?? 0;
      const red = picture.pixels[i] ?? 0;
      const green = picture.pixels[i + 1] ?? 0;
      const blue = picture.pixels[i + 2] ?? 0;
      // Anything neither shell-grey nor the orange tape is hardware, which
      // there is very little of: the camera, the lens, the motor and a blade.
      const grey = red === green && green === blue;
      if (alpha === 255 && grey && red < shellGrey * 0.3) leaked += 1;
    }
    assert(
      leaked < covered * 0.06,
      "the pod and the motor stay under the wing they are bolted to",
    );

    const empty = previewImage({ ...view, width: 0, height: 40 });
    assert(empty.pixels.length === 0, "a frame with no width draws nothing");
  });
}
