import { Chord, Note } from "./vendor/tonal.js";
import { hzToMidi, NOTE_NAMES } from "./audio-engine.js";

export const CHORD_MATCH = 0.75;
export const CHORD_STRONG = 0.82;
export const NOTE_CLARITY = 0.85;
export const NOTE_TOLERANCE = 0.6;

const mod12 = (n) => ((n % 12) + 12) % 12;

/** Pitch classes for a chord symbol, e.g. "G/B" -> {root: 7, third: 11, pcs: [7, 11, 2]}; null if unknown. */
export function chordPitchClasses(name) {
    const cleaned = name.trim().replace(/\s+/g, "");
    let chord = Chord.get(cleaned);
    if (chord.empty) {
        // fall back to the plain triad for exotic spellings
        const [, root, minor] = cleaned.match(/^([A-Ga-g][#b]?)(m(?!aj))?/) || [];
        if (!root) return null;
        chord = Chord.get(root.toUpperCase() + (minor ? "m" : ""));
        if (chord.empty) return null;
    }
    const pcs = new Set(chord.notes.map((n) => Note.chroma(n)));
    if (chord.bass) pcs.add(Note.chroma(chord.bass));
    const root = Note.chroma(chord.tonic ?? chord.notes[0]);
    const third = chord.notes.length > 1 ? Note.chroma(chord.notes[1]) : null;
    return { root, third, pcs: [...pcs] };
}

/** Chord target built from simultaneous MIDI notes (a 3+ note tab column). */
export function pitchClassesFromMidis(midis) {
    const sorted = [...midis].sort((a, b) => a - b);
    const pcs = [...new Set(sorted.map(mod12))];
    return { root: mod12(sorted[0]), third: pcs.length > 1 ? pcs[1] : null, pcs };
}

export function shiftPitchClasses(chord, semitones) {
    if (!chord) return null;
    return {
        root: mod12(chord.root + semitones),
        third: chord.third === null ? null : mod12(chord.third + semitones),
        pcs: chord.pcs.map((pc) => mod12(pc + semitones)),
    };
}

/**
 * Cosine similarity between a 12-bin chroma (C first) and the chord's pitch classes,
 * or 0 when the root (and third, for 3+ note chords) aren't among the loudest bins.
 */
export function chordScore(chroma, chord) {
    if (!chroma || !chord) return 0;
    const max = Math.max(...chroma);
    if (!(max > 0)) return 0;
    const norm = chroma.map((v) => v / max);

    const ranked = norm.map((v, pc) => [v, pc]).sort((a, b) => b[0] - a[0]).map(([, pc]) => pc);
    const topN = Math.max(4, chord.pcs.length + 1);
    const top = new Set(ranked.slice(0, topN));
    if (!top.has(chord.root)) return 0;
    if (chord.pcs.length >= 3 && chord.third !== null && !top.has(chord.third)) return 0;

    let dot = 0, chromaSq = 0;
    for (let pc = 0; pc < 12; pc++) {
        const t = chord.pcs.includes(pc) ? 1 : 0;
        dot += norm[pc] * t;
        chromaSq += norm[pc] * norm[pc];
    }
    return dot / (Math.sqrt(chromaSq) * Math.sqrt(chord.pcs.length));
}

/** Distance in semitones from the detected pitch to the closest expected note, or null without a clear pitch. */
export function noteDistance(hz, clarity, midis) {
    if (hz === null || clarity < NOTE_CLARITY || !midis.length) return null;
    const detected = hzToMidi(hz);
    return Math.min(...midis.map((m) => Math.abs(detected - m)));
}

const TRIADS = [];
for (let root = 0; root < 12; root++) {
    TRIADS.push({ name: NOTE_NAMES[root], root, third: mod12(root + 4), pcs: [root, mod12(root + 4), mod12(root + 7)] });
    TRIADS.push({ name: NOTE_NAMES[root] + "m", root, third: mod12(root + 3), pcs: [root, mod12(root + 3), mod12(root + 7)] });
}

/** Best guess major/minor triad for a chroma frame, for the "Hearing" readout. */
export function estimateChord(chroma) {
    let best = null, bestScore = CHORD_MATCH;
    for (const triad of TRIADS) {
        const score = chordScore(chroma, triad);
        if (score > bestScore) {
            best = triad.name;
            bestScore = score;
        }
    }
    return best;
}
