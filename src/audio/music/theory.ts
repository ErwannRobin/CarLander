/**
 * Harmony for the procedural score.
 *
 * Gameplay and title are in D minor / D Dorian; the level-complete arrangement lifts to D major (the
 * fanfare's Picardy third carries straight into it). Pad voicings are hand-written in a narrow mid
 * register (E3–E4) with common-tone voice leading, so chord changes glide instead of jumping.
 */

export interface Chord {
  name: string;
  /** Pad voicing (MIDI). */
  pad: readonly number[];
  /** Root in octave 1–2 (MIDI). The pulse bass plays it an octave up, with a sub one octave below that. */
  root: number;
  /** Chord tones as pitch classes (root first) — arps and bell motifs only ever use these. */
  tones: readonly number[];
}

const chord = (name: string, pad: number[], root: number, tones: number[]): Chord => ({ name, pad, root, tones });

export const CHORDS = {
  Dm9: chord('Dm9', [53, 57, 60, 64], 38, [2, 5, 9, 0, 4]),
  Bbmaj9: chord('Bbmaj9', [53, 57, 60, 62], 34, [10, 2, 5, 9, 0]),
  Cadd9: chord('Cadd9', [52, 55, 60, 62], 36, [0, 4, 7, 2]),
  A7sus4: chord('A7sus4', [52, 55, 57, 62], 33, [9, 2, 4, 7]),
  Gm9: chord('Gm9', [53, 57, 58, 62], 31, [7, 10, 2, 5, 9]),
  Fmaj9: chord('Fmaj9', [52, 55, 57, 60], 29, [5, 9, 0, 4, 7]),
  Dmaj9: chord('Dmaj9', [54, 57, 61, 64], 38, [2, 6, 9, 1, 4]),
  Gmaj9: chord('Gmaj9', [54, 57, 59, 62], 31, [7, 11, 2, 6, 9]),
  Bm11: chord('Bm11', [54, 57, 62, 64], 35, [11, 2, 6, 9, 4]),
  A6sus2: chord('A6sus2', [52, 57, 59, 64], 33, [9, 11, 4, 6]),
} as const;

export type ArrangementId = 'title' | 'game' | 'complete';

export interface Arrangement {
  id: ArrangementId;
  bpm: number;
  /** One chord per bar; loops. */
  bars: readonly Chord[];
}

const C = CHORDS;

export const ARRANGEMENTS: Record<ArrangementId, Arrangement> = {
  // i – VI – VII – v(sus) | iv – VI – III – v(sus): cinematic, forward-leaning, never resolves fully
  // until the A7sus4 turns back to Dm9.
  game: {
    id: 'game',
    bpm: 100,
    bars: [
      C.Dm9, C.Dm9, C.Bbmaj9, C.Bbmaj9, C.Cadd9, C.Cadd9, C.A7sus4, C.A7sus4,
      C.Gm9, C.Gm9, C.Bbmaj9, C.Bbmaj9, C.Fmaj9, C.Fmaj9, C.A7sus4, C.A7sus4,
    ],
  },
  // i – VI – III – VII: wide and hopeful, slower.
  title: {
    id: 'title',
    bpm: 96,
    bars: [C.Dm9, C.Dm9, C.Bbmaj9, C.Bbmaj9, C.Fmaj9, C.Fmaj9, C.Cadd9, C.Cadd9],
  },
  // I – IV – vi – V in D major: calm accomplishment.
  complete: {
    id: 'complete',
    bpm: 96,
    bars: [C.Dmaj9, C.Dmaj9, C.Gmaj9, C.Gmaj9, C.Bm11, C.Bm11, C.A6sus2, C.A6sus2],
  },
};

/** Chords used while the car is in the air (suspension): VI for one bar, then the suspended dominant. */
export const FLIGHT_LIFT = C.Bbmaj9;
export const FLIGHT_HOLD = C.A7sus4;

const rangeCache = new Map<string, number[]>();

/** All MIDI notes belonging to `chord` within [lo, hi], ascending (cached — no per-step allocation). */
export function chordNotesInRange(c: Chord, lo: number, hi: number): readonly number[] {
  const key = `${c.name}:${lo}:${hi}`;
  let notes = rangeCache.get(key);
  if (!notes) {
    notes = [];
    for (let m = lo; m <= hi; m++) if (c.tones.includes(((m % 12) + 12) % 12)) notes.push(m);
    rangeCache.set(key, notes);
  }
  return notes;
}
