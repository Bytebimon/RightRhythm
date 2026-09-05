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
const GAME_PREFIX = "rhythm-rush-v1-";
const LEADERBOARD_KEY = "rhythm-rush-online-leaderboard";

// ── GAMEPLAY STATE ──
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
let songAudio = null;
let currentSongParam = "songs/cosmic_hyperdrive.json";
let countdownTimer = null;
let myFinished = false;
let matchFinalized = false;
let localRating = "READY";

// ── OPPONENT STATE ──
let oppScore = 0;
let oppCombo = 0;
let oppMaxCombo = 0;
let oppAccuracy = 0;
let oppFinished = false;

// ── MULTIPLAYER PEERJS STATE ──
let peer = null;
let connection = null;
let isHost = false;
let roomCode = "";

// ── VISUAL TIMERS ──
let laneFlashes = [0, 0, 0, 0];

// ──────────────────────────────────────────
// PEERJS NETWORKING
// ──────────────────────────────────────────

function setNetworkStatus(text, color = "var(--text-secondary)") {
    const el = document.getElementById("networkStatus");
    if (el) {
        el.innerText = text;
        el.style.color = color;
    }
}

function setRoleBadge(text) {
    const badge = document.getElementById("roleBadge");
    if (badge) badge.innerText = text;
}

// 1. Host Match
function hostOnlineGame() {
    roomCode = Math.floor(1000 + Math.random() * 9000).toString();
    isHost = true;

    setNetworkStatus("Registering room...", "var(--accent-yellow)");
    document.getElementById("lobbyInitial").style.display = "none";
    document.getElementById("hostWaitBox").style.display = "block";
    document.getElementById("displayRoomCode").innerText = roomCode;
    setRoleBadge("Role: Host");

    try {
        peer = new Peer(GAME_PREFIX + roomCode);

        peer.on('open', () => {
            setNetworkStatus("Room active. Waiting for opponent...", "var(--accent-yellow)");
        });

        peer.on('error', (err) => {
            console.error("PeerJS error:", err);
            setNetworkStatus("Error: " + (err.type || err.message), "#ef4444");
        });

        peer.on('connection', (conn) => {
            connection = conn;
            setupConnectionHandlers();

            // Notify UI
            document.getElementById("hostWaitBox").style.display = "none";
            document.getElementById("lobbyMatchControls").style.display = "block";
            document.getElementById("btnStartOnline").style.display = "inline-flex";
            document.getElementById("matchReadyText").innerText = "Opponent connected! Click below to start.";
            setNetworkStatus("Connected with opponent", "var(--accent-green)");

            // Send chart configuration to client
            connection.send({
                type: "INIT_SONG",
                songParam: currentSongParam
            });
        });
    } catch (err) {
        console.error("Failed to host game:", err);
        setNetworkStatus("Failed to initialize matchmaker", "#ef4444");
    }
}

// 2. Join Match
function joinOnlineGame() {
    const code = document.getElementById("joinCodeInput").value.trim();
    if (code.length !== 4) {
        alert("Please enter a valid 4-digit room code.");
        return;
    }

    roomCode = code;
    isHost = false;
    setRoleBadge("Role: Client");
    setNetworkStatus(`Connecting to room ${code}...`, "var(--accent-yellow)");
    document.getElementById("lobbyInitial").style.display = "none";

    try {
        peer = new Peer();

        peer.on('open', () => {
            connection = peer.connect(GAME_PREFIX + code);
            setupConnectionHandlers();
        });

        peer.on('error', (err) => {
            console.error("PeerJS client error:", err);
            setNetworkStatus("Could not connect to room: " + (err.type || err.message), "#ef4444");
            document.getElementById("lobbyInitial").style.display = "flex";
        });
    } catch (err) {
        console.error("Failed to join game:", err);
        setNetworkStatus("Failed to initialize connection", "#ef4444");
        document.getElementById("lobbyInitial").style.display = "flex";
    }
}

function setupConnectionHandlers() {
    if (!connection) return;

    connection.on('open', () => {
        setNetworkStatus("Connected to host!", "var(--accent-green)");
        document.getElementById("lobbyMatchControls").style.display = "block";

        if (!isHost) {
            document.getElementById("clientWaitMsg").style.display = "block";
            document.getElementById("matchReadyText").innerText = "Connected to host. Waiting for match start...";
        }
    });

    connection.on('data', (data) => {
        handleIncomingNetworkData(data);
    });

    connection.on('close', () => {
        setNetworkStatus("Opponent disconnected", "#ef4444");
        alert("Your opponent disconnected from the match.");
        disconnectOnline();
    });

    connection.on('error', (err) => {
        console.error("Connection error:", err);
        setNetworkStatus("Connection error", "#ef4444");
    });
}

