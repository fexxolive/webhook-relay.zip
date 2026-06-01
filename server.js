//+------------------------------------------------------------------+
//| WEBHOOK SERVER - v4.4 QUEUE-BASED (BUG FIX)
//| TradingView + MT5 EA Integration | Token in Query Parameter
//| FIX: Per-user signal QUEUE instead of single signal
//|      Multiple alerts same second pe fire hon toh koi signal miss nahi hoga
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

app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log("[" + timestamp + "] " + req.method + " " + req.path);
    console.log("  Query: " + JSON.stringify(req.query));
    console.log("  Body: " + JSON.stringify(req.body).substring(0, 150));
    next();
});

app.use((err, req, res, next) => {
    console.log("  ERROR: " + err.message);
    res.status(400).json({
        status: "error",
        message: err.message,
        timestamp: new Date().toISOString()
    });
});

// ==================== SIGNAL STORAGE (QUEUE PER USER) ====================
// ✅ FIX v4.4: Array (queue) per user instead of single object
// Multiple alerts same second pe aayein toh koi signal overwrite nahi hoga
// EA FIFO order mein signals consume karega

const signal_queue_by_user = Object.create(null); // { "user_Asheen1": [signal1, signal2, ...] }

const signal_history = [];
const MAX_HISTORY = 50;
const MAX_QUEUE_PER_USER = 20; // safety cap - queue zyada badi na ho

// ==================== UTILITY FUNCTIONS ====================

function getOrCreateQueue(user_id) {
    if (!signal_queue_by_user[user_id]) {
        signal_queue_by_user[user_id] = [];
    }
    return signal_queue_by_user[user_id];
}

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

    console.log("[SIGNAL-QUEUED] " + signal_obj.action + " | " + signal_obj.symbol + " | ID: " + signal_obj.id + " | USER: " + (signal_obj.user_id || "N/A"));
}

