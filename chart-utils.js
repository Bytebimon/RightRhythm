const RHYTHM_LANES = [
    { key: "d", letter: "D", pitch: "C4", frequency: 261.63 },
    { key: "f", letter: "F", pitch: "E4", frequency: 329.63 },
    { key: "j", letter: "J", pitch: "G4", frequency: 392.00 },
    { key: "k", letter: "K", pitch: "A4", frequency: 440.00 }
];
const NOTE_TRAVEL_MS = 1400;

function preparePlaybackNotes(notes) {
    return notes.map(note => ({
        ...note,
        targetTime: note.targetTime + NOTE_TRAVEL_MS
    }));
}

function laneIndexFromValue(value) {
    if (typeof value === "number" && Number.isInteger(value)) {
        return Math.max(0, Math.min(RHYTHM_LANES.length - 1, value));
    }

    const text = String(value || "").trim().toLowerCase();
    const byKey = RHYTHM_LANES.findIndex(lane => lane.key === text || lane.letter.toLowerCase() === text);
    return byKey === -1 ? 0 : byKey;
}

function normalizeChart(chart) {
    const sourceNotes = Array.isArray(chart.notes) ? chart.notes : [];
    return {
        ...chart,
        notes: sourceNotes
            .map((note, index) => {
                const lane = laneIndexFromValue(note.lane ?? note.letter ?? note.key);
                const laneData = RHYTHM_LANES[lane];
                return {
                    ...note,
                    lane,
                    letter: laneData.letter,
                    pitch: note.pitch || laneData.pitch,
                    targetTime: Math.max(0, Number(note.targetTime) || index * 500),
                    duration: Math.max(1, Number(note.duration) || 200)
                };
            })
            .sort((first, second) => first.targetTime - second.targetTime)
    };
}

function createTrebleNotes(audioBuffer, difficulty) {
    const difficultyValue = Math.max(1, Math.min(10, Number(difficulty) || 5));
    const channel = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const frameSize = Math.max(512, Math.floor(sampleRate * 0.025));
    const hopSize = Math.max(256, Math.floor(frameSize / 2));
    const flux = [];

    for (let offset = 0; offset + frameSize < channel.length; offset += hopSize) {
        let highFrequencyEnergy = 0;
        let totalEnergy = 0;
        for (let index = offset + 1; index < offset + frameSize; index += 2) {
            const sample = channel[index];
            totalEnergy += sample * sample;
            highFrequencyEnergy += Math.abs(sample - channel[index - 1]);
        }
        flux.push({
            time: Math.round((offset / sampleRate) * 1000),
            value: highFrequencyEnergy / (frameSize / 2),
            energy: Math.sqrt(totalEnergy / (frameSize / 2))
        });
    }

    const values = flux.map(frame => frame.value).sort((first, second) => first - second);
    const median = values[Math.floor(values.length / 2)] || 0;
    const threshold = Math.max(median * 1.35, 0.0015);
    const minimumGap = Math.round(800 - difficultyValue * 65);
    const notes = [];
    let lastTime = -minimumGap;

    flux.forEach((frame, index) => {
        const previous = flux[index - 1]?.value || 0;
        const next = flux[index + 1]?.value || 0;
        const isPeak = frame.value >= previous && frame.value >= next;
        if (!isPeak || frame.value < threshold || frame.energy < 0.008 || frame.time - lastTime < minimumGap) return;

        const lane = notes.length % RHYTHM_LANES.length;
        notes.push({
            lane,
            letter: RHYTHM_LANES[lane].letter,
            pitch: RHYTHM_LANES[lane].pitch,
            targetTime: frame.time,
            duration: 160
        });
        lastTime = frame.time;
    });

    return notes;
}

