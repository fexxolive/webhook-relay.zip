//+------------------------------------------------------------------+
//| WEBHOOK SERVER - v4.3 USER-WISE STORE + BROADCAST (FIX B)
//| TradingView + MT5 EA Integration | Token in Query Parameter
//| FIXED: Signals are stored per-user_id so multi EA can't steal signals
//| NEW: 1 TradingView alert can broadcast to multiple user_ids via user_ids[]
//+------------------------------------------------------------------+

const express = require('express');
const https = require('https');
const fs = require('fs');
const app = express();

// ==================== CONFIGURATION ====================
const SECRET_TOKEN = process.env.WEBHOOK_SECRET_TOKEN || "37ehADKNLy5psq1IvdUDYshxxik_zuy2RYD72n7E858DYqR2";
const HOST = "0.0.0.0";
const PORT = process.env.PORT || 8443;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || "cert.pem";
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || "key.pem";

// ==================== MIDDLEWARE ====================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log("[" + timestamp + "] " + req.method + " " + req.path);
    console.log("  Query: " + JSON.stringify(req.query));
    console.log("  Body: " + JSON.stringify(req.body).substring(0, 150));
    next();
});

// Custom error handler - prevent HTML error pages
app.use((err, req, res, next) => {
    console.log("  ERROR: " + err.message);
    res.status(400).json({
        status: "error",
        message: err.message,
        timestamp: new Date().toISOString()
    });
});

// ==================== SIGNAL STORAGE (PER USER) ====================

function emptySignal() {
    return {
        signal: 0,
        symbol: "",
        timestamp: null,
        action: "",
        id: "",
        price: "",
        timeframe: "",
        user_id: ""
    };
}

// ✅ per-user latest signals
const latest_signal_by_user = Object.create(null); // { "user_Asheen": {...}, "user_Ameen": {...} }

const signal_history = [];
const MAX_HISTORY = 50;

// ==================== UTILITY FUNCTIONS ====================

function logSignal(signal_obj) {
    signal_history.push({
        signal: signal_obj.signal,
        symbol: signal_obj.symbol,
        action: signal_obj.action,
        id: signal_obj.id,
        user_id: signal_obj.user_id || "",
        receivedAt: new Date().toISOString()
    });

    if (signal_history.length > MAX_HISTORY) {
        signal_history.shift();
    }

    console.log("[SIGNAL-STORED] " + signal_obj.action + " | " + signal_obj.symbol + " | ID: " + signal_obj.id + " | USER: " + (signal_obj.user_id || "N/A"));
}

function validateToken(req) {
    // Method C: Token from URL query parameter
    const token = req.query.token || "";
    const isValid = token === SECRET_TOKEN;

    if (!isValid) {
        console.log("  Token validation FAILED | Received: " + token.substring(0, 10) + "...");
    } else {
        console.log("  Token validation SUCCESS");
    }

    return isValid;
}

function sanitize(str) {
    if (typeof str === 'string') {
        return str.trim().toUpperCase();
    }
    return "";
}

// ✅ user_id sanitize (DON'T uppercase because "user_Asheen" case matters)
function sanitizeUserId(str) {
    if (typeof str === 'string') {
        return str.trim();
    }
    return "";
}

function generateSignalId() {
    return Date.now() + "_" + Math.random().toString(36).substr(2, 9);
}

function hasPendingAnyUser() {
    return Object.keys(latest_signal_by_user).some(uid => latest_signal_by_user[uid] && latest_signal_by_user[uid].signal !== 0);
}

function getPendingUsers() {
    return Object.keys(latest_signal_by_user).filter(uid => latest_signal_by_user[uid] && latest_signal_by_user[uid].signal !== 0);
}

// ==================== MAIN GET ENDPOINT (METHOD C) ====================

/**
 * GET /get_signal
 * MT5 EA retrieves signals using:
 * /get_signal?token=YOUR_TOKEN&user_id=user_Asheen
 */
