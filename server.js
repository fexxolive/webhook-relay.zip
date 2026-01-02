//+------------------------------------------------------------------+
//| WEBHOOK SERVER - v4.2 PRODUCTION FIXED
//| TradingView + MT5 EA Integration | All Syntax Errors Resolved
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

// ==================== MIDDLEWARE - CRITICAL FIX ====================
// Handles BOTH JSON and URL-encoded bodies from MT5
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Enhanced request logging
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log("[" + timestamp + "] " + req.method + " " + req.path);
    console.log("  Content-Type: " + (req.headers['content-type'] || 'none'));
    console.log("  Body: " + JSON.stringify(req.body).substring(0, 200));
    next();
});

// ==================== SIGNAL STORAGE ====================
let latest_signal = {
    signal: 0,
    symbol: "",
    timestamp: null,
    action: "",
    id: ""
};

const signal_history = [];
const MAX_HISTORY = 50;

// ==================== UTILITY FUNCTIONS ====================

/**
 * Log signal with history tracking
 */
function logSignal(signal_obj) {
    signal_history.push({
        signal: signal_obj.signal,
        symbol: signal_obj.symbol,
        action: signal_obj.action,
        id: signal_obj.id,
        receivedAt: new Date().toISOString()
    });
    
    if (signal_history.length > MAX_HISTORY) {
        signal_history.shift();
    }
    
    console.log("[SIGNAL-STORED] " + signal_obj.action + " | " + signal_obj.symbol + " | Numeric: " + signal_obj.signal + " | ID: " + signal_obj.id);
}

/**
 * Validate token from multiple sources
 */
function validateToken(req) {
    const token = 
        req.headers["x-webhook-token"] ||
        (req.body ? req.body.secret : null) ||
        req.query.token ||
        "";
    
    const isValid = token === SECRET_TOKEN;
    console.log("  Key validation: " + (isValid ? "VALID" : "INVALID"));
    
    return isValid;
}

/**
 * Normalize input
 */
function sanitize(str) {
    if (typeof str === 'string') {
        return str.trim().toUpperCase();
    }
    return "";
}

/**
 * Generate unique signal ID
 */
function generateSignalId() {
    return Date.now() + "_" + Math.random().toString(36).substr(2, 9);
}

// ==================== MAIN WEBHOOK ENDPOINT ====================

/**
 * POST /webhook
 * Unified endpoint for TradingView alerts and MT5 EA polling
 */
