import { audioEngine, midiToName } from "./audio-engine.js";
import {
    CHORD_MATCH, CHORD_STRONG, NOTE_TOLERANCE,
    chordPitchClasses, chordScore, estimateChord, noteDistance, pitchClassesFromMidis, shiftPitchClasses,
} from "./follow-match.js";

const CONFIRM_FRAMES = 3;
const LOOKAHEAD_FRAMES = 4;
const LOOKAHEAD = 2;
// While the sound still matches the target just played (a ringing strum/note, or a dyad
// sharing a note with the next one), only a fresh onset may advance - or this long a wait,
// in case the onset was missed.
const RINGING_TIMEOUT_MS = { CHORD: 1650, TAB_CHORD: 1650, TAB_NOTE: 720 };
const ONSET_IGNORE_AFTER_ADVANCE_MS = 120;
const SCROLL_THROTTLE_MS = 400;

const tabEl = document.querySelector(".tab");
const hud = document.getElementById("listenHud");

if (tabEl && hud) {
    initFollower();
}

function initFollower() {
    const owner = Symbol("follower");
    const $ = (sel) => hud.querySelector(sel);
    const ui = {
        listen: $("#hud_listen"),
        listenLabel: $("#hud_listen .label"),
        level: $(".audio-level-bar"),
        sensitivity: $("#hud_sensitivity"),
        hearing: $("#hud_hearing"),
        next: $("#hud_next"),
        position: $("#hud_position"),
        capo: $("#hud_capo"),
        error: $("#hud_error"),
    };

    let queue = [];
    let cursor = 0;
    let capo = Number(tabEl.dataset.capo) || 0;
    let transposeSteps = 0;
    let listening = false;
    let unsubscribe = null;
    let streak = { index: -1, count: 0 };
    let lastAdvance = 0;
    let onsetSinceAdvance = true;
    let lastScroll = 0;
    let highlighted = [];

    ui.capo.value = String(capo);

    /*****************
     * Target queue
     *****************/

    function buildQueue() {
        queue = [];
        const staffSlots = new Map();
        for (const el of tabEl.querySelectorAll(".chord, .tab-note")) {
            if (el.classList.contains("chord")) {
                // skip things like "N.C." that aren't playable chords
                if (chordPitchClasses(el.textContent)) queue.push({ type: "CHORD", els: [el] });
                continue;
            }
            const [block, col] = el.dataset.col.split("-").map(Number);
            if (!staffSlots.has(block)) {
                staffSlots.set(block, { columns: new Map() });
                queue.push({ type: "STAFF", block });
            }
            const columns = staffSlots.get(block).columns;
            if (!columns.has(col)) columns.set(col, []);
            columns.get(col).push(el);
        }

        queue = queue.flatMap((item) => {
            if (item.type !== "STAFF") return [item];
            const columns = staffSlots.get(item.block).columns;
            return [...columns.keys()].sort((a, b) => a - b).map((col) => {
                const els = columns.get(col);
                return { type: els.length >= 3 ? "TAB_CHORD" : "TAB_NOTE", els };
            });
        });

        queue.forEach((target, index) => {
            target.lines = [...new Set(target.els.map((el) => el.closest(".tab-line")).filter(Boolean))];
            target.els.forEach((el) => {
                el.classList.add("follow-target");
                el.dataset.followIndex = index;
            });
        });
        computeExpectations();
        cursor = Math.min(cursor, Math.max(0, queue.length - 1));
    }

    // Chord names on the page are already transposed, so only the capo shifts them.
    // Tab frets aren't renamed by transpose, so they shift by capo + transpose.
    function computeExpectations() {
        for (const target of queue) {
            if (target.type === "CHORD") {
                target.label = target.els[0].textContent.trim();
                target.chord = shiftPitchClasses(chordPitchClasses(target.label), capo);
                target.key = `c:${[...(target.chord?.pcs ?? [])].sort((a, b) => a - b).join(",")}`;
            } else {
                const midis = target.els.map((el) => Number(el.dataset.midi) + capo + transposeSteps);
                target.midis = midis;
                target.label = midis.map(midiToName).join(" ");
                target.chord = target.type === "TAB_CHORD" ? pitchClassesFromMidis(midis) : null;
                target.key = `n:${[...midis].sort((a, b) => a - b).join(",")}`;
            }
        }
    }

    /*****************
     * Matching + state machine
     *****************/

    function score(target, frame) {
        if (!target) return 0;
        if (target.type === "TAB_NOTE") {
            const distance = noteDistance(frame.hz, frame.clarity, target.midis);
            return distance !== null && distance <= NOTE_TOLERANCE ? 1 - distance / 2 : 0;
        }
        const s = chordScore(frame.chroma, target.chord);
        return s >= CHORD_MATCH ? s : 0;
    }

    function noiseGate() {
        // slider 1..100 -> rms gate 0.08 .. 0.002 (higher sensitivity = lower gate)
        return 0.002 * Math.pow(40, (100 - Number(ui.sensitivity.value)) / 100);
    }

    function onFrame(frame) {
        ui.level.style.width = `${Math.min(100, frame.rms * 600)}%`;
        const gated = frame.rms < noiseGate();
        updateHearing(frame, gated);
        if (gated || !queue.length) {
            streak = { index: -1, count: 0 };
            return;
        }
        if (frame.onset && frame.time - lastAdvance > ONSET_IGNORE_AFTER_ADVANCE_MS) {
            onsetSinceAdvance = true;
        }

        let candidate = -1;
        if (score(queue[cursor], frame) > 0) {
            candidate = cursor;
        } else {
            let best = 0;
            for (let i = cursor + 1; i <= Math.min(cursor + LOOKAHEAD, queue.length - 1); i++) {
                const s = score(queue[i], frame);
                const strong = queue[i].type === "TAB_NOTE" ? s > 0 : s >= CHORD_STRONG;
                if (strong && s > best) {
                    best = s;
                    candidate = i;
                }
            }
        }
        if (candidate === -1) {
            streak = { index: -1, count: 0 };
            return;
        }

        streak = candidate === streak.index ? { index: candidate, count: streak.count + 1 } : { index: candidate, count: 1 };
        const needed = candidate === cursor ? CONFIRM_FRAMES : LOOKAHEAD_FRAMES;
        if (streak.count < needed) return;

        const justPlayed = queue[cursor - 1];
        if (justPlayed && !onsetSinceAdvance && score(justPlayed, frame) > 0
            && frame.time - lastAdvance < RINGING_TIMEOUT_MS[justPlayed.type]) {
            return;
        }
        moveTo(candidate + 1, frame.time);
    }

    function moveTo(index, time = performance.now()) {
        cursor = Math.max(0, Math.min(index, queue.length));
        lastAdvance = time;
        onsetSinceAdvance = false;
        streak = { index: -1, count: 0 };
        render();
    }

    /*****************
     * Display
     *****************/

    function render() {
        highlighted.forEach((el) => el.classList.remove("follow-current", "follow-next", "follow-line"));
        highlighted = [];
        queue.forEach((target, i) => target.els.forEach((el) => el.classList.toggle("follow-passed", i < cursor)));

        const current = queue[cursor];
        const next = queue[cursor + 1];
        if (current) {
            current.els.forEach((el) => el.classList.add("follow-current"));
            current.lines.forEach((line) => line.classList.add("follow-line"));
            highlighted.push(...current.els, ...current.lines);
        }
        if (next) {
            next.els.forEach((el) => el.classList.add("follow-next"));
            highlighted.push(...next.els);
        }

        ui.next.textContent = current ? current.label : "Done!";
        ui.position.textContent = queue.length ? `${Math.min(cursor + 1, queue.length)} / ${queue.length}` : "";
        if (current) scrollToTarget(current);
    }

    function scrollToTarget(target) {
        const now = performance.now();
        const line = target.lines[0] ?? target.els[0];
        const rect = line.getBoundingClientRect();
        const outsideMiddle = rect.top < window.innerHeight * 0.2 || rect.bottom > window.innerHeight * 0.6;
        if (outsideMiddle && now - lastScroll > SCROLL_THROTTLE_MS) {
            lastScroll = now;
            line.scrollIntoView({ behavior: "smooth", block: "center" });
        }
    }

    function updateHearing(frame, gated) {
        if (gated) {
            ui.hearing.textContent = "–";
            return;
        }
        const parts = [];
        if (frame.hz !== null && frame.clarity >= 0.85) {
            parts.push(`${midiToName(69 + 12 * Math.log2(frame.hz / 440))} (${frame.hz.toFixed(0)} Hz)`);
        }
        const chord = estimateChord(frame.chroma);
        if (chord) parts.push(chord);
        ui.hearing.textContent = parts.join(" | ") || "…";
    }

    /*****************
     * Controls
     *****************/

    async function startListening() {
        ui.error.style.display = "none";
        try {
            await audioEngine.acquire(owner);
        } catch (err) {
            ui.error.textContent = err.message;
            ui.error.style.display = "";
            return;
        }
        unsubscribe = audioEngine.subscribe(onFrame, { chroma: true });
        listening = true;
        hud.classList.add("listening");
        ui.listenLabel.textContent = "Pause";

        const autoscroll = document.getElementById("checkbox_autoscroll");
        if (autoscroll?.checked) autoscroll.click();
        onsetSinceAdvance = true;
        render();
    }

    function stopListening() {
        if (!listening) return;
        unsubscribe?.();
        unsubscribe = null;
        audioEngine.release(owner);
        listening = false;
        hud.classList.remove("listening");
        ui.listenLabel.textContent = "Listen";
        ui.level.style.width = "0";
        ui.hearing.textContent = "–";
    }

    function openHud() {
        hud.style.display = "";
        document.body.classList.add("follower-open");
        tabEl.classList.add("following");
        if (!queue.length) buildQueue();
        if (!queue.length) {
            ui.next.textContent = "No chords or tab notes on this page";
        } else {
            render();
        }
    }

    function closeHud() {
        stopListening();
        hud.style.display = "none";
        document.body.classList.remove("follower-open");
        tabEl.classList.remove("following");
        highlighted.forEach((el) => el.classList.remove("follow-current", "follow-next", "follow-line"));
        highlighted = [];
        tabEl.querySelectorAll(".follow-passed").forEach((el) => el.classList.remove("follow-passed"));
    }

    document.getElementById("listen_toggle")?.addEventListener("click", () => {
        openHud();
        if (!listening && queue.length) startListening();
    });
    ui.listen.addEventListener("click", () => (listening ? stopListening() : startListening()));
    $("#hud_close").addEventListener("click", closeHud);
    $("#hud_collapse").addEventListener("click", () => hud.classList.toggle("collapsed"));
    $("#hud_prev").addEventListener("click", () => moveTo(cursor - 1));
    $("#hud_next_btn").addEventListener("click", () => moveTo(cursor + 1));
    $("#hud_reset").addEventListener("click", () => {
        moveTo(0);
        window.scrollTo({ top: 0, behavior: "smooth" });
    });
    ui.capo.addEventListener("change", () => {
        capo = Number(ui.capo.value);
        computeExpectations();
        render();
    });

    tabEl.addEventListener("click", (event) => {
        if (!tabEl.classList.contains("following")) return;
        const target = event.target.closest(".follow-target");
        if (target) moveTo(Number(target.dataset.followIndex));
    });

    document.addEventListener("freetar:transpose", (event) => {
        transposeSteps = event.detail.steps;
        if (queue.length) {
            computeExpectations();
            render();
        }
    });
}