app.get("/get_signal", (req, res) => {
    console.log("  GET /get_signal endpoint called (METHOD C)");

    // Validate token from URL query parameter
    if (!validateToken(req)) {
        console.log("  REJECTING request - invalid token");
        return res.status(401).json({
            status: "unauthorized",
            message: "Invalid or missing token in URL",
            example: "/get_signal?token=YOUR_TOKEN_HERE&user_id=user_Asheen",
            timestamp: new Date().toISOString()
        });
    }

    // ✅ REQUIRED: user_id for multi-user safety
    const requested_user_id = sanitizeUserId(req.query.user_id || "");
    if (!requested_user_id) {
        console.log("  Missing user_id in query - returning no_signal (safe)");
        return res.status(200).json({
            status: "no_signal",
            signal: 0,
            symbol: "",
            id: ""
        });
    }

    if (!latest_signal_by_user[requested_user_id]) {
        latest_signal_by_user[requested_user_id] = emptySignal();
    }

    const bucket = latest_signal_by_user[requested_user_id];

    console.log("  Token accepted - checking for pending signals for USER: " + requested_user_id);

    if (bucket.signal !== 0) {
        const signal_to_send = { ...bucket };

        console.log("  SIGNAL FOUND - Sending: " + signal_to_send.action + " " + signal_to_send.symbol + " | USER: " + requested_user_id);
        console.log("  Resetting ONLY this user's signal to prevent duplicates");

        // ✅ Reset only this user's signal after retrieval
        latest_signal_by_user[requested_user_id] = emptySignal();

        return res.status(200).json({
            status: "ok",
            signal: signal_to_send.signal,
            symbol: signal_to_send.symbol,
            action: signal_to_send.action,
            timestamp: signal_to_send.timestamp,
            id: signal_to_send.id,
            price: signal_to_send.price,
            timeframe: signal_to_send.timeframe,
            user_id: signal_to_send.user_id
        });
    }

    console.log("  No signal available for this user - responding with no_signal");
    return res.status(200).json({
        status: "no_signal",
        signal: 0,
        symbol: "",
        id: ""
    });
});

// ==================== POST WEBHOOK ENDPOINT (FOR TRADINGVIEW) ====================

/**
 * POST /webhook
 * TradingView sends alerts here
 * Single user (old):
 * {"event":"ALERT","symbol":"XAUUSD","action":"BUY","token":"YOUR_TOKEN","user_id":"user_Asheen"}
 *
 * Multi-user broadcast (new):
 * {"event":"ALERT","symbol":"XAUUSD","action":"BUY","token":"YOUR_TOKEN","user_ids":["user_Asheen","user_Sofia"]}
 */
app.post("/webhook", (req, res) => {
    console.log("  POST /webhook endpoint called");

    const body = req.body || {};
    const rawEvent = body.event || "";
    const event_type = sanitize(rawEvent);

    console.log("  Event type: " + event_type);

    // ========== GET_SIGNAL via POST ==========
    if (event_type === "GET_SIGNAL") {
        console.log("  GET_SIGNAL event (POST method)");

        // Validate token from body
        const token = body.token || "";
        if (token !== SECRET_TOKEN) {
            console.log("  Token validation FAILED");
            return res.status(401).json({
                status: "unauthorized",
                message: "Invalid token"
            });
        }

        // ✅ Required for multi-user safety
        const requested_user_id = sanitizeUserId(body.user_id || "");
        if (!requested_user_id) {
            console.log("  Missing user_id in POST GET_SIGNAL - returning no_signal");
            return res.status(200).json({
                status: "no_signal",
                signal: 0,
                id: ""
            });
        }

        if (!latest_signal_by_user[requested_user_id]) {
            latest_signal_by_user[requested_user_id] = emptySignal();
        }

        const bucket = latest_signal_by_user[requested_user_id];

        if (bucket.signal !== 0) {
            const signal_to_send = { ...bucket };

            console.log("  SIGNAL SENT: " + signal_to_send.action + " " + signal_to_send.symbol + " | USER: " + requested_user_id);

            // ✅ consume only this user's signal
            latest_signal_by_user[requested_user_id] = emptySignal();

            return res.status(200).json({
                status: "ok",
                signal: signal_to_send.signal,
                symbol: signal_to_send.symbol,
                action: signal_to_send.action,
                timestamp: signal_to_send.timestamp,
                id: signal_to_send.id,
                user_id: signal_to_send.user_id
            });
        }

        console.log("  No signal available for this user");
        return res.status(200).json({
            status: "no_signal",
            signal: 0,
            id: ""
        });
    }

    // ========== ALERT from TradingView ==========
    if (event_type === "ALERT") {
        console.log("  ALERT event from TradingView");

        // Validate token from body
        const token = body.token || "";
        if (token !== SECRET_TOKEN) {
            console.log("  Token validation FAILED");
            return res.status(401).json({
                status: "unauthorized",
                message: "Invalid token"
            });
        }

        const symbol = sanitize(body.symbol || "");
        const action = sanitize(body.action || body.signal || "");
        const price = body.price || "";
        const timeframe = body.timeframe || "";

        // Validate symbol
        if (!symbol) {
            console.log("  Missing symbol");
            return res.status(400).json({
                status: "bad_request",
                message: "Symbol is required"
            });
        }

        // Validate action
        if (action !== "BUY" && action !== "SELL") {
            console.log("  Invalid action: " + action);
            return res.status(400).json({
                status: "bad_request",
                message: "Action must be BUY or SELL"
            });
        }

        // ✅ NEW: Resolve targets (multi-user broadcast supported)
        let targets = [];

        // 1) New format: user_ids[]
        if (Array.isArray(body.user_ids) && body.user_ids.length > 0) {
            targets = body.user_ids.map(sanitizeUserId).filter(Boolean);
        }

        // 2) Backward compatible: single user_id
        if (targets.length === 0) {
            const single = sanitizeUserId(body.user_id || "");
            if (single) targets = [single];
        }

        // Validate targets
        if (targets.length === 0) {
            console.log("  Missing user_id / user_ids");
            return res.status(400).json({
                status: "bad_request",
                message: "user_id is required (old) OR user_ids[] is required (broadcast)"
            });
        }

        // Store signal per-user (broadcast)
        const numeric_signal = action === "BUY" ? 1 : -1;
        const signal_id = generateSignalId();

        targets.forEach((uid) => {
            latest_signal_by_user[uid] = {
                signal: numeric_signal,
                symbol: symbol,
                action: action,
                timestamp: new Date().toISOString(),
                id: signal_id, // same id for all targets
                price: price,
                timeframe: timeframe,
                user_id: uid
            };

            logSignal(latest_signal_by_user[uid]);
            console.log("  ALERT STORED (BROADCAST): " + action + " " + symbol + " | USER: " + uid + " at " + price + " (" + timeframe + ")");
        });

        return res.status(200).json({
            status: "ok",
            message: "Alert received and stored (broadcast)",
            signal: numeric_signal,
            id: signal_id,
            symbol: symbol,
            targets: targets,
            timestamp: new Date().toISOString()
        });
    }

    // ========== PING ==========
    if (event_type === "PING") {
        console.log("  PING received");
        return res.status(200).json({
            status: "pong",
            timestamp: new Date().toISOString()
        });
    }

    // ========== Unknown ==========
    console.log("  Unknown event: " + event_type);
    return res.status(200).json({
        status: "ignored",
        message: "Unknown event: " + event_type,
        available_events: ["GET_SIGNAL", "ALERT", "PING"],
        timestamp: new Date().toISOString()
    });
});