function validateToken(req) {
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

function sanitizeUserId(str) {
    if (typeof str === 'string') {
        return str.trim();
    }
    return "";
}

function generateSignalId() {
    // ✅ FIX v4.4: hrtime use karo for truly unique IDs even at same millisecond
    return Date.now() + "_" + process.hrtime.bigint().toString().slice(-9) + "_" + Math.random().toString(36).substr(2, 6);
}

function hasPendingAnyUser() {
    return Object.keys(signal_queue_by_user).some(uid => signal_queue_by_user[uid] && signal_queue_by_user[uid].length > 0);
}

function getPendingUsers() {
    return Object.keys(signal_queue_by_user).filter(uid => signal_queue_by_user[uid] && signal_queue_by_user[uid].length > 0);
}

function getQueueSummary() {
    const summary = {};
    for (const uid of Object.keys(signal_queue_by_user)) {
        summary[uid] = signal_queue_by_user[uid].length;
    }
    return summary;
}

// ==================== MAIN GET ENDPOINT ====================

/**
 * GET /get_signal?token=TOKEN&user_id=user_Asheen1
 * MT5 EA yahan se signal fetch karta hai
 * Queue se pehla signal FIFO order mein deta hai
 */
app.get("/get_signal", (req, res) => {
    console.log("  GET /get_signal endpoint called");

    if (!validateToken(req)) {
        console.log("  REJECTING request - invalid token");
        return res.status(401).json({
            status: "unauthorized",
            message: "Invalid or missing token in URL",
            example: "/get_signal?token=YOUR_TOKEN_HERE&user_id=user_Asheen1",
            timestamp: new Date().toISOString()
        });
    }

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

    const queue = getOrCreateQueue(requested_user_id);

    console.log("  Checking queue for USER: " + requested_user_id + " | Queue size: " + queue.length);

    if (queue.length > 0) {
        // ✅ FIFO: pehla signal nikalo
        const signal_to_send = queue.shift();

        console.log("  SIGNAL FOUND - Sending: " + signal_to_send.action + " " + signal_to_send.symbol + " | USER: " + requested_user_id + " | Remaining in queue: " + queue.length);

        return res.status(200).json({
            status: "ok",
            signal: signal_to_send.signal,
            symbol: signal_to_send.symbol,
            action: signal_to_send.action,
            timestamp: signal_to_send.timestamp,
            id: signal_to_send.id,
            price: signal_to_send.price,
            timeframe: signal_to_send.timeframe,
            user_id: signal_to_send.user_id,
            queue_remaining: queue.length // EA ko pata chale kitne aur signals hain
        });
    }

    console.log("  No signal available for USER: " + requested_user_id);
    return res.status(200).json({
        status: "no_signal",
        signal: 0,
        symbol: "",
        id: ""
    });
});

// ==================== POST WEBHOOK ENDPOINT ====================

/**
 * POST /webhook
 * TradingView yahan alerts bhejta hai
 *
 * Single user:
 * {"event":"ALERT","symbol":"XAUUSD","action":"BUY","token":"...","user_id":"user_Asheen1"}
 *
 * Multi-user broadcast:
 * {"event":"ALERT","symbol":"XAUUSD","action":"BUY","token":"...","user_ids":["user_Asheen1","user_Asheen3"]}
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

        const token = body.token || "";
        if (token !== SECRET_TOKEN) {
            console.log("  Token validation FAILED");
            return res.status(401).json({
                status: "unauthorized",
                message: "Invalid token"
            });
        }

        const requested_user_id = sanitizeUserId(body.user_id || "");
        if (!requested_user_id) {
            console.log("  Missing user_id in POST GET_SIGNAL - returning no_signal");
            return res.status(200).json({
                status: "no_signal",
                signal: 0,
                id: ""
            });
        }

        const queue = getOrCreateQueue(requested_user_id);

        if (queue.length > 0) {
            const signal_to_send = queue.shift();

            console.log("  SIGNAL SENT: " + signal_to_send.action + " " + signal_to_send.symbol + " | USER: " + requested_user_id + " | Remaining: " + queue.length);

            return res.status(200).json({
                status: "ok",
                signal: signal_to_send.signal,
                symbol: signal_to_send.symbol,
                action: signal_to_send.action,
                timestamp: signal_to_send.timestamp,
                id: signal_to_send.id,
                price: signal_to_send.price,
                timeframe: signal_to_send.timeframe,
                user_id: signal_to_send.user_id,
                queue_remaining: queue.length
            });
        }

        console.log("  No signal available for USER: " + requested_user_id);
        return res.status(200).json({
            status: "no_signal",
            signal: 0,
            id: ""
        });
    }

    // ========== ALERT from TradingView ==========
    if (event_type === "ALERT") {
        console.log("  ALERT event from TradingView");

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

        if (!symbol) {
            console.log("  Missing symbol");
            return res.status(400).json({
                status: "bad_request",
                message: "Symbol is required"
            });
        }

        if (action !== "BUY" && action !== "SELL") {
            console.log("  Invalid action: " + action);
            return res.status(400).json({
                status: "bad_request",
                message: "Action must be BUY or SELL"
            });
        }

        // ✅ Resolve targets
        let targets = [];

        if (Array.isArray(body.user_ids) && body.user_ids.length > 0) {
            targets = body.user_ids.map(sanitizeUserId).filter(Boolean);
        }

        if (targets.length === 0) {
            const single = sanitizeUserId(body.user_id || "");
            if (single) targets = [single];
        }

        if (targets.length === 0) {
            console.log("  Missing user_id / user_ids");
            return res.status(400).json({
                status: "bad_request",
                message: "user_id is required (single) OR user_ids[] is required (broadcast)"
            });
        }

        const numeric_signal = action === "BUY" ? 1 : -1;

        // ✅ FIX v4.4: Per-target unique signal ID + push to queue (not overwrite)
        const queued_targets = [];
        const skipped_targets = [];

        targets.forEach((uid) => {
            const queue = getOrCreateQueue(uid);

            // Safety cap - queue zyada badi na ho
            if (queue.length >= MAX_QUEUE_PER_USER) {
                console.log("  QUEUE FULL for USER: " + uid + " - skipping");
                skipped_targets.push(uid);
                return;
            }

            // ✅ Har user ke liye alag unique ID
            const signal_id = generateSignalId();

            const new_signal = {
                signal: numeric_signal,
                symbol: symbol,
                action: action,
                timestamp: new Date().toISOString(),
                id: signal_id,
                price: price,
                timeframe: timeframe,
                user_id: uid
            };

            queue.push(new_signal);
            queued_targets.push(uid);

            logSignal(new_signal);
            console.log("  SIGNAL QUEUED: " + action + " " + symbol + " | USER: " + uid + " | Queue size now: " + queue.length);
        });

        return res.status(200).json({
            status: "ok",
            message: "Alert received and queued",
            signal: numeric_signal,
            symbol: symbol,
            queued_targets: queued_targets,
            skipped_targets: skipped_targets,
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

    const queue = getOrCreateQueue(requested_user_id);

    if (queue.length > 0) {
        const signal_to_send = queue.shift();

        console.log("  Signal sent: " + signal_to_send.action + " | USER: " + requested_user_id + " | Remaining: " + queue.length);

        return res.status(200).json({
            status: "ok",
            signal: signal_to_send.signal,
            symbol: signal_to_send.symbol,
            action: signal_to_send.action,
            timestamp: signal_to_send.timestamp,
            id: signal_to_send.id,
            price: signal_to_send.price,
            timeframe: signal_to_send.timeframe,
            user_id: signal_to_send.user_id,
            queue_remaining: queue.length
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
        pending_users: getPendingUsers().length,
        queue_summary: getQueueSummary()
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
        queue_summary: getQueueSummary(),
        signal_queue_by_user: signal_queue_by_user,
        recent_history: recentHistory,
        total_signals_processed: signal_history.length,
        server_version: "4.4-queue-based"
    });
});

app.get("/", (req, res) => {
    const hasSSL = fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH);

    res.status(200).json({
        status: "running",
        version: "4.4-queue-based",
        method: "C - Token in URL Query Parameter (Queue-based per user)",
        protocol: hasSSL ? "HTTPS" : "HTTP",
        endpoints: {
            "GET /get_signal?token=TOKEN&user_id=user_Asheen1": "Primary MT5 signal endpoint (Queue-based)",
            "GET /signal?token=TOKEN&user_id=user_Asheen1": "Alternative signal endpoint (Queue-based)",
            "POST /webhook": "TradingView alerts | supports user_id or user_ids[]",
            "GET /health": "Health check with queue summary",
            "GET /status": "Detailed status with full queue state",
            "GET /": "This page"
        },
        fix_v4_4: "Signal queue per user - multiple alerts same second pe miss nahi honge",
        pending_users: getPendingUsers(),
        queue_summary: getQueueSummary(),
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
            "GET /get_signal?token=TOKEN&user_id=user_Asheen1",
            "GET /signal?token=TOKEN&user_id=user_Asheen1",
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
    const queue_summary = getQueueSummary();
    console.log("[HEARTBEAT] " + timestamp + " | Pending Users: " + pending_users.length + (pending_users.length ? " => " + JSON.stringify(queue_summary) : ""));
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
                printBanner("HTTPS");
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
        printBanner("HTTP");
    });
}

function printBanner(protocol) {
    const sep = "=========================================================================";
    console.log("");
    console.log(sep);
    console.log("WEBHOOK SERVER v4.4 QUEUE-BASED (BUG FIX)");
    console.log(sep);
    console.log("Protocol:     " + protocol);
    console.log("Host:         " + HOST);
    console.log("Port:         " + PORT);
    console.log("");
    console.log("FIX v4.4:");
    console.log("  - Signal QUEUE per user (array) instead of single object");
    console.log("  - Multiple alerts same second pe fire hon = koi miss nahi hoga");
    console.log("  - FIFO order mein signals deliver honge");
    console.log("  - Per-user unique signal IDs");
    console.log("");
    console.log("PRIMARY ENDPOINT (MT5):");
    console.log("  GET /get_signal?token=YOUR_TOKEN&user_id=user_Asheen1");
    console.log("");
    console.log("TRADINGVIEW ENDPOINT:");
    console.log("  POST /webhook");
    console.log("  Body (single):    {\"event\":\"ALERT\",\"symbol\":\"XAUUSD\",\"action\":\"BUY\",\"token\":\"...\",\"user_id\":\"user_Asheen1\"}");
    console.log("  Body (broadcast): {\"event\":\"ALERT\",\"symbol\":\"XAUUSD\",\"action\":\"BUY\",\"token\":\"...\",\"user_ids\":[\"user_Asheen1\",\"user_Asheen3\"]}");
    console.log("");
    console.log("Token (first 25 chars): " + SECRET_TOKEN.substring(0, 25) + "...");
    console.log(sep);
    console.log("Ready - Queue-based signal delivery active");
    console.log("");
}

startServer();
