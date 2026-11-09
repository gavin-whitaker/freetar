import { audioEngine, hzToMidi, midiToHz, midiToName, NOTE_NAMES } from "./audio-engine.js";

const STRINGS = [
    { label: "E", name: "E2", midi: 40 },
    { label: "A", name: "A2", midi: 45 },
    { label: "D", name: "D3", midi: 50 },
    { label: "G", name: "G3", midi: 55 },
    { label: "B", name: "B3", midi: 59 },
    { label: "e", name: "E4", midi: 64 },
];
const MIN_CLARITY = 0.9;
const IN_TUNE_CENTS = 4;
const IN_TUNE_HOLD_MS = 300;
const SIGNAL_TIMEOUT_MS = 900;
const NEEDLE_MAX_DEG = 60;
const SMOOTHING = 0.25;

function gaugeSvg() {
    const ticks = [];
    for (let cents = -50; cents <= 50; cents += 10) {
        const major = cents % 50 === 0 || cents === 0;
        ticks.push(`<line x1="100" y1="${major ? 14 : 20}" x2="100" y2="28" transform="rotate(${(cents / 50) * NEEDLE_MAX_DEG} 100 110)" class="tuner-tick${cents === 0 ? " tuner-tick-zero" : ""}"/>`);
    }
    return `
        <svg class="tuner-gauge" viewBox="0 0 200 120" aria-hidden="true">
            <path d="M 23.8 66 A 88 88 0 0 1 176.2 66" class="tuner-arc"/>
            <path d="M 92.6 22.3 A 88 88 0 0 1 107.4 22.3" class="tuner-arc-zone"/>
            ${ticks.join("")}
            <text x="22" y="92" class="tuner-scale">-50</text>
            <text x="178" y="92" class="tuner-scale" text-anchor="end">+50</text>
            <g class="tuner-needle"><line x1="100" y1="110" x2="100" y2="22"/><circle cx="100" cy="110" r="6"/></g>
        </svg>`;
}