function handleIncomingNetworkData(data) {
    if (!data || !data.type) return;

    switch (data.type) {
        case "INIT_SONG":
            if (data.songParam) {
                currentSongParam = data.songParam;
                loadOnlineChart(currentSongParam);
            }
            break;

        case "START_COUNTDOWN":
            startSynchronizedMatch(data.startDelayMs || 3000);
            break;

        case "SCORE_UPDATE":
            oppScore = data.score || 0;
            oppCombo = data.combo || 0;
            oppMaxCombo = Math.max(oppMaxCombo, data.maxCombo || 0);
            updateOpponentUI(data.rating || "READY");
            renderLiveLeaderboard();
            break;

        case "PLAYER_FINISH":
            oppFinished = true;
            oppScore = data.score || oppScore;
            oppMaxCombo = data.maxCombo || oppMaxCombo;
            oppAccuracy = data.accuracy || 0;
            updateOpponentUI("FINISH");
            checkBothFinished();
            break;

        case "REMATCH_REQUEST":
            startSynchronizedMatch(2000);
            break;
    }
}

function sendNetworkUpdate(msg) {
    if (connection && connection.open) {
        try {
            connection.send(msg);
        } catch (e) {
            console.error("Error sending network data:", e);
        }
    }
}

function requestStartMatch() {
    if (!isHost) return;
    const startDelayMs = 3000;
    sendNetworkUpdate({
        type: "START_COUNTDOWN",
        startDelayMs: startDelayMs
    });
    startSynchronizedMatch(startDelayMs);
}

function requestRematch() {
    sendNetworkUpdate({ type: "REMATCH_REQUEST" });
    startSynchronizedMatch(2000);
}

function disconnectOnline() {
    isPlaying = false;
    if (connection) {
        try { connection.close(); } catch (e) {}
        connection = null;
    }
    if (peer) {
        try { peer.destroy(); } catch (e) {}
        peer = null;
    }

    document.getElementById("resultsOverlay").classList.remove("visible");
    document.getElementById("gamePlayContainer").style.display = "none";
    document.getElementById("lobbyScreen").style.display = "block";
    document.getElementById("lobbyInitial").style.display = "flex";
    document.getElementById("hostWaitBox").style.display = "none";
    document.getElementById("lobbyMatchControls").style.display = "none";
    setNetworkStatus("Disconnected", "var(--text-secondary)");
    setRoleBadge("Status: Idle");
}

// ──────────────────────────────────────────
// GAMEPLAY ENGINE
// ──────────────────────────────────────────

async function loadOnlineChart(path) {
    try {
        let res = await fetch(path);
        if (!res.ok) {
            res = await fetch('demo_song.json');
        }
        const data = normalizeChart(await res.json());
        if (songAudio) songAudio.pause();
        songAudio = data.audioData ? new Audio(data.audioData) : null;
        originalNotes = preparePlaybackNotes(JSON.parse(JSON.stringify(data.notes)));
        notes = JSON.parse(JSON.stringify(originalNotes));
        totalNotes = originalNotes.length;

        const titleEl = document.getElementById("songTitleText");
        if (titleEl) titleEl.innerText = data.songTitle || "1v1 Match";

        const artistEl = document.getElementById("songArtistText");
        if (artistEl) artistEl.innerText = data.artist ? `by ${data.artist}` : "Multiplayer";

        console.log("Loaded online chart:", data.songTitle);
    } catch (e) {
        console.error("Failed to load chart:", e);
    }
}

function startSynchronizedMatch(delayMs) {
    document.getElementById("resultsOverlay").classList.remove("visible");
    document.getElementById("lobbyScreen").style.display = "none";
    const gameContainer = document.getElementById("gamePlayContainer");
    gameContainer.style.display = "flex";

    // Reset local stats
    score = 0;
    combo = 0;
    maxCombo = 0;
    perfectHits = 0;
    goodHits = 0;
    missCount = 0;
    myFinished = false;
    matchFinalized = false;
    localRating = "READY";

    // Reset opponent stats
    oppScore = 0;
    oppCombo = 0;
    oppMaxCombo = 0;
    oppAccuracy = 0;
    oppFinished = false;

    updateLocalUI("READY");
    updateOpponentUI("READY");
    renderLiveLeaderboard();

    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    if (originalNotes.length > 0) {
        notes = JSON.parse(JSON.stringify(originalNotes));
    }

    drawLanes();

    // Countdown before start
    let secondsLeft = Math.round(delayMs / 1000);
    drawCountdown(secondsLeft);

    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
        secondsLeft--;
        if (secondsLeft > 0) {
            drawCountdown(secondsLeft);
        } else {
            clearInterval(countdownTimer);
            isPlaying = true;
            gameStartTime = performance.now();
            if (songAudio) {
                songAudio.currentTime = 0;
                songAudio.play().catch(error => console.warn("Chart audio could not start.", error));
            }
            updateLocalUI("GO");
            requestAnimationFrame(gameLoop);
        }
    }, 1000);
}

