// Team color theming: recolors the whole board to the user's favorite team by
// overriding the CSS custom properties on :root.
import { getTeamColors } from './teams.js';

// The eight CSS custom properties team theming overrides. Listed once so the
// "no favourite team" reset can't drift out of sync with what apply sets.
const THEME_VARS = [
  '--amber', '--amber-dim', '--amber-rgb',
  '--turf', '--turf-2', '--night', '--night-2', '--night-rgb',
];

export function hexToRgb(hex){
  hex = hex.replace('#', '');
  if(hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const num = parseInt(hex, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}
export function rgbToHex(rgb){
  return '#' + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}
export function luminance(rgb){ return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; }

export function mixHex(hexA, hexB, ratio){
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return rgbToHex(a.map((v, i) => v * ratio + b[i] * (1 - ratio)));
}

export function rgbToHsl(rgb){
  let [r, g, b] = rgb.map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if(max === min){ h = s = 0; }
  else{
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch(max){
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}
export function hslToRgb(h, s, l){
  h /= 360; s /= 100; l /= 100;
  if(s === 0){ const v = l * 255; return [v, v, v]; }
  const hue2rgb = (p, q, t) => {
    if(t < 0) t += 1;
    if(t > 1) t -= 1;
    if(t < 1/6) return p + (q - p) * 6 * t;
    if(t < 1/2) return q;
    if(t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1/3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1/3) * 255];
}
// Punches up saturation and pulls lightness into a vivid mid-range, so every
// team's accent color reads as bold and distinct rather than close to the default.
export function vibrant(hex, minSat, targetLightness){
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  const newS = Math.max(s, minSat);
  const newL = Math.min(Math.max(l, targetLightness - 12), targetLightness + 12);
  return rgbToHex(hslToRgb(h, newS, newL));
}

export function applyTeamTheme(teamName){
  const root = document.documentElement.style;
  const colors = getTeamColors(teamName);
  if(!colors){
    THEME_VARS.forEach(v => root.removeProperty(v));
    return;
  }
  const [c1, c2] = colors;
  const hsl1 = rgbToHsl(hexToRgb(c1));
  const hsl2 = rgbToHsl(hexToRgb(c2));

  // Every NFL team is one colour of identity paired with a near-neutral (black,
  // white, silver, navy). The accent is the one that carries the identity: the
  // more saturated of the two, or -- when they're similarly saturated, like the
  // Browns' brown and orange -- the lighter one. The other becomes the base for
  // the background.
  let accentRaw, darkRaw;
  if(Math.abs(hsl1[1] - hsl2[1]) < 12){
    const c1Lighter = hsl1[2] >= hsl2[2];
    accentRaw = c1Lighter ? c1 : c2;
    darkRaw   = c1Lighter ? c2 : c1;
  } else {
    const c1MoreSaturated = hsl1[1] > hsl2[1];
    accentRaw = c1MoreSaturated ? c1 : c2;
    darkRaw   = c1MoreSaturated ? c2 : c1;
  }

  // Accent: the team's hue, forced bright and vivid so it reads as an accent on
  // a dark UI whatever the raw hex is. Steelers gold stays gold; Cowboys navy
  // comes up to a usable royal blue.
  const accent = vibrant(accentRaw, 68, 60);
  const [accentHue, accentSat] = rgbToHsl(hexToRgb(accent));
  // amber-dim is the panel/border colour -- a dimmer shade of the SAME hue, not
  // the team's other colour (which is where the muddy borders came from).
  const accentDim = rgbToHex(hslToRgb(accentHue, Math.max(accentSat - 8, 32), 33));

  root.setProperty('--amber', accent);
  root.setProperty('--amber-dim', accentDim);
  root.setProperty('--amber-rgb', hexToRgb(accent).join(','));

  // Background: the team's dark colour, driven hard -- the whole app should read
  // as that colour, not the default navy with a tint. A near-black team colour
  // (Steelers, Ravens, Raiders) borrows a whisper of the accent hue so the
  // panels don't flatten into a single #000.
  let [bgHue, bgSat] = rgbToHsl(hexToRgb(darkRaw));
  if(bgSat < 12){
    bgHue = accentHue;
    bgSat = 20;
  } else {
    bgSat = Math.min(Math.max(bgSat, 30), 62);
  }
  const shade = (l) => rgbToHex(hslToRgb(bgHue, bgSat, l));
  const night = shade(7);
  root.setProperty('--night', night);
  root.setProperty('--night-2', shade(13));
  root.setProperty('--turf', shade(10));
  root.setProperty('--turf-2', shade(5));
  root.setProperty('--night-rgb', hexToRgb(night).join(','));
}