// ==================== ALTERNATIVE ENDPOINTS ====================

/**
 * GET /signal?token=TOKEN&user_id=user_Asheen
 * (kept for compatibility)
 */
app.get("/signal", (req, res) => {
    console.log("  GET /signal endpoint called");

    if (!validateToken(req)) {
        return res.status(401).json({
            status: "unauthorized",
            message: "Invalid or missing token"
        });
    }

    const requested_user_id = sanitizeUserId(req.query.user_id || "");
    if (!requested_user_id) {
        return res.status(200).json({
            status: "no_signal",
            signal: 0,
            id: ""
        });
    }

    if (!latest_signal_by_user[requested_user_id]) {
        latest_signal_by_user[requested_user_id] = emptySignal();
    }

    const bucket = latest_signal_by_user[requested_user_id];

    if (bucket.signal !== 0) {
        const signal_to_send = { ...bucket };

        latest_signal_by_user[requested_user_id] = emptySignal();
        console.log("  Signal sent: " + signal_to_send.action + " | USER: " + requested_user_id);

        return res.status(200).json({
            status: "ok",
            signal: signal_to_send.signal,
            symbol: signal_to_send.symbol,
            action: signal_to_send.action,
            timestamp: signal_to_send.timestamp,
            id: signal_to_send.id,
            price: signal_to_send.price,
            timeframe: signal_to_send.timeframe,
            user_id: signal_to_send.user_id
        });
    }

    return res.status(200).json({
        status: "no_signal",
        signal: 0,
        id: ""
    });
});

// ==================== STATUS ENDPOINTS ====================

app.get("/health", (req, res) => {
    res.status(200).json({
        status: "healthy",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        pending_signal: hasPendingAnyUser()
    });
});

app.get("/status", (req, res) => {
    const recentHistory = signal_history.length > 10
        ? signal_history.slice(-10)
        : signal_history;

    res.status(200).json({
        status: "running",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        pending_users: getPendingUsers(),
        latest_signal_by_user: latest_signal_by_user,
        recent_history: recentHistory,
        total_signals_processed: signal_history.length,
        server_version: "4.3-userwise-broadcast"
    });
});

