const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

// ── LANE CONFIGURATION ──
const LANES = [
    { key: "d", x: 100, color: "#ec4899", label: "D" },
    { key: "f", x: 200, color: "#3b82f6", label: "F" },
    { key: "j", x: 300, color: "#10b981", label: "J" },
    { key: "k", x: 400, color: "#f59e0b", label: "K" }
];

const TARGET_Y = 530;
const NOTE_SPEED = 0.4;
const HIT_WINDOW = 200;

// ── GAME STATE ──
let notes = [];
let originalNotes = [];
let score = 0;
let combo = 0;
let maxCombo = 0;
let totalNotes = 0;
let perfectHits = 0;
let goodHits = 0;
let missCount = 0;
let isPlaying = false;
let gameStartTime = 0;
let audioCtx = null;
let currentSongId = null;
let songAudio = null;
let countdownTimer = null;

// ── VISUAL TIMERS ──
let laneFlashes = [0, 0, 0, 0];

// ── DRAWING ──
function drawLanes() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Flat solid background
    ctx.fillStyle = "#181818";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const now = performance.now();

    LANES.forEach((lane, i) => {
        // Lane separator line
        ctx.strokeStyle = "#272727";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(lane.x - 45, 0);
        ctx.lineTo(lane.x - 45, canvas.height);
        ctx.stroke();

        if (i === LANES.length - 1) {
            ctx.beginPath();
            ctx.moveTo(lane.x + 45, 0);
            ctx.lineTo(lane.x + 45, canvas.height);
            ctx.stroke();
        }

        // Lane flash on press (flat subtle highlight)
        if (laneFlashes[i] > now) {
            const alpha = Math.min(1, (laneFlashes[i] - now) / 120) * 0.15;
            ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
            ctx.fillRect(lane.x - 45, 0, 90, canvas.height);
        }

        // Target receptor circle (flat stroke, NO glow)
        ctx.strokeStyle = lane.color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(lane.x, TARGET_Y, 22, 0, Math.PI * 2);
        ctx.stroke();

        // Key label
        ctx.fillStyle = "#888888";
        ctx.font = "bold 13px 'Outfit', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(lane.label, lane.x, TARGET_Y);
    });

    // Horizontal target line
    ctx.strokeStyle = "#333333";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(50, TARGET_Y);
    ctx.lineTo(450, TARGET_Y);
    ctx.stroke();
}

function drawNote(lane, noteY) {
    const laneData = LANES[lane];

    // Solid flat note (NO shadow blur / glow)
    ctx.fillStyle = laneData.color;
    ctx.beginPath();
    ctx.arc(laneData.x, noteY, 18, 0, Math.PI * 2);
    ctx.fill();

    // Clean subtle white border
    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.lineWidth = 2;
    ctx.stroke();
}

// ── INITIALIZE ──
async function initGame() {
    drawLanes();
    updateRating("READY", "#3b82f6");

    combo = 0;
    maxCombo = 0;
    perfectHits = 0;
    goodHits = 0;
    missCount = 0;
    updateComboUI();

    const btn = document.getElementById("btn");
    if (btn) {
        btn.innerText = "Start Track";
        btn.style.display = "inline-flex";
        btn.onclick = startGame;
    }

    const overlay = document.getElementById("resultsOverlay");
    if (overlay) overlay.classList.remove("visible");

    try {
        const urlParams = new URLSearchParams(window.location.search);
        const songParam = urlParams.get('song') || 'songs/cosmic_hyperdrive.json';
        const isCustom = urlParams.get('custom') === 'true';

        let songData = null;

        if (isCustom) {
            songData = await loadCustomChart();
            if (!songData) {
                const rawCustom = sessionStorage.getItem('custom_chart');
                songData = rawCustom ? JSON.parse(rawCustom) : null;
            }
            if (!songData) throw new Error("No custom chart found.");
        } else {
            const response = await fetch(songParam);
            if (!response.ok) {
                // Fallback to demo_song.json if path not found
                const fallback = await fetch('demo_song.json');
                if (!fallback.ok) throw new Error(`HTTP error! status: ${response.status}`);
                songData = await fallback.json();
            } else {
                songData = await response.json();
            }
        }

        songData = normalizeChart(songData);
        currentSongId = songData.id || songData.songTitle;

        if (songAudio) songAudio.pause();
        songAudio = songData.audioData ? new Audio(songData.audioData) : null;

        const titleEl = document.getElementById("songTitleText");
        if (titleEl) titleEl.innerText = songData.songTitle || "Unknown Track";

        const artistEl = document.getElementById("songArtistText");
        if (artistEl) artistEl.innerText = songData.artist ? `by ${songData.artist}` : "";

        const hs = localStorage.getItem('highscore_' + currentSongId) || 0;
        const hsEl = document.getElementById("highScoreText");
        if (hsEl) hsEl.innerText = hs;

        originalNotes = preparePlaybackNotes(JSON.parse(JSON.stringify(songData.notes)));
        notes = JSON.parse(JSON.stringify(originalNotes));
        totalNotes = originalNotes.length;

        console.log(`Loaded chart: ${songData.songTitle} (${totalNotes} notes)`);
    } catch (error) {
        console.error("Failed to load chart:", error);
        updateRating("LOAD ERROR", "#ef4444");
        if (btn) {
            btn.style.display = "inline-flex";
            btn.innerText = "Retry";
            btn.onclick = initGame;
        }
    }
}