function drawCountdown(num) {
    drawLanes();
    ctx.fillStyle = "#f59e0b";
    ctx.font = "bold 48px 'Outfit', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(num > 0 ? num : "GO!", 250, TARGET_Y - 120);
}

function drawLanes() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "#181818";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const now = performance.now();

    LANES.forEach((lane, i) => {
        // Lane separator
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

        // Lane flash
        if (laneFlashes[i] > now) {
            const alpha = Math.min(1, (laneFlashes[i] - now) / 120) * 0.15;
            ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
            ctx.fillRect(lane.x - 45, 0, 90, canvas.height);
        }

        // Target receptor
        ctx.strokeStyle = lane.color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(lane.x, TARGET_Y, 22, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = "#888888";
        ctx.font = "bold 13px 'Outfit', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(lane.label, lane.x, TARGET_Y);
    });

    // Target line
    ctx.strokeStyle = "#333333";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(50, TARGET_Y);
    ctx.lineTo(450, TARGET_Y);
    ctx.stroke();
}

function drawNote(lane, noteY) {
    const laneData = LANES[lane];
    ctx.fillStyle = laneData.color;
    ctx.beginPath();
    ctx.arc(laneData.x, noteY, 18, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.lineWidth = 2;
    ctx.stroke();
}

function getPlaybackTime(timestamp) {
    return songAudio ? songAudio.currentTime * 1000 : timestamp - gameStartTime;
}

// ── RENDER LOOP ──
function gameLoop(timestamp) {
    if (!isPlaying) return;

    const currentTime = getPlaybackTime(timestamp);

    drawLanes();

    for (let i = notes.length - 1; i >= 0; i--) {
        const note = notes[i];
        const msRemaining = note.targetTime - currentTime;
        const noteY = TARGET_Y - (msRemaining * NOTE_SPEED);

        if (msRemaining < -HIT_WINDOW) {
            notes.splice(i, 1);
            onMiss();
            continue;
        }

        if (noteY > -25 && noteY < canvas.height + 25) {
            drawNote(note.lane, noteY);
        }
    }

    if (combo > 1) {
        ctx.fillStyle = "#f59e0b";
        ctx.font = "bold 24px 'Outfit', sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(`${combo}x`, 250, 50);

        ctx.fillStyle = "#666666";
        ctx.font = "11px 'Outfit', sans-serif";
        ctx.fillText("COMBO", 250, 68);
    }

    // Finished track
    if (notes.length === 0) {
        isPlaying = false;
        myFinished = true;

        const myAccuracy = totalNotes > 0
            ? Math.round(((perfectHits + goodHits) / totalNotes) * 100)
            : 0;

        sendNetworkUpdate({
            type: "PLAYER_FINISH",
            score: score,
            maxCombo: maxCombo,
            accuracy: myAccuracy
        });

        updateLocalUI("FINISH");
        checkBothFinished();
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

            let rating = "MISS";
            if (delta < 40) {
                combo++;
                perfectHits++;
                const bonus = Math.min(combo, 20);
                score += 100 + (bonus * 5);
                rating = "PERFECT";
            } else if (delta < 100) {
                combo++;
                goodHits++;
                const bonus = Math.min(combo, 20);
                score += 50 + (bonus * 2);
                rating = "GOOD";
            } else {
                onMiss();
                return;
            }

            maxCombo = Math.max(maxCombo, combo);
            updateLocalUI(rating);

            // Transmit live update over PeerJS
            sendNetworkUpdate({
                type: "SCORE_UPDATE",
                score: score,
                combo: combo,
                maxCombo: maxCombo,
                rating: rating
            });
        }
    }
});

function onMiss() {
    combo = 0;
    missCount++;
    updateLocalUI("MISS");

    sendNetworkUpdate({
        type: "SCORE_UPDATE",
        score: score,
        combo: combo,
        maxCombo: maxCombo,
        rating: "MISS"
    });
}

function updateLocalUI(rating) {
    localRating = rating;
    const scoreEl = document.getElementById("scoreText");
    const comboEl = document.getElementById("comboText");
    const ratingEl = document.getElementById("ratingText");

    if (scoreEl) scoreEl.innerText = score.toLocaleString();
    if (comboEl) comboEl.innerText = `${combo}x`;
    if (ratingEl) {
        ratingEl.innerText = rating;
        if (rating === "PERFECT") ratingEl.style.color = "#10b981";
        else if (rating === "GOOD") ratingEl.style.color = "#3b82f6";
        else if (rating === "MISS") ratingEl.style.color = "#ef4444";
    }
    renderLiveLeaderboard();
}