/** Render a tuner into `root`. Returns `{start, stop}`; the mic is only opened by `start()`. */
export function mountTuner(root) {
    const owner = Symbol("tuner");
    root.classList.add("tuner");
    root.innerHTML = `
        <div class="d-flex justify-content-center gap-2 mb-2">
            <div class="btn-group btn-group-sm" role="group" aria-label="Tuner mode">
                <button type="button" class="btn btn-outline-secondary active" data-mode="auto">Guitar (auto)</button>
                <button type="button" class="btn btn-outline-secondary" data-mode="chromatic">Chromatic</button>
            </div>
        </div>
        <div class="tuner-display">
            <div class="tuner-note"><span class="tuner-note-name">&ndash;</span><sub class="tuner-note-octave"></sub></div>
            ${gaugeSvg()}
            <div class="tuner-status text-body-secondary">Press start and play a string</div>
        </div>
        <div class="tuner-headstock" role="group" aria-label="Lock to a string">
            <div class="tuner-pegs">${[2, 1, 0].map(i => pegButton(i)).join("")}</div>
            <div class="tuner-head-shape" aria-hidden="true"></div>
            <div class="tuner-pegs">${[3, 4, 5].map(i => pegButton(i)).join("")}</div>
        </div>
        <div class="d-flex align-items-center gap-2 small text-body-secondary mt-2">
            <span class="tuner-hz font-monospace">&ndash; Hz</span>
            <div class="audio-level flex-grow-1" title="Input level"><div class="audio-level-bar"></div></div>
            <button type="button" class="btn btn-sm btn-primary tuner-toggle">Start tuner</button>
        </div>
        <div class="tuner-error alert alert-warning small mt-2 mb-0" style="display: none;"></div>`;

    function pegButton(i) {
        return `<button type="button" class="tuner-peg" data-string="${i}" title="Lock to ${STRINGS[i].name}">${STRINGS[i].label}</button>`;
    }

    const $ = (sel) => root.querySelector(sel);
    const noteName = $(".tuner-note-name");
    const noteOctave = $(".tuner-note-octave");
    const needle = $(".tuner-needle");
    const status = $(".tuner-status");
    const hzReadout = $(".tuner-hz");
    const levelBar = $(".audio-level-bar");
    const toggle = $(".tuner-toggle");
    const errorBox = $(".tuner-error");
    const pegs = root.querySelectorAll(".tuner-peg");

    let mode = "auto";
    let lockedString = null;
    let unsubscribe = null;
    let smoothedCents = 0;
    let lastTarget = null;
    let inTuneSince = null;
    let lastSignal = 0;

    root.querySelectorAll("[data-mode]").forEach((btn) => btn.addEventListener("click", () => {
        mode = btn.dataset.mode;
        lockedString = null;
        root.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("active", b === btn));
        root.classList.toggle("tuner-chromatic", mode === "chromatic");
        updatePegs(null);
    }));

    pegs.forEach((peg) => peg.addEventListener("click", () => {
        const index = Number(peg.dataset.string);
        lockedString = lockedString === index ? null : index;
        if (mode === "chromatic") {
            mode = "auto";
            root.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === "auto"));
            root.classList.remove("tuner-chromatic");
        }
        updatePegs(lockedString);
    }));

    toggle.addEventListener("click", () => (unsubscribe ? stop() : start()));

    function updatePegs(activeIndex) {
        pegs.forEach((peg) => {
            const index = Number(peg.dataset.string);
            peg.classList.toggle("active", index === activeIndex);
            peg.classList.toggle("locked", index === lockedString);
        });
    }

    function targetFor(midi) {
        if (mode === "chromatic") {
            const nearest = Math.round(midi);
            return { midi: nearest, label: NOTE_NAMES[((nearest % 12) + 12) % 12], octave: Math.floor(nearest / 12) - 1, string: null };
        }
        const index = lockedString ?? STRINGS.reduce((best, s, i) =>
            Math.abs(s.midi - midi) < Math.abs(STRINGS[best].midi - midi) ? i : best, 0);
        const s = STRINGS[index];
        return { midi: s.midi, label: s.name.slice(0, -1), octave: s.name.slice(-1), string: index };
    }

    function onFrame({ hz, clarity, rms, time }) {
        levelBar.style.width = `${Math.min(100, rms * 600)}%`;

        if (hz === null || clarity < MIN_CLARITY) {
            if (time - lastSignal > SIGNAL_TIMEOUT_MS) {
                root.classList.remove("tuner-in-tune", "tuner-active");
                status.textContent = "Play a string";
                needle.style.transform = "rotate(0deg)";
                inTuneSince = null;
            }
            return;
        }
        lastSignal = time;
        root.classList.add("tuner-active");

        const target = targetFor(hzToMidi(hz));
        const cents = 1200 * Math.log2(hz / midiToHz(target.midi));
        if (lastTarget !== target.midi) {
            smoothedCents = cents;
            lastTarget = target.midi;
            inTuneSince = null;
        } else {
            smoothedCents += (cents - smoothedCents) * SMOOTHING;
        }

        const shown = Math.max(-50, Math.min(50, smoothedCents));
        needle.style.transform = `rotate(${(shown / 50) * NEEDLE_MAX_DEG}deg)`;
        noteName.textContent = target.label;
        noteOctave.textContent = target.octave;
        hzReadout.textContent = `${hz.toFixed(1)} Hz`;
        updatePegs(target.string);

        if (Math.abs(smoothedCents) <= IN_TUNE_CENTS) {
            inTuneSince ??= time;
        } else {
            inTuneSince = null;
        }
        const inTune = inTuneSince !== null && time - inTuneSince >= IN_TUNE_HOLD_MS;
        root.classList.toggle("tuner-in-tune", inTune);
        if (inTune) {
            status.textContent = "✓ In tune";
        } else if (Math.abs(cents) > 50) {
            status.textContent = `${midiToName(hzToMidi(hz))} - way off, ${cents > 0 ? "tune down" : "tune up"}`;
        } else {
            status.textContent = `${smoothedCents > 0 ? "+" : ""}${smoothedCents.toFixed(0)} cents · ${smoothedCents > 0 ? "tune down" : "tune up"}`;
        }
    }

    async function start() {
        if (unsubscribe) return;
        errorBox.style.display = "none";
        try {
            await audioEngine.acquire(owner);
        } catch (err) {
            errorBox.textContent = err.message;
            errorBox.style.display = "";
            return;
        }
        unsubscribe = audioEngine.subscribe(onFrame);
        toggle.textContent = "Stop tuner";
        toggle.classList.replace("btn-primary", "btn-outline-danger");
        status.textContent = "Play a string";
    }

    function stop() {
        if (!unsubscribe) return;
        unsubscribe();
        unsubscribe = null;
        audioEngine.release(owner);
        toggle.textContent = "Start tuner";
        toggle.classList.replace("btn-outline-danger", "btn-primary");
        root.classList.remove("tuner-in-tune", "tuner-active");
        status.textContent = "Press start and play a string";
        levelBar.style.width = "0";
    }

    return { start, stop };
}

document.querySelectorAll("[data-tuner-mount]").forEach((el) => {
    el.tuner = mountTuner(el);
});

const modal = document.getElementById("tunerModal");
if (modal) {
    let tuner = null;
    modal.addEventListener("show.bs.modal", () => {
        tuner ??= mountTuner(modal.querySelector(".tuner-modal-body"));
        tuner.start();
    });
    modal.addEventListener("hidden.bs.modal", () => tuner?.stop());
}