// ── START GAME ──
function startGame() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    if (originalNotes.length > 0) {
        notes = JSON.parse(JSON.stringify(originalNotes));
    }

    const btn = document.getElementById("btn");
    if (btn) btn.style.display = "none";

    const overlay = document.getElementById("resultsOverlay");
    if (overlay) overlay.classList.remove("visible");

    score = 0;
    combo = 0;
    maxCombo = 0;
    perfectHits = 0;
    goodHits = 0;
    missCount = 0;

    updateComboUI();
    document.getElementById("scoreText").innerText = "0";
    clearInterval(countdownTimer);
    let secondsLeft = 3;
    drawCountdown(secondsLeft);
    countdownTimer = setInterval(() => {
        secondsLeft--;
        drawCountdown(secondsLeft);
        if (secondsLeft <= 0) {
            clearInterval(countdownTimer);
            updateRating("GO", "#10b981");
            isPlaying = true;
            gameStartTime = performance.now();
            if (songAudio) {
                songAudio.currentTime = 0;
                songAudio.play().catch(error => console.warn("Chart audio could not start.", error));
            }
            requestAnimationFrame(gameLoop);
        }
    }, 1000);
}

function drawCountdown(secondsLeft) {
    drawLanes();
    ctx.fillStyle = "#f59e0b";
    ctx.font = "bold 48px 'Outfit', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(secondsLeft > 0 ? secondsLeft : "GO!", 250, TARGET_Y - 120);
}

function getPlaybackTime(timestamp) {
    return songAudio ? songAudio.currentTime * 1000 : timestamp - gameStartTime;
}

// ── GAME LOOP ──
function gameLoop(timestamp) {
    if (!isPlaying) return;

    const currentTime = getPlaybackTime(timestamp);

    drawLanes();

    // Draw & update notes
    for (let i = notes.length - 1; i >= 0; i--) {
        const note = notes[i];
        const msRemaining = note.targetTime - currentTime;
        const noteY = TARGET_Y - (msRemaining * NOTE_SPEED);

        // Missed
        if (msRemaining < -HIT_WINDOW) {
            notes.splice(i, 1);
            onMiss();
            continue;
        }

        if (noteY > -25 && noteY < canvas.height + 25) {
            drawNote(note.lane, noteY);
        }
    }

    // Combo counter
    if (combo > 1) {
        ctx.fillStyle = "#f59e0b";
        ctx.font = "bold 24px 'Outfit', sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(`${combo}x`, 250, 50);

        ctx.fillStyle = "#666666";
        ctx.font = "11px 'Outfit', sans-serif";
        ctx.fillText("COMBO", 250, 68);
    }

    // End of track
    if (notes.length === 0) {
        isPlaying = false;
        showResults();
        return;
    }

    requestAnimationFrame(gameLoop);
}

