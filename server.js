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
const SIGNAL_FILE = "signals.json"; // Persistent storage

// ==================== MIDDLEWARE ====================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log("[" + timestamp + "] " + req.method + " " + req.path);
    next();
});

// ==================== SIGNAL STORAGE WITH PERSISTENCE ====================

let latest_signal = {
    signal: 0,
    symbol: "",
    timestamp: null,
    action: "",
    id: "",
    price: "",
    timeframe: "",
    processed: false
};

const signal_history = [];
const MAX_HISTORY = 100;
const PROCESSED_IDS = new Set(); // Track processed signal IDs

// Load signals from file on startup
function loadSignalsFromFile() {
    try {
        if (fs.existsSync(SIGNAL_FILE)) {
            const data = fs.readFileSync(SIGNAL_FILE, 'utf8');
            const parsed = JSON.parse(data);
            
            if (parsed.latest_signal) {
                latest_signal = parsed.latest_signal;
            }
            
            if (parsed.history && Array.isArray(parsed.history)) {
                signal_history.push(...parsed.history);
            }
            
            if (parsed.processed_ids && Array.isArray(parsed.processed_ids)) {
                parsed.processed_ids.forEach(id => PROCESSED_IDS.add(id));
            }
            
            console.log("[STARTUP] Loaded " + signal_history.length + " historical signals");
        }
    } catch (err) {
        console.log("[STARTUP] No existing signals file or parse error: " + err.message);
    }
}

// Save signals to file (persistence)
function saveSignalsToFile() {
    try {
        const data = {
            latest_signal: latest_signal,
            history: signal_history,
            processed_ids: Array.from(PROCESSED_IDS),
            savedAt: new Date().toISOString()
        };
        
        fs.writeFileSync(SIGNAL_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.log("[ERROR] Failed to save signals: " + err.message);
    }
}

// Log signal with persistence
function logSignal(signal_obj) {
    signal_history.push({
        signal: signal_obj.signal,
        symbol: signal_obj.symbol,
        action: signal_obj.action,
        id: signal_obj.id,
        price: signal_obj.price,
        timeframe: signal_obj.timeframe,
        receivedAt: new Date().toISOString()
    });
    
    if (signal_history.length > MAX_HISTORY) {
        signal_history.shift();
    }
    
    saveSignalsToFile();
    console.log("[✅ SIGNAL-STORED] " + signal_obj.action + " | " + signal_obj.symbol + " | ID: " + signal_obj.id);
}

// ==================== UTILITY FUNCTIONS ====================

function validateToken(req) {
    const token = req.query.token || req.body?.token || "";
    const isValid = token === SECRET_TOKEN;
    
    if (!isValid) {
        console.log("  ❌ Token validation FAILED");
    } else {
        console.log("  ✅ Token validation SUCCESS");
    }
    
    return isValid;
}

function sanitize(str) {
    if (typeof str === str.trim().toUpperCase();
    }
    return "";
}

function generateSignalId() {
    return Date.now() + "_" + Math.random().toString(36).substr(2, 9);
}

// ==================== PRIMARY GET ENDPOINT ====================

app.get("/get_signal", (req, res) => {
    console.log("📥 GET /get_signal");
    
    if (!validateToken(req)) {
        return res.status(401).json({
            status: "unauthorized",
            message: "Invalid or missing token",
            timestamp: new Date().toISOString()
        });
    }
    
    // Check for pending signal
    if (latest_signal.signal !== 0 && !latest_signal.processed) {
        const signal_to_send = {
            signal: latest_signal.signal,
            symbol: latest_signal.symbol,
            action: latest_signal.action,
            timestamp: latest_signal.timestamp,
            id: latest_signal.id,
            price: latest_signal.price,
            timeframe: latest_signal.timeframe
        };
        
        console.log("📤 SIGNAL SENT: " + latest_signal.action + " " + latest_signal.symbol);
        
        // Mark as processed
        latest_signal.processed = true;
        latest_signal.signal = 0;
        
        saveSignalsToFile();
        
        return res.status(200).json({
            status: "ok",
            signal: signal_to_send.signal,
            symbol: signal_to_send.symbol,
            action: signal_to_send.action,
            timestamp: signal_to_send.timestamp,
            id: signal_to_send.id,
            price: signal_to_send.price,
            timeframe: signal_to_send.timeframe
        });
    }
    
    console.log("⏭️ No pending signal");
    return res.status(200).json({
        status: "no_signal",
        signal: 0,
        symbol: "",
        id: ""
    });
});

// ==================== WEBHOOK ENDPOINT (TradingView) ====================

app.post("/webhook", (req, res) => {
    console.log("📬 POST /webhook");
    
    const body = req.body || {};
    const event_type = sanitize(body.event || "");
    
    if (event_type === "ALERT") {
        console.log("🔔 ALERT received from TradingView");
        
        if (!validateToken(req)) {
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
            return res.status(400).json({
                status: "bad_request",
                message: "Symbol required"
            });
        }
        
        if (action !== "BUY" && action !== "SELL") {
            return res.status(400).json({
                status: "bad_request",
                message: "Action must be BUY or SELL"
            });
        }
        
        const numeric_signal = action === "BUY" ? 1 : -1;
        const signal_id = generateSignalId();
        
        // Store signal
        latest_signal = {
            signal: numeric_signal,
            symbol: symbol,
            action: action,
            timestamp: new Date().toISOString(),
            id: signal_id,
            price: price,
            timeframe: timeframe,
            processed: false
        };
        
        PROCESSED_IDS.add(signal_id);
        logSignal(latest_signal);
        
        console.log("💾 ALERT STORED: " + action + " " + symbol + " | ID: " + signal_id);
        
        return res.status(200).json({
            status: "ok",
            message: "Alert received and stored",
            signal: numeric_signal,
            id: signal_id,
            symbol: symbol,
            timestamp: new Date().toISOString()
        });
    }
    
    if (event_type === "PING") {
        return res.status(200).json({
            status: "pong",
            timestamp: new Date().toISOString()
        });
    }
    
    return res.status(200).json({
        status: "ignored",
        available_events: ["ALERT", "PING"]
    });
});

// ==================== STATUS ENDPOINTS ====================

app.get("/status", (req, res) => {
    const recent = signal_history.slice(-10);
    
    res.status(200).json({
        status: "running",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        latest_signal: latest_signal,
        pending_signal: latest_signal.signal !== 0 ? "YES" : "NO",
        recent_history: recent,
        total_signals: signal_history.length,
        processed_count: PROCESSED_IDS.size,
        version: "4.4"
    });
});

app.get("/health", (req, res) => {
    res.status(200).json({
        status: "healthy",
        uptime: process.uptime(),
        pending_signal: latest_signal.signal !== 0,
        timestamp: new Date().toISOString()
    });
});

app.get("/", (req, res) => {
    res.status(200).json({
        status: "running",
        version: "4.4",
        method: "Token in URL/Body",
        endpoints: {
            "GET /get_signal?token=TOKEN": "Fetch signals",
            "POST /webhook": "TradingView alerts",
            "GET /status": "Full status",
            "GET /health": "Health check"
        },_signal: latest_signal.signal !== 0,
        timestamp: new Date().toISOString()
    });
});

app.use((req, res) => {
    res.status(404).json({
        status: "not_found",
        message: req.method + " " + req.path + " not found"
    });
});

// ==================== HEARTBEAT ====================

setInterval(() => {
    const pending = latest_signal.signal !== 0 ? "YES" : "NO";
    console.log("[💓 HEARTBEAT] " + new Date().toISOString() + " | Pending: " + pending);
}, 30000);

// ==================== SERVER STARTUP ====================

loadSignalsFromFile();

const PORT_TO_USE = PORT;
const hasSSL = fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH);

