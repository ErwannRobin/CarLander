/**
 * ROADSTER FLIGHT palette — restrained: graphite, titanium, warm white, electric cyan,
 * occasional orange rocket exhaust. Red is reserved for warning LEDs (Level 3 structure)
 * and crash feedback. Use these tokens rather than ad-hoc colors.
 */
export const PALETTE = {
  graphite900: '#121417',
  graphite800: '#1a1d21',
  graphite700: '#24282d',
  graphite600: '#30353b',
  graphite500: '#454b53',
  titanium400: '#7d848d',
  titanium300: '#a3aab2',
  titanium200: '#c6cbd1',
  warmWhite: '#f1ede6',
  warmWhite2: '#e6dfd3',
  concrete: '#b9b4ab',
  concreteDark: '#8e8a83',
  asphalt: '#2b2e33',

  cyan: '#38e8ff',
  cyanDeep: '#0bb4d4',
  cyanGlow: '#7ff3ff',

  orange: '#ff7a1c',
  orangeHot: '#ffb36b',
  orangeCore: '#fff1d6',

  red: '#ff2b3d',
  amber: '#ffb020',
  success: '#7ff3ff',
  danger: '#ff4a4a',

  /** Car paint (pearl titanium white) and trims. */
  paint: '#e9ecef',
  paintAlt: '#b9c2cc',
  trimBlack: '#0d0f12',
  glass: '#0b1016',
} as const;

export type PaletteKey = keyof typeof PALETTE;