app.post("/webhook", (req, res) => {
    console.log("  Processing webhook request...");
    
    // STEP 1: Validate token
    if (!validateToken(req)) {
        console.log("  Token validation FAILED");
        return res.status(401).json({
            status: "unauthorized",
            message: "Invalid or missing token",
            timestamp: new Date().toISOString()
        });
    }
    
    // STEP 2: Extract event type
    const rawEvent = (req.body ? req.body.event : null) || "";
    const event_type = sanitize(rawEvent);
    
    console.log("  Event Type: " + event_type);
    
    // ========== GET_SIGNAL: MT5 EA Polling ==========
    if (event_type === "GET_SIGNAL") {
        console.log("  MT5 EA requesting signal...");
        
        if (latest_signal.signal !== 0) {
            // Signal available - send it
            const signal_to_send = {
                signal: latest_signal.signal,
                symbol: latest_signal.symbol,
                action: latest_signal.action,
                timestamp: latest_signal.timestamp,
                id: latest_signal.id
            };
            
            console.log("  SIGNAL SENT: " + latest_signal.action + " " + latest_signal.symbol + " | ID: " + latest_signal.id);
            
            // Reset to prevent duplicate trades
            latest_signal.signal = 0;
            
            return res.status(200).json({
                status: "ok",
                signal: signal_to_send.signal,
                symbol: signal_to_send.symbol,
                action: signal_to_send.action,
                timestamp: signal_to_send.timestamp,
                id: signal_to_send.id
            });
        } else {
            // No pending signal
            console.log("  No signal available (awaiting TradingView alert)");
            return res.status(200).json({
                status: "no_signal",
                signal: 0,
                id: ""
            });
        }
    }
    
    // ========== ALERT: TradingView Webhook ==========
    if (event_type === "ALERT") {
        console.log("  TradingView ALERT received");
        
        const symbol = sanitize((req.body ? req.body.symbol : null) || "");
        const action = sanitize((req.body ? (req.body.action || req.body.signal) : null) || "");
        const price = (req.body ? req.body.price : null) || "";
        const timeframe = (req.body ? req.body.timeframe : null) || "";
        
        // Validate required fields
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
        
        // Store signal
        const numeric_signal = action === "BUY" ? 1 : -1;
        const signal_id = generateSignalId();
        
        latest_signal = {
            signal: numeric_signal,
            symbol: symbol,
            action: action,
            timestamp: new Date().toISOString(),
            id: signal_id,
            price: price,
            timeframe: timeframe
        };
        
        logSignal(latest_signal);
        console.log("  Signal stored | " + action + " " + symbol + " at " + price + " (" + timeframe + ")");
        console.log("  EA will retrieve on next GET_SIGNAL call");
        
        return res.status(200).json({
            status: "ok",
            message: "Alert received",
            signal: numeric_signal,
            id: signal_id,
            timestamp: new Date().toISOString()
        });
    }
    
    // ========== PING: Health check ==========
    if (event_type === "PING") {
        console.log("  PING received - responding PONG");
        return res.status(200).json({
            status: "pong",
            timestamp: new Date().toISOString()
        });
    }
    
    // ========== Unknown event ==========
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
 * POST /webhook/signal
 * Direct signal retrieval (same as GET_SIGNAL)
 */
app.post("/webhook/signal", (req, res) => {
    console.log("  Webhook signal endpoint called");
    
    if (!validateToken(req)) {
        console.log("  Token validation failed");
        return res.status(401).json({
            status: "unauthorized",
            message: "Invalid or missing token"
        });
    }
    
    if (latest_signal.signal !== 0) {
        const signal_to_send = {
            signal: latest_signal.signal,
            symbol: latest_signal.symbol,
            action: latest_signal.action,
            timestamp: latest_signal.timestamp,
            id: latest_signal.id
        };
        
        latest_signal.signal = 0;
        
        console.log("  Signal sent: " + signal_to_send.action);
        return res.status(200).json({
            status: "ok",
            signal: signal_to_send.signal,
            symbol: signal_to_send.symbol,
            action: signal_to_send.action,
            timestamp: signal_to_send.timestamp,
            id: signal_to_send.id
        });
    }
    
    console.log("  No signal available");
    return res.status(200).json({
        status: "no_signal",
        signal: 0,
        id: ""
    });
});

/**
 * GET /get_signal
 * Legacy endpoint for backward compatibility
 */
app.get("/get_signal", (req, res) => {
    console.log("  Legacy GET signal endpoint called");
    
    const token = req.headers["x-webhook-token"] || req.query.token || "";
    
    if (token !== SECRET_TOKEN) {
        console.log("  Token validation failed");
        return res.status(401).json({
            status: "unauthorized",
            message: "Invalid or missing token"
        });
    }
    
    if (latest_signal.signal !== 0) {
        const signal_to_send = {
            signal: latest_signal.signal,
            symbol: latest_signal.symbol,
            action: latest_signal.action,
            timestamp: latest_signal.timestamp,
            id: latest_signal.id
        };
        
        latest_signal.signal = 0;
        
        console.log("  Signal sent: " + signal_to_send.action);
        return res.status(200).json({
            status: "ok",
            signal: signal_to_send.signal,
            symbol: signal_to_send.symbol,
            action: signal_to_send.action,
            timestamp: signal_to_send.timestamp,
            id: signal_to_send.id
        });
    }
    
    console.log("  No signal available");
    return res.status(200).json({
        status: "no_signal",
        signal: 0,
        id: ""
    });
});

// ==================== STATUS & HEALTH ENDPOINTS ====================

app.get("/health", (req, res) => {
    res.status(200).json({
        status: "healthy",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        pending_signal: latest_signal.signal !== 0
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
        latest_signal: latest_signal,
        pending_signal: latest_signal.signal !== 0 ? "YES" : "NO",
        recent_history: recentHistory,
        total_signals: signal_history.length
    });
});

app.get("/", (req, res) => {
    const hasSSL = fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH);
    
    res.status(200).json({
        status: "running",
        version: "4.2",
        secure: hasSSL ? "HTTPS" : "HTTP",
        endpoints: {
            "POST /webhook": "Main webhook (TradingView + MT5 EA)",
            "POST /webhook/signal": "Alternative signal endpoint",
            "GET /get_signal": "Legacy signal retrieval",
            "GET /health": "Health check",
            "GET /status": "Full status and history",
            "GET /": "This page"
        },
        pending_signal: latest_signal.signal !== 0,
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
            "POST /webhook",
            "POST /webhook/signal",
            "GET /get_signal",
            "GET /health",
            "GET /status",
            "GET /"
        ]
    });
});

// ==================== HEARTBEAT ====================
setInterval(() => {
    const timestamp = new Date().toISOString();
    const pending = latest_signal.signal !== 0 ? "YES" : "NO";
    console.log("[HEARTBEAT] " + timestamp + " | Pending: " + pending);
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
                const separator = "======================================================================";
                console.log("");
                console.log(separator);
                console.log("WEBHOOK SERVER v4.2 STARTED - HTTPS");
                console.log(separator);
                console.log("Protocol:  HTTPS (Secure)");
                console.log("Host:      " + HOST);
                console.log("Port:      " + PORT);
                console.log("Webhook:   POST /webhook");
                console.log("Health:    GET /health");
                console.log("Status:    GET /status");
                console.log("Token:     " + SECRET_TOKEN.substring(0, 20) + "...");
                console.log(separator);
                console.log("Ready for TradingView alerts and MT5 EA signals");
                console.log("");
            });
        } catch (err) {
            console.error("SSL Error: " + err.message);
            console.log("Falling back to HTTP...");
            startHTTP();
        }
    } else {
        startHTTP();
    }
}

function startHTTP() {
    app.listen(PORT, HOST, () => {
        const separator = "======================================================================";
        console.log("");
        console.log(separator);
        console.log("WEBHOOK SERVER v4.2 STARTED - HTTP (DEVELOPMENT)");
        console.log(separator);
        console.log("Protocol:  HTTP (Not Secure)");
        console.log("Host:      " + HOST);
        console.log("Port:      " + PORT);
        console.log("Webhook:   POST /webhook");
        console.log("Health:    GET /health");
        console.log("Status:    GET /status");
        console.log("Token:     " + SECRET_TOKEN.substring(0, 20) + "...");
        console.log("");
        console.log("Note: For production, add cert.pem and key.pem files");
        console.log(separator);
        console.log("Ready for TradingView alerts and MT5 EA signals");
        console.log("");
    });
}

// Start the server
startServer();