function updateOpponentUI(rating) {
    const oppScoreEl = document.getElementById("oppScoreText");
    const oppComboEl = document.getElementById("oppComboText");
    const oppRatingEl = document.getElementById("oppRatingText");

    if (oppScoreEl) oppScoreEl.innerText = oppScore.toLocaleString();
    if (oppComboEl) oppComboEl.innerText = `${oppCombo}x`;
    if (oppRatingEl) {
        oppRatingEl.innerText = rating;
        if (rating === "PERFECT") oppRatingEl.style.color = "#10b981";
        else if (rating === "GOOD") oppRatingEl.style.color = "#3b82f6";
        else if (rating === "MISS") oppRatingEl.style.color = "#ef4444";
    }
    renderLiveLeaderboard();
}

function renderLiveLeaderboard() {
    const list = document.getElementById("liveLeaderboardList");
    if (!list) return;

    const players = [
        { name: "You", score, combo, rating: localRating, className: "you" },
        { name: "Opponent", score: oppScore, combo: oppCombo, rating: "", className: "opponent" }
    ].sort((first, second) => second.score - first.score);

    list.innerHTML = players.map((player, index) => `
        <li class="live-player ${player.className}">
            <span class="live-rank">${index + 1}</span>
            <span class="live-player-name">${player.name}</span>
            <span class="live-player-combo">${player.combo}x${player.rating ? ` · ${player.rating}` : ""}</span>
            <strong>${player.score.toLocaleString()}</strong>
        </li>
    `).join("");
}

// ── MATCH COMPLETION ──
function checkBothFinished() {
    if (!myFinished) return;

    // If opponent hasn't finished, wait up to 4 seconds, then finalize
    if (!oppFinished) {
        setTimeout(() => {
            finalizeMatchResults();
        }, 3500);
    } else {
        finalizeMatchResults();
    }
}

function finalizeMatchResults() {
    if (matchFinalized) return;
    matchFinalized = true;
    if (songAudio) songAudio.pause();

    const myAccuracy = totalNotes > 0
        ? Math.round(((perfectHits + goodHits) / totalNotes) * 100)
        : 0;

    const overlay = document.getElementById("resultsOverlay");
    const outcomeEl = document.getElementById("matchOutcomeGrade");
    const titleEl = document.getElementById("matchOutcomeTitle");

    document.getElementById("resultScore").innerText = score.toLocaleString();
    document.getElementById("resultOppScore").innerText = oppScore.toLocaleString();
    document.getElementById("resultMaxCombo").innerText = maxCombo + "x";
    document.getElementById("resultOppCombo").innerText = oppMaxCombo + "x";
    document.getElementById("resultAccuracy").innerText = myAccuracy + "%";
    document.getElementById("resultOppAccuracy").innerText = (oppAccuracy || 0) + "%";
    if (window.RhythmDB) {
        RhythmDB.recordScore({
            score,
            songId: currentSongParam,
            mode: "online",
            accuracy: myAccuracy,
            maxCombo
        });
    }
    saveLeaderboardScore(score);

    if (score > oppScore) {
        outcomeEl.innerText = "VICTORY";
        outcomeEl.style.color = "#10b981";
        titleEl.innerText = "You Won The Match!";
    } else if (score < oppScore) {
        outcomeEl.innerText = "DEFEAT";
        outcomeEl.style.color = "#ef4444";
        titleEl.innerText = "Opponent Won!";
    } else {
        outcomeEl.innerText = "DRAW";
        outcomeEl.style.color = "#f59e0b";
        titleEl.innerText = "Equal Score!";
    }

    if (overlay) overlay.classList.add("visible");
}

function getLeaderboardScores() {
    try {
        const scores = JSON.parse(localStorage.getItem(LEADERBOARD_KEY) || "[]");
        return Array.isArray(scores) ? scores : [];
    } catch (e) {
        return [];
    }
}

function saveLeaderboardScore(newScore) {
    const scores = getLeaderboardScores();
    scores.push({ name: "You", score: newScore, date: Date.now() });
    scores.sort((a, b) => b.score - a.score);
    localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(scores.slice(0, 10)));
    renderLeaderboard();
}

function renderLeaderboard() {
    const list = document.getElementById("leaderboardList");
    if (!list) return;

    const scores = getLeaderboardScores();
    list.innerHTML = scores.length
        ? scores.map((entry, index) => `<li><span>${index + 1}. ${entry.name}</span><strong>${Number(entry.score).toLocaleString()}</strong></li>`).join("")
        : "<li class=\"leaderboard-empty\">Finish a match to post a score.</li>";
}

// ── AUDIO ──
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

// Initialize on page load
window.addEventListener("DOMContentLoaded", () => {
    loadOnlineChart(currentSongParam);
    renderLeaderboard();
    renderLiveLeaderboard();
});
