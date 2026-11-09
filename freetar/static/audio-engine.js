import { PitchDetector } from "./vendor/pitchy.js";
import Meyda from "./vendor/meyda.js";

const FFT_SIZE = 4096;
const MIN_HZ = 60;
const MAX_HZ = 1400;
const ONSET_HISTORY = 8;
const ONSET_RATIO = 1.8;
const ONSET_FLOOR = 0.01;

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
export const midiToName = (midi) => {
    const rounded = Math.round(midi);
    return NOTE_NAMES[((rounded % 12) + 12) % 12] + (Math.floor(rounded / 12) - 1);
};

/**
 * One microphone + analyser per page. Consumers call `acquire(owner)` / `release(owner)`
 * and `subscribe(fn)`; every animation frame each subscriber gets
 * `{hz, clarity, rms, chroma, onset, time}` (`hz` is null when no clear pitch).
 */
class AudioEngine {
    constructor() {
        this.listeners = new Set();
        this.owners = new Set();
        this.wantsChroma = 0;
        this.rmsHistory = [];
        this.running = false;
    }

    async acquire(owner) {
        this.owners.add(owner);
        if (!this.running) {
            await this.start();
        }
    }

    release(owner) {
        this.owners.delete(owner);
        if (this.owners.size === 0) {
            this.stop();
        }
    }

    subscribe(fn, { chroma = false } = {}) {
        const entry = { fn, chroma };
        this.listeners.add(entry);
        if (chroma) this.wantsChroma++;
        return () => {
            if (this.listeners.delete(entry) && chroma) this.wantsChroma--;
        };
    }

    async start() {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
            throw new Error(
                "The microphone only works on a secure page. Open this site via https (port 8443) or on localhost."
            );
        }
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
            });
        } catch (err) {
            if (err.name === "NotAllowedError") {
                throw new Error("Microphone access was blocked. Allow it in your browser's site settings and try again.");
            }
            throw new Error(`Could not open the microphone: ${err.message}`);
        }

        this.context = new AudioContext();
        await this.context.resume();
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = FFT_SIZE;
        this.analyser.smoothingTimeConstant = 0;
        this.context.createMediaStreamSource(this.stream).connect(this.analyser);

        this.buffer = new Float32Array(FFT_SIZE);
        this.detector = PitchDetector.forFloat32Array(FFT_SIZE);
        Meyda.bufferSize = FFT_SIZE;
        Meyda.sampleRate = this.context.sampleRate;

        this.running = true;
        this.loop();
    }

    stop() {
        if (!this.running) return;
        this.running = false;
        cancelAnimationFrame(this.frameRequest);
        this.stream.getTracks().forEach((track) => track.stop());
        this.context.close();
        this.rmsHistory = [];
    }

    loop() {
        if (!this.running) return;
        this.frameRequest = requestAnimationFrame(() => this.loop());

        this.analyser.getFloatTimeDomainData(this.buffer);
        const frame = this.analyse(this.buffer);
        for (const { fn } of this.listeners) {
            fn(frame);
        }
    }

    analyse(buffer) {
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
        const rms = Math.sqrt(sum / buffer.length);

        let [hz, clarity] = this.detector.findPitch(buffer, this.context.sampleRate);
        if (!(hz >= MIN_HZ && hz <= MAX_HZ)) {
            hz = null;
        }

        const chroma = this.wantsChroma > 0 ? Meyda.extract("chroma", buffer) : null;

        // only the first frame of an attack counts as an onset
        const quietest = this.rmsHistory.length ? Math.min(...this.rmsHistory) : rms;
        const rising = rms > ONSET_FLOOR && rms > quietest * ONSET_RATIO;
        const onset = rising && !this.wasRising;
        this.wasRising = rising;
        this.rmsHistory.push(rms);
        if (this.rmsHistory.length > ONSET_HISTORY) this.rmsHistory.shift();

        return { hz, clarity, rms, chroma, onset, time: performance.now() };
    }
}

export const audioEngine = new AudioEngine();