// ── INPUT HANDLING ──
window.addEventListener("keydown", (e) => {
    if (!isPlaying) return;

    const keyHit = e.key.toLowerCase();
    const laneIndex = LANES.findIndex(l => l.key === keyHit);

    if (laneIndex === -1) return;

    laneFlashes[laneIndex] = performance.now() + 120;

    const tapTime = getPlaybackTime(performance.now());
    const noteIndex = notes.findIndex(n => n.lane === laneIndex);

    if (noteIndex !== -1) {
        const note = notes[noteIndex];
        const delta = Math.abs(tapTime - note.targetTime);

        if (delta <= HIT_WINDOW) {
            notes.splice(noteIndex, 1);
            beep(laneIndex, note.pitch);

            if (delta < 40) {
                combo++;
                perfectHits++;
                const bonus = Math.min(combo, 20);
                score += 100 + (bonus * 5);
                updateRating("PERFECT", "#10b981");
            } else if (delta < 100) {
                combo++;
                goodHits++;
                const bonus = Math.min(combo, 20);
                score += 50 + (bonus * 2);
                updateRating("GOOD", "#3b82f6");
            } else {
                onMiss();
            }

            maxCombo = Math.max(maxCombo, combo);
            document.getElementById("scoreText").innerText = score;
            updateComboUI();
        }
    }
});

function onMiss() {
    combo = 0;
    missCount++;
    updateRating("MISS", "#ef4444");
    updateComboUI();
}

// ── RESULTS ──
function showResults() {
    if (songAudio) songAudio.pause();
    saveHighScore();

    const accuracy = totalNotes > 0
        ? Math.round(((perfectHits + goodHits) / totalNotes) * 100)
        : 0;

    if (window.RhythmDB) {
        RhythmDB.recordScore({
            score,
            songId: currentSongId,
            mode: "solo",
            accuracy,
            maxCombo
        });
    }

    let grade = "F";
    let gradeColor = "#ef4444";
    if (accuracy >= 95 && missCount === 0) { grade = "S+"; gradeColor = "#f59e0b"; }
    else if (accuracy >= 90) { grade = "S"; gradeColor = "#f59e0b"; }
    else if (accuracy >= 80) { grade = "A"; gradeColor = "#10b981"; }
    else if (accuracy >= 70) { grade = "B"; gradeColor = "#3b82f6"; }
    else if (accuracy >= 60) { grade = "C"; gradeColor = "#8b5cf6"; }
    else if (accuracy >= 40) { grade = "D"; gradeColor = "#f97316"; }

    updateRating(`GRADE: ${grade}`, gradeColor);

    const overlay = document.getElementById("resultsOverlay");
    if (overlay) {
        document.getElementById("resultGrade").innerText = grade;
        document.getElementById("resultGrade").style.color = gradeColor;
        document.getElementById("resultScore").innerText = score.toLocaleString();
        document.getElementById("resultMaxCombo").innerText = maxCombo + "x";
        document.getElementById("resultPerfects").innerText = perfectHits;
        document.getElementById("resultGoods").innerText = goodHits;
        document.getElementById("resultMisses").innerText = missCount;
        document.getElementById("resultAccuracy").innerText = accuracy + "%";
        overlay.classList.add("visible");
    }

    const btn = document.getElementById("btn");
    if (btn) {
        btn.style.display = "inline-flex";
        btn.innerText = "Play Again";
        btn.onclick = startGame;
    }
}

function saveHighScore() {
    if (currentSongId) {
        const hs = parseInt(localStorage.getItem('highscore_' + currentSongId) || 0);
        if (score > hs) {
            localStorage.setItem('highscore_' + currentSongId, score);
            const hsEl = document.getElementById("highScoreText");
            if (hsEl) hsEl.innerText = score;
            updateRating("NEW HIGH SCORE", "#f59e0b");
        }
    }
}

function updateComboUI() {
    const comboEl = document.getElementById("comboText");
    if (comboEl) {
        comboEl.innerText = combo + "x";
    }
}

function updateRating(text, color) {
    const el = document.getElementById("ratingText");
    if (el) {
        el.innerText = text;
        el.style.color = color;
    }
}

function beep(laneIndex = 0, pitch) {
    if (!audioCtx) return;
    let osc = audioCtx.createOscillator();
    let gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequencyForPitch(pitch, laneIndex), audioCtx.currentTime);
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.1);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.1);
}