function frequencyForPitch(pitch, lane = 0) {
    if (typeof pitch === "number" && Number.isFinite(pitch)) return pitch;
    const pitchText = String(pitch || "").toUpperCase();
    const knownPitch = {
        C4: 261.63,
        D4: 293.66,
        E4: 329.63,
        F4: 349.23,
        G4: 392.00,
        A4: 440.00,
        B4: 493.88
    }[pitchText];
    if (knownPitch) return knownPitch;
    const match = pitchText.match(/^([A-G])(#?)(-?\d+)$/);
    if (match) {
        const semitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
        const midiNote = (Number(match[3]) + 1) * 12 + semitones[match[1]] + (match[2] ? 1 : 0);
        return midiPitchFrequency(midiNote);
    }
    return RHYTHM_LANES[laneIndexFromValue(lane)].frequency;
}

function midiPitchName(midiNote) {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    return `${names[midiNote % 12]}${Math.floor(midiNote / 12) - 1}`;
}

function midiPitchFrequency(midiNote) {
    return 440 * Math.pow(2, (midiNote - 69) / 12);
}

function readMidiVariable(data, cursor) {
    let value = 0;
    let byte;
    do {
        byte = data[cursor.index++];
        value = (value << 7) | (byte & 0x7f);
    } while (byte & 0x80);
    return value;
}

function parseMidiChart(arrayBuffer, metadata = {}) {
    const data = new Uint8Array(arrayBuffer);
    const textAt = (start, length) => String.fromCharCode(...data.slice(start, start + length));
    if (textAt(0, 4) !== "MThd") throw new Error("This is not a Standard MIDI file.");

    const read16 = offset => (data[offset] << 8) | data[offset + 1];
    const read32 = offset => ((data[offset] << 24) >>> 0) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
    const headerLength = read32(4);
    const trackCount = read16(10);
    const ticksPerBeat = read16(12);
    let offset = 8 + headerLength;
    let tempo = 500000;
    const tempoEvents = [{ tick: 0, tempo }];
    const events = [];
    const noteOffs = [];

    for (let track = 0; track < trackCount; track++) {
        if (textAt(offset, 4) !== "MTrk") throw new Error("Invalid MIDI track.");
        const trackLength = read32(offset + 4);
        const end = offset + 8 + trackLength;
        offset += 8;
        let tick = 0;
        let runningStatus = 0;

        while (offset < end) {
            tick += readMidiVariable(data, { get index() { return offset; }, set index(value) { offset = value; } });
            let status = data[offset++];
            if (status < 0x80) {
                offset--;
                status = runningStatus;
            } else if (status < 0xf0) {
                runningStatus = status;
            }

            if (status === 0xff) {
                const type = data[offset++];
                const length = readMidiVariable(data, { get index() { return offset; }, set index(value) { offset = value; } });
                if (type === 0x51 && length === 3) {
                    tempo = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
                    tempoEvents.push({ tick, tempo });
                }
                offset += length;
                continue;
            }
            if (status === 0xf0 || status === 0xf7) {
                offset += readMidiVariable(data, { get index() { return offset; }, set index(value) { offset = value; } });
                continue;
            }

            const command = status & 0xf0;
            const note = data[offset++];
            const velocity = data[offset++];
            const channel = status & 0x0f;
            if (command === 0x90 && velocity > 0) events.push({ tick, note, velocity, channel });
            if (command === 0x80 || (command === 0x90 && velocity === 0)) noteOffs.push({ tick, note, channel });
        }
        offset = end;
    }

    events.sort((first, second) => first.tick - second.tick);
    tempoEvents.sort((first, second) => first.tick - second.tick);
    const starts = new Map();
    events.forEach(event => {
        const key = `${event.channel}:${event.note}`;
        if (!starts.has(key)) starts.set(key, []);
        starts.get(key).push(event);
    });
    noteOffs.sort((first, second) => first.tick - second.tick).forEach(noteOff => {
        const queue = starts.get(`${noteOff.channel}:${noteOff.note}`);
        const noteOn = queue && queue.shift();
        if (noteOn) noteOn.durationTicks = Math.max(1, noteOff.tick - noteOn.tick);
    });
    const tickToMs = tick => {
        let elapsed = 0;
        let previousTick = 0;
        let currentTempo = tempoEvents[0].tempo;
        tempoEvents.forEach(change => {
            if (change.tick >= tick) return;
            elapsed += (change.tick - previousTick) * currentTempo / 1000 / ticksPerBeat;
            previousTick = change.tick;
            currentTempo = change.tempo;
        });
        return elapsed + (tick - previousTick) * currentTempo / 1000 / ticksPerBeat;
    };
    return normalizeChart({
        id: `midi_${Date.now()}`,
        songTitle: metadata.songTitle || "MIDI Song",
        artist: metadata.artist || "Player",
        bpm: Math.round(60000000 / tempo),
        difficulty: metadata.difficulty || "5/10",
        audioData: metadata.audioData || "",
        audioFileName: metadata.audioFileName || "",
        notes: events.map((event, index) => {
            const lane = event.note % RHYTHM_LANES.length;
            return {
                lane,
                letter: RHYTHM_LANES[lane].letter,
                midiNote: event.note,
                pitch: midiPitchName(event.note),
                frequency: midiPitchFrequency(event.note),
                targetTime: Math.round(tickToMs(event.tick)),
                duration: Math.max(1, Math.round(tickToMs(event.tick + (event.durationTicks || ticksPerBeat / 4)) - tickToMs(event.tick))),
                velocity: event.velocity
            };
        })
    });
}

function saveCustomChart(chart) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("rhythm-rush-charts", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("charts");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const transaction = request.result.transaction("charts", "readwrite");
            transaction.objectStore("charts").put(chart, "latest");
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
        };
    });
}

function loadCustomChart() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("rhythm-rush-charts", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("charts");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const transaction = request.result.transaction("charts", "readonly");
            const getRequest = transaction.objectStore("charts").get("latest");
            getRequest.onsuccess = () => resolve(getRequest.result || null);
            getRequest.onerror = () => reject(getRequest.error);
        };
    });
}