if (hasSSL) {
    try {
        const options = {
            key: fs.readFileSync(SSL_KEY_PATH),
            cert: fs.readFileSync(SSL_CERT_PATH)
        };
        
        https.createServer(options, app).listen(PORT_TO_USE, HOST, () => {
            console.log("\n" + "=".repeat(70));
            console.log("🚀 WEBHOOK SERVER v4.4 - PRODUCTION READY");
            console.log("=".repeat(70));
            console.log("Protocol:     HTTPS (Secure)");
            console.log("Port:         " + PORT_TO_USE);
            console.log("Persistence:  ✅ signals.
            console.log("Signal Endpoint:");
            console.log("  https://YOUR-DOMAIN/get_signal?token=YOUR_TOKEN");
            console.log("");
            console.log("Webhook (TradingView):");
            console.log("  POST https://YOUR-DOMAIN/webhook");
            console.log("=".repeat(70) + "\n");
        });
    } catch (err) {
        console.error("SSL Error: " + err.message);
        startHTTP();
    }
} else {
    app.listen(PORT_TO_USE, HOST, () => {
        console.log("\n" + "=".repeat(70));
        console.log("🚀 WEBHOOK SERVER v4.4 - DEVELOPMENT MODE");
        console.log("=".repeat(70));
        console.log("Protocol:     HTTP");
        console.log("Port:         " + PORT_TO_USE);
        console.log("Persistence:  ✅ signals.json");
        console.log("");
        console.log("Endpoint:");
        console.log("  http://localhost:" + PORT_TO_USE +_TOKEN");
        console.log("=".repeat(70) + "\n");
    });
}
