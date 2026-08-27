// Team color theming: recolors the whole board to the user's favorite team by
// overriding the CSS custom properties on :root.
import { getTeamColors } from './teams.js';

const DEFAULT_THEME = {
  amber: '#FFB703', amberDim: '#8A6A1F', amberRgb: '255,183,3',
  turf: '#141B2E', turf2: '#0F1524', night: '#0A1628', night2: '#0F2036'
};

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
    root.removeProperty('--amber'); root.removeProperty('--amber-dim'); root.removeProperty('--amber-rgb');
    root.removeProperty('--turf'); root.removeProperty('--turf-2');
    root.removeProperty('--night'); root.removeProperty('--night-2'); root.removeProperty('--night-rgb');
    return;
  }
  const [c1, c2] = colors;
  const l1 = luminance(hexToRgb(c1)), l2 = luminance(hexToRgb(c2));
  let accent = l1 >= l2 ? c1 : c2;
  let dim = l1 >= l2 ? c2 : c1;
  // Force the accent into a bold, saturated, unmistakably "team-colored" range,
  // regardless of how close the raw hex is to the app's default amber.
  accent = vibrant(accent, 70, 58);
  dim = vibrant(dim, 45, 30);
  const accentRgb = hexToRgb(accent).join(',');

  root.setProperty('--amber', accent);
  root.setProperty('--amber-dim', dim);
  root.setProperty('--amber-rgb', accentRgb);
  // Blend BOTH team colors into the panel/background bases, much more heavily than
  // before, so the whole app clearly reads as that team's colors, not just a tint.
  const base = luminance(hexToRgb(colors[0])) <= luminance(hexToRgb(colors[1])) ? colors[0] : colors[1];
  const boldBase = vibrant(base, 35, 18);
  const newNight = mixHex(boldBase, DEFAULT_THEME.night, 0.4);
  root.setProperty('--turf', mixHex(boldBase, DEFAULT_THEME.turf, 0.7));
  root.setProperty('--turf-2', mixHex(boldBase, DEFAULT_THEME.turf2, 0.7));
  root.setProperty('--night', newNight);
  root.setProperty('--night-2', mixHex(boldBase, DEFAULT_THEME.night2, 0.4));
  root.setProperty('--night-rgb', hexToRgb(newNight).join(','));
}

