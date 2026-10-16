export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function parseChannel(value: string): number | null {
  const trimmed = value.trim();
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return clamp(trimmed.endsWith("%") ? parsed * 2.55 : parsed, 0, 255);
}

function parseAlpha(value: string | undefined): number | null {
  if (value === undefined) return 1;
  const alpha = Number.parseFloat(value.trim());
  if (!Number.isFinite(alpha)) return null;
  return clamp(value.trim().endsWith("%") ? alpha / 100 : alpha, 0, 1);
}

function hueToRgb(p: number, q: number, tInput: number): number {
  let t = tInput;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function parseHsl(parts: string[]): Color | null {
  if (parts.length < 3 || parts.length > 4) return null;
  const hueString = parts[0].trim().toLowerCase();
  let hue = Number.parseFloat(hueString);
  if (!Number.isFinite(hue)) return null;
  if (hueString.endsWith("turn")) hue *= 360;
  else if (hueString.endsWith("rad")) hue = (hue * 180) / Math.PI;
  hue = ((hue % 360) + 360) % 360;
  const saturation = Number.parseFloat(parts[1]) / (parts[1].includes("%") ? 100 : 1);
  const lightness = Number.parseFloat(parts[2]) / (parts[2].includes("%") ? 100 : 1);
  const alpha = parseAlpha(parts[3]);
  if (![saturation, lightness].every(Number.isFinite) || alpha === null) return null;
  const s = clamp(saturation, 0, 1);
  const l = clamp(lightness, 0, 1);
  if (s === 0) {
    const gray = l * 255;
    return { r: gray, g: gray, b: gray, a: alpha };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hueToRgb(p, q, hue / 360 + 1 / 3) * 255,
    g: hueToRgb(p, q, hue / 360) * 255,
    b: hueToRgb(p, q, hue / 360 - 1 / 3) * 255,
    a: alpha,
  };
}

export function parseCssColor(input: string): Color | null {
  const value = input.trim().toLowerCase();
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (value === "black") return { r: 0, g: 0, b: 0, a: 1 };
  if (value === "white") return { r: 255, g: 255, b: 255, a: 1 };
  if (value === "red") return { r: 255, g: 0, b: 0, a: 1 };
  if (value === "gray" || value === "grey") return { r: 128, g: 128, b: 128, a: 1 };

  const hex = value.match(/^#([\da-f]{3,8})$/i)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const expanded = hex.length <= 4 ? [...hex].map((part) => part + part).join("") : hex;
    const hasAlpha = expanded.length === 8;
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
      a: hasAlpha ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
  }

  const fn = value.match(/^(rgba?|hsla?)\((.*)\)$/);
  if (!fn) return null;
  const fnName = fn[1];
  const parts = fn[2].trim().replace(/\s*\/\s*/, ",").split(/[\s,]+/).filter(Boolean);
  if (fnName.startsWith("hsl")) return parseHsl(parts);
  if (parts.length < 3 || parts.length > 4) return null;
  const channels = parts.slice(0, 3).map(parseChannel);
  const alpha = parseAlpha(parts[3]);
  if (channels.some((channel) => channel === null) || alpha === null) return null;
  return { r: channels[0]!, g: channels[1]!, b: channels[2]!, a: alpha };
}

export function compositeColor(foreground: Color, background: Color): Color {
  const backdrop = background.a < 1 ? compositeColor(background, { r: 255, g: 255, b: 255, a: 1 }) : background;
  const alpha = foreground.a + backdrop.a * (1 - foreground.a);
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const channel = (front: number, back: number) => (front * foreground.a + back * backdrop.a * (1 - foreground.a)) / alpha;
  return { r: channel(foreground.r, backdrop.r), g: channel(foreground.g, backdrop.g), b: channel(foreground.b, backdrop.b), a: alpha };
}

function linearChannel(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: Color, backdrop: Color = { r: 255, g: 255, b: 255, a: 1 }): number {
  const opaque = color.a < 1 ? compositeColor(color, backdrop) : color;
  return 0.2126 * linearChannel(opaque.r) + 0.7152 * linearChannel(opaque.g) + 0.0722 * linearChannel(opaque.b);
}

export function contrastRatio(foreground: Color, background: Color): number {
  const bg = background.a < 1 ? compositeColor(background, { r: 255, g: 255, b: 255, a: 1 }) : background;
  const fg = foreground.a < 1 ? compositeColor(foreground, bg) : foreground;
  const luminanceA = relativeLuminance(fg);
  const luminanceB = relativeLuminance(bg);
  return (Math.max(luminanceA, luminanceB) + 0.05) / (Math.min(luminanceA, luminanceB) + 0.05);
}

export function isDarkCssColor(value: string, threshold = 0.28): boolean {
  const color = parseCssColor(value);
  return color !== null && color.a > 0 && relativeLuminance(color) < threshold;
}