app.get("/", (req, res) => {
    const hasSSL = fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH);

    res.status(200).json({
        status: "running",
        version: "4.3-userwise-broadcast",
        method: "C - Token in URL Query Parameter (User-wise store + Broadcast)",
        protocol: hasSSL ? "HTTPS" : "HTTP",
        endpoints: {
            "GET /get_signal?token=TOKEN&user_id=user_Asheen": "Primary MT5 signal endpoint (User-wise)",
            "GET /signal?token=TOKEN&user_id=user_Asheen": "Alternative signal endpoint (User-wise)",
            "POST /webhook": "TradingView alerts (token in body) | supports user_id or user_ids[]",
            "GET /health": "Health check",
            "GET /status": "Detailed status",
            "GET /": "This page"
        },
        usage: {
            "MT5 EA Call": "GET /get_signal?token=YOUR_TOKEN&user_id=user_Asheen",
            "TradingView Webhook (single)": "POST /webhook with body containing token + user_id",
            "TradingView Webhook (broadcast)": "POST /webhook with body containing token + user_ids[]"
        },
        pending_signal: hasPendingAnyUser(),
        timestamp: new Date().toISOString()
    });
});

// ==================== 404 HANDLER ====================
app.use((req, res) => {
    console.log("  404 Not Found: " + req.method + " " + req.path);
    res.status(404).json({
        status: "not_found",
        message: req.method + " " + req.path + " not found",
        available_endpoints: [
            "GET /get_signal?token=TOKEN&user_id=user_Asheen",
            "GET /signal?token=TOKEN&user_id=user_Asheen",
            "POST /webhook",
            "GET /health",
            "GET /status",
            "GET /"
        ],
        timestamp: new Date().toISOString()
    });
});

// ==================== HEARTBEAT ====================
setInterval(() => {
    const timestamp = new Date().toISOString();
    const pending_users = getPendingUsers();
    console.log("[HEARTBEAT] " + timestamp + " | Pending Users: " + pending_users.length + (pending_users.length ? " => " + pending_users.join(",") : ""));
}, 30000);

// ==================== ERROR HANDLING ====================
process.on('uncaughtException', (err) => {
    console.error("UNCAUGHT EXCEPTION: " + err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error("UNHANDLED REJECTION: " + reason);
});

// ==================== SERVER STARTUP ====================
function startServer() {
    const hasSSL = fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH);

    if (hasSSL) {
        try {
            const options = {
                key: fs.readFileSync(SSL_KEY_PATH),
                cert: fs.readFileSync(SSL_CERT_PATH)
            };

            https.createServer(options, app).listen(PORT, HOST, () => {
                const sep = "=========================================================================";
                console.log("");
                console.log(sep);
                console.log("WEBHOOK SERVER v4.3 USER-WISE + BROADCAST (Token in URL)");
                console.log(sep);
                console.log("Protocol:     HTTPS (Secure)");
                console.log("Host:         " + HOST);
                console.log("Port:         " + PORT);
                console.log("");
                console.log("PRIMARY ENDPOINT (MT5):");
                console.log("  https://webhook-relay-zip.onrender.com/get_signal?token=YOUR_TOKEN&user_id=user_Asheen");
                console.log("");
                console.log("TRADINGVIEW ENDPOINT:");
                console.log("  POST https://webhook-relay-zip.onrender.com/webhook");
                console.log("  Body (single):    {\"event\":\"ALERT\",\"symbol\":\"XAUUSD\",\"action\":\"BUY\",\"token\":\"...\",\"user_id\":\"user_Asheen\"}");
                console.log("  Body (broadcast): {\"event\":\"ALERT\",\"symbol\":\"XAUUSD\",\"action\":\"BUY\",\"token\":\"...\",\"user_ids\":[\"user_Asheen\",\"user_Sofia\"]}");
                console.log("");
                console.log("Token (first 25 chars): " + SECRET_TOKEN.substring(0, 25) + "...");
                console.log(sep);
                console.log("Ready for MT5 EA and TradingView signals (multi-user safe + broadcast)");
                console.log("");
            });
        } catch (err) {
            console.error("SSL Error: " + err.message);
            startHTTP();
        }
    } else {
        startHTTP();
    }
}

function startHTTP() {
    app.listen(PORT, HOST, () => {
        const sep = "=========================================================================";
        console.log("");
        console.log(sep);
        console.log("WEBHOOK SERVER v4.3 USER-WISE + BROADCAST (Token in URL)");
        console.log(sep);
        console.log("Protocol:     HTTP (Development)");
        console.log("Host:         " + HOST);
        console.log("Port:         " + PORT);
        console.log("");
        console.log("ENDPOINT:");
        console.log("  http://localhost:" + PORT + "/get_signal?token=YOUR_TOKEN&user_id=user_Asheen");
        console.log("");
        console.log("Note: For production, add cert.pem and key.pem");
        console.log(sep);
        console.log("Ready for signals (multi-user safe + broadcast)");
        console.log("");
    });
}

startServer();
