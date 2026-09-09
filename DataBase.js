(function () {
	const ACCOUNTS_KEY = "rhythm-rush-accounts";
	const SCORES_KEY = "rhythm-rush-score-database";
	const SESSION_KEY = "rhythm-rush-current-account";
	const REMOTE_RAW_URL = "https://jsonhosting.com/api/json/c1a5c1ad/raw";
	const REMOTE_API_URL = "https://jsonhosting.com/api/json/c1a5c1ad";
	const REMOTE_EDIT_KEY = "1e46b5345d1d853d897bbd7872c89c74dd59d39a49230f14d35367f6b78e0b06";

	function read(key, fallback) {
		try {
			const value = JSON.parse(localStorage.getItem(key));
			return value === null ? fallback : value;
		} catch (error) {
			return fallback;
		}
	}

	function write(key, value) {
		localStorage.setItem(key, JSON.stringify(value));
	}

	async function readRemoteDatabase() {
		const response = await fetch(`${REMOTE_RAW_URL}?t=${Date.now()}`, { cache: "no-store" });
		if (!response.ok) throw new Error(`Remote database read failed (${response.status}).`);
		let data = await response.json();
		if (typeof data === "string") {
			const text = data.trim();
			try {
				data = JSON.parse(text);
			} catch (error) {
				const secondPayload = text.indexOf("]\n[");
				if (secondPayload === -1) throw error;
				data = JSON.parse(text.slice(0, secondPayload + 1));
			}
		}
		if (Array.isArray(data)) {
			return { accounts: data, scores: [] };
		}
		return {
			accounts: Array.isArray(data.accounts) ? data.accounts : [],
			scores: Array.isArray(data.scores) ? data.scores : []
		};
	}

	async function writeRemoteDatabase(data) {
		const response = await fetch(REMOTE_API_URL, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				"X-Edit-Key": REMOTE_EDIT_KEY
			},
			body: JSON.stringify(data)
		});
		if (!response.ok) throw new Error(`Remote database update failed (${response.status}).`);
	}

	async function syncRemoteDatabase(update) {
		try {
			const remote = await readRemoteDatabase();
			const next = update(remote);
			await writeRemoteDatabase(next);
			return next;
		} catch (error) {
			console.warn("Remote database unavailable; local data was kept.", error);
			return null;
		}
	}

	async function hashPassword(password) {
		const bytes = new TextEncoder().encode(password);
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		return Array.from(new Uint8Array(digest))
			.map(byte => byte.toString(16).padStart(2, "0"))
			.join("");
	}

	function cleanName(name) {
		return name.trim().replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 20);
	}

	async function createAccount(name, password) {
		const username = cleanName(name);
		if (username.length < 3) throw new Error("Username must be at least 3 characters.");
		if (password.length < 6) throw new Error("Password must be at least 6 characters.");

		const accounts = read(ACCOUNTS_KEY, {});
		const accountId = username.toLowerCase();
		if (accounts[accountId]) throw new Error("That username already exists.");

		accounts[accountId] = {
			username,
			passwordHash: await hashPassword(password),
			createdAt: Date.now()
		};
		write(ACCOUNTS_KEY, accounts);
		write(SESSION_KEY, username);
		await syncRemoteDatabase(remote => {
			const remoteAccounts = remote.accounts.filter(account => account.username?.toLowerCase() !== accountId);
			remoteAccounts.push(accounts[accountId]);
			return { ...remote, accounts: remoteAccounts };
		});
		return accounts[accountId];
	}

	async function login(name, password) {
		const accountId = name.trim().toLowerCase();
		const accounts = read(ACCOUNTS_KEY, {});
		let account = accounts[accountId];
		if (!account) {
			try {
				const remote = await readRemoteDatabase();
				account = remote.accounts.find(item => item.username?.toLowerCase() === accountId);
				if (account) {
					accounts[accountId] = account;
					write(ACCOUNTS_KEY, accounts);
				}
			} catch (error) {
				console.warn("Could not load remote account.", error);
			}
		}

		const passwordMatches = account && (account.passwordHash
			? account.passwordHash === await hashPassword(password)
			: account.password === password);
		if (!passwordMatches) {
			throw new Error("Username or password is incorrect.");
		}
		write(SESSION_KEY, account.username);
		return account;
	}

	function logout() {
		localStorage.removeItem(SESSION_KEY);
	}

	function getCurrentUser() {
		return localStorage.getItem(SESSION_KEY) || "Guest";
	}

	function recordScore(scoreData) {
		const scores = read(SCORES_KEY, []);
		scores.push({
			username: getCurrentUser(),
			score: Number(scoreData.score) || 0,
			songId: scoreData.songId || "unknown",
			mode: scoreData.mode || "solo",
			accuracy: Number(scoreData.accuracy) || 0,
			maxCombo: Number(scoreData.maxCombo) || 0,
			createdAt: Date.now()
		});
		const record = scores[scores.length - 1];
		write(SCORES_KEY, scores.slice(-500));
		syncRemoteDatabase(remote => ({
			...remote,
			scores: [...remote.scores, record].slice(-500)
		}));
		return record;
	}

	function getLeaderboard(limit = 10) {
		return read(SCORES_KEY, [])
			.sort((first, second) => second.score - first.score)
			.slice(0, Math.min(10, limit));
	}

	async function refreshFromRemote() {
		const remote = await readRemoteDatabase();
		const scores = remote.scores || [];
		write(SCORES_KEY, scores);
		return scores;
	}

	window.RhythmDB = {
		createAccount,
		login,
		logout,
		getCurrentUser,
		recordScore,
		getLeaderboard,
		refreshFromRemote
	};
}());
