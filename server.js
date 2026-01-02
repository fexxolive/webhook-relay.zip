//+------------------------------------------------------------------+
//| WEBHOOK SERVER - v4.3 METHOD C (GET with URL Token)
//| TradingView + MT5 EA Integration | Token in Query Parameter
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

// ==================== SIGNAL STORAGE ====================
let latest_signal = {
    signal: 0,
    symbol: "",
    timestamp: null,
    action: "",
    id: "",
    price: "",
    timeframe: ""
};

const signal_history = [];
const MAX_HISTORY = 50;

// ==================== UTILITY FUNCTIONS ====================

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
    
    console.log("[SIGNAL-STORED] " + signal_obj.action + " | " + signal_obj.symbol + " | ID: " + signal_obj.id);
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

function generateSignalId() {
    return Date.now() + "_" + Math.random().toString(36).substr(2, 9);
}

// ==================== MAIN GET ENDPOINT (METHOD C) ====================

/**
 * GET /get_signal
 * MT5 EA retrieves signals using: /get_signal?token=YOUR_TOKEN
 * This is the PRIMARY endpoint for Method C
 */
app.get("/get_signal", (req, res) => {
    console.log("  GET /get_signal endpoint called (METHOD C)");
    
    // Validate token from URL query parameter
    if (!validateToken(req)) {
        console.log("  REJECTING request - invalid token");
        return res.status(401).json({
            status: "unauthorized",
            message: "Invalid or missing token in URL",
            example: "/get_signal?token=YOUR_TOKEN_HERE",
            timestamp: new Date().toISOString()
        });
    }
    
    console.log("  Token accepted - checking for pending signals");
    
    // Signal available
    if (latest_signal.signal !== 0) {
        const signal_to_send = {
            signal: latest_signal.signal,
            symbol: latest_signal.symbol,
            action: latest_signal.action,
            timestamp: latest_signal.timestamp,
            id: latest_signal.id,
            price: latest_signal.price,
            timeframe: latest_signal.timeframe
        };
        
        console.log("  SIGNAL FOUND - Sending: " + latest_signal.action + " " + latest_signal.symbol);
        console.log("  Resetting signal to prevent duplicate trades");
        
        // Reset signal after retrieval
        latest_signal.signal = 0;
        latest_signal.symbol = "";
        latest_signal.action = "";
        latest_signal.id = "";
        
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
    
    // No signal available
    console.log("  No signal available - responding with no_signal");
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
 * Format: POST with token in body: {"event":"ALERT","symbol":"XAUUSD","action":"BUY","token":"YOUR_TOKEN"}
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
        
        if (latest_signal.signal !== 0) {
            const signal_to_send = {
                signal: latest_signal.signal,
                symbol: latest_signal.symbol,
                action: latest_signal.action,
                timestamp: latest_signal.timestamp,
                id: latest_signal.id
            };
            
            console.log("  SIGNAL SENT: " + latest_signal.action + " " + latest_signal.symbol);
            latest_signal.signal = 0;
            
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
        console.log("  ALERT STORED: " + action + " " + symbol + " at " + price + " (" + timeframe + ")");
        console.log("  EA will retrieve on next /get_signal?token=... call");
        
        return res.status(200).json({
            status: "ok",
            message: "Alert received and stored",
            signal: numeric_signal,
            id: signal_id,
            symbol: symbol,
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
 * GET /signal
 * Alternative short endpoint for signal retrieval
 * Usage: /signal?token=YOUR_TOKEN
 */
app.get("/signal", (req, res) => {
    console.log("  GET /signal endpoint called");
    
    if (!validateToken(req)) {
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
    
    return res.status(200).json({
        status: "no_signal",
        signal: 0,
        id: ""
    });
});

// ==================== STATUS ENDPOINTS ====================

/**
 * GET /health
 * Health check endpoint
 */
app.get("/health", (req, res) => {
    res.status(200).json({
        status: "healthy",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        pending_signal: latest_signal.signal !== 0
    });
});

/**
 * GET /status
 * Detailed status with signal history
 */
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
        total_signals_processed: signal_history.length,
        server_version: "4.3"
    });
});

/**
 * GET /
 * API information page
 */
app.get("/", (req, res) => {
    const hasSSL = fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH);
    
    res.status(200).json({
        status: "running",
        version: "4.3",
        method: "C - Token in URL Query Parameter",
        protocol: hasSSL ? "HTTPS" : "HTTP",
        endpoints: {
            "GET /get_signal?token=TOKEN": "Primary MT5 signal endpoint (Method C)",
            "GET /signal?token=TOKEN": "Alternative signal endpoint",
            "POST /webhook": "TradingView alerts (token in body)",
            "GET /health": "Health check",
            "GET /status": "Detailed status",
            "GET /": "This page"
        },
        usage: {
            "MT5 EA Call": "GET /get_signal?token=37ehADKNLy5psq1IvdUDYshxxik_zuy2RYD72n7E858DYqR2",
            "TradingView Webhook": "POST /webhook with body containing token"
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
            "GET /get_signal?token=TOKEN",
            "GET /signal?token=TOKEN",
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
    const pending = latest_signal.signal !== 0 ? "YES" : "NO";
    console.log("[HEARTBEAT] " + timestamp + " | Pending Signal: " + pending);
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
                console.log("WEBHOOK SERVER v4.3 - METHOD C (Token in URL)");
                console.log(sep);
                console.log("Protocol:     HTTPS (Secure)");
                console.log("Host:         " + HOST);
                console.log("Port:         " + PORT);
                console.log("");
                console.log("PRIMARY ENDPOINT (MT5):");
                console.log("  https://webhook-relay-zip.onrender.com/get_signal?token=YOUR_TOKEN");
                console.log("");
                console.log("TRADINGVIEW ENDPOINT:");
                console.log("  POST https://webhook-relay-zip.onrender.com/webhook");
                console.log("  Body: {\"event\":\"ALERT\",\"symbol\":\"XAUUSD\",\"action\":\"BUY\",\"token\":\"...\"}");
                console.log("");
                console.log("Token (first 25 chars): " + SECRET_TOKEN.substring(0, 25) + "...");
                console.log(sep);
                console.log("Ready for MT5 EA and TradingView signals");
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
        console.log("WEBHOOK SERVER v4.3 - METHOD C (Token in URL)");
        console.log(sep);
        console.log("Protocol:     HTTP (Development)");
        console.log("Host:         " + HOST);
        console.log("Port:         " + PORT);
        console.log("");
        console.log("ENDPOINT:");
        console.log("  http://localhost:" + PORT + "/get_signal?token=YOUR_TOKEN");
        console.log("");
        console.log("Note: For production, add cert.pem and key.pem");
        console.log(sep);
        console.log("Ready for signals");
        console.log("");
    });
}

startServer();
