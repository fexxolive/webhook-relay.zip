//+------------------------------------------------------------------+
//| WEBHOOK SERVER - FULLY FIXED v4.1
//| TradingView + MT5 EA Integration
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
app.use(express.json());

// Request logging middleware with enhanced debug info
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    const method = req.method;
    const path = req.path;
    const bodyPreview = req.body ? JSON.stringify(req.body).substring(0, 100) : "{}";
    
    console.log(`\n[${timestamp}] ${method} ${path}`);
    console.log(`  Body: ${bodyPreview}`);
    
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

// Signal history for debugging (last 50 signals)
const signal_history = [];
const MAX_HISTORY = 50;

// ==================== UTILITY FUNCTIONS ====================

/**
 * Log signal with history tracking
 */
function logSignal(signal_obj) {
    signal_history.push({
        ...signal_obj,
        receivedAt: new Date().toISOString()
    });
    
    if (signal_history.length > MAX_HISTORY) {
        signal_history.shift();
    }
    
    console.log(`[SIGNAL-STORED] ${signal_obj.action} | ${signal_obj.symbol} | Numeric: ${signal_obj.signal} | ID: ${signal_obj.id}`);
}

/**
 * Validate token from header or body
 */
function validateToken(req) {
    let token = req.headers["x-webhook-token"] || "";
    
    if (!token && req.body) {
        token = req.body.secret || "";
    }
    
    const isValid = token === SECRET_TOKEN;
    
    if (!isValid) {
        console.log(`  ⚠️  Token validation FAILED | Provided: "${token.substring(0, 10)}..." | Expected: "${SECRET_TOKEN.substring(0, 10)}..."`);
    } else {
        console.log(`  ✅ Token validation PASSED`);
    }
    
    return isValid;
}

/**
 * Sanitize and normalize input (uppercase trim)
 */
function sanitize(str) {
    if (typeof str !== 'string') {
        return "";
    }
    return str.trim().toUpperCase();
}

/**
 * Generate signal ID (for deduplication)
 */
function generateSignalId() {
    return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ==================== API ENDPOINTS ====================

/**
 * POST /webhook
 * Handle TradingView alerts and MT5 EA get_signal requests
 * This is the MAIN ENDPOINT
 */
app.post("/webhook", (req, res) => {
    console.log("  📨 Processing webhook request...");
    
    // ========== STEP 1: VALIDATE TOKEN ==========
    if (!validateToken(req)) {
        console.log("  ❌ Token validation failed - REJECTING");
        return res.status(401).json({
            status: "unauthorized",
            message: "Invalid or missing token",
            timestamp: new Date().toISOString()
        });
    }
    
    // ========== STEP 2: VALIDATE JSON ==========
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
        console.log("  ❌ Invalid JSON payload");
        return res.status(400).json({
            status: "bad_request",
            message: "Invalid JSON payload",
            timestamp: new Date().toISOString()
        });
    }
    
    // ========== STEP 3: EXTRACT & NORMALIZE EVENT TYPE ==========
    const rawEvent = payload.event || "";
    const event_type = sanitize(rawEvent);
    
    console.log(`  📋 Event Type: "${rawEvent}" → Normalized: "${event_type}"`);
    
    if (!event_type) {
        console.log("  ❌ Missing event field");
        return res.status(400).json({
            status: "bad_request",
            message: "Missing 'event' field",
            timestamp: new Date().toISOString()
        });
    }
    
    // ========== PING EVENT ==========
    if (event_type === "PING") {
        console.log("  🏓 PING received - responding with PONG");
        return res.status(200).json({
            status: "ok",
            message: "pong",
            timestamp: new Date().toISOString()
        });
    }
    
    // ========== ALERT EVENT (TradingView) ==========
    else if (event_type === "ALERT") {
        console.log("  🚨 ALERT event detected (TradingView)");
        
        const symbol = sanitize(payload.symbol || "");
        const action = sanitize(payload.action || payload.signal || "");
        const price = payload.price || "";
        const timeframe = payload.timeframe || "";
        
        // Validate symbol
        if (!symbol) {
            console.log("  ❌ Symbol is required for ALERT event");
            return res.status(400).json({
                status: "bad_request",
                message: "Symbol is required for ALERT event",
                timestamp: new Date().toISOString()
            });
        }
        
        // Validate action
        if (!["BUY", "SELL"].includes(action)) {
            console.log(`  ❌ Invalid action: "${action}". Expected BUY or SELL`);
            return res.status(400).json({
                status: "bad_request",
                message: `Invalid action: "${action}". Expected BUY or SELL`,
                timestamp: new Date().toISOString()
            });
        }
        
        // Convert action to numeric signal
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
            timeframe: timeframe
        };
        
        // Log to history
        logSignal(latest_signal);
        
        console.log(`  ✅ [ALERT-RECEIVED] Symbol: ${symbol} | Action: ${action} | Price: ${price} | TF: ${timeframe}`);
        console.log(`  💾 Signal stored in memory (awaiting EA retrieval)`);
        
        return res.status(200).json({
            status: "ok",
            message: "Alert received and stored",
            signal: numeric_signal,
            id: signal_id,
            timestamp: new Date().toISOString()
        });
    }
    
    // ========== GET_SIGNAL EVENT (MT5 EA) ==========
    else if (event_type === "GET_SIGNAL") {
        console.log("  🤖 GET_SIGNAL event detected (MT5 EA)");
        
        if (latest_signal.signal !== 0) {
            // Signal available - send it
            const signal_to_send = {
                signal: latest_signal.signal,
                symbol: latest_signal.symbol,
                action: latest_signal.action,
                timestamp: latest_signal.timestamp,
                id: latest_signal.id
            };
            
            console.log(`  📤 [SIGNAL-SENT] ${latest_signal.action} | ${latest_signal.symbol} | ID: ${latest_signal.id}`);
            console.log(`  🔄 Resetting signal to prevent duplicate trades`);
            
            // Reset after retrieval (prevent duplicate trades)
            latest_signal.signal = 0;
            
            return res.status(200).json({
                status: "ok",
                ...signal_to_send
            });
        } else {
            // No signal available
            console.log(`  📭 [NO-SIGNAL] EA polled but no signal available`);
            return res.status(200).json({
                status: "no_signal",
                signal: 0,
                id: ""
            });
        }
    }
    
    // ========== CREATE EVENT ==========
    else if (event_type === "CREATE") {
        console.log("  ✏️  CREATE event detected");
        return res.status(201).json({
            status: "created",
            data: payload.data || {},
            timestamp: new Date().toISOString()
        });
    }
    
    // ========== UNKNOWN EVENT ==========
    else {
        console.log(`  ⚠️  Unknown event type: "${event_type}"`);
        return res.status(202).json({
            status: "ignored",
            message: `Unknown event type: ${event_type}`,
            available_events: ["PING", "ALERT", "GET_SIGNAL", "CREATE"],
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * POST /webhook/signal
 * Alternative endpoint (same functionality as POST /webhook with GET_SIGNAL)
 * Direct signal retrieval for EA
 */
app.post("/webhook/signal", (req, res) => {
    console.log("  📨 /webhook/signal endpoint called");
    
    if (!validateToken(req)) {
        console.log("  ❌ Token validation failed");
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
        
        console.log(`  📤 Signal sent: ${signal_to_send.action} ${signal_to_send.symbol}`);
        latest_signal.signal = 0;
        
        return res.json({
            status: "ok",
            ...signal_to_send
        });
    }
    
    console.log(`  📭 No signal available`);
    return res.json({
        status: "no_signal",
        signal: 0,
        id: ""
    });
});

/**
 * GET /get_signal
 * Legacy endpoint for backward compatibility
 * Direct signal retrieval (GET method)
 */
app.get("/get_signal", (req, res) => {
    console.log("  📨 /get_signal endpoint called (legacy GET)");
    
    const token = req.headers["x-webhook-token"] || req.query.token || "";
    
    if (token !== SECRET_TOKEN) {
        console.log("  ❌ Token validation failed");
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
        
        console.log(`  📤 Signal sent: ${signal_to_send.action} ${signal_to_send.symbol}`);
        latest_signal.signal = 0;
        
        return res.json({
            status: "ok",
            ...signal_to_send
        });
    }
    
    console.log(`  📭 No signal available`);
    return res.json({
        status: "no_signal",
        signal: 0,
        id: ""
    });
});

/**
 * GET /health
 * Health check for uptime monitoring
 */
app.get("/health", (req, res) => {
    res.status(200).json({
        status: "healthy",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        latest_signal_state: latest_signal.signal,
        pending_signal: latest_signal.signal !== 0
    });
});

/**
 * GET /status
 * Detailed status endpoint with full signal history
 */
app.get("/status", (req, res) => {
    res.json({
        status: "running",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        latest_signal: latest_signal,
        pending_signal: latest_signal.signal !== 0 ? "YES ⏳" : "NO",
        recent_history: signal_history.slice(-10),
        total_signals_processed: signal_history.length,
        max_history_size: MAX_HISTORY,
        server_config: {
            port: PORT,
            host: HOST,
            ssl_enabled: fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH)
        }
    });
});

/**
 * GET /
 * Main status page / API info
 */
app.get("/", (req, res) => {
    const hasSSL = fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH);
    
    res.json({
        status: "running ✅",
        secure: hasSSL ? "HTTPS 🔒" : "HTTP ⚠️",
        version: "4.1",
        endpoints: {
            "POST /webhook": "Main webhook (TradingView alerts + EA polling)",
            "POST /webhook/signal": "Alternative signal retrieval",
            "GET /get_signal": "Legacy signal retrieval (backward compatible)",
            "GET /health": "Health check",
            "GET /status": "Detailed status & signal history",
            "GET /": "This page"
        },
        latest_signal: latest_signal,
        pending_signal: latest_signal.signal !== 0,
        timestamp: new Date().toISOString()
    });
});

/**
 * 404 Handler
 */
app.use((req, res) => {
    console.log(`  ❌ 404 Not Found: ${req.method} ${req.path}`);
    res.status(404).json({
        status: "not_found",
        message: `${req.method} ${req.path} not found`,
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

// ==================== KEEP-ALIVE PING ====================
setInterval(() => {
    console.log(`🔄 [HEARTBEAT] Server alive | Time: ${new Date().toISOString()} | Pending Signal: ${latest_signal.signal !== 0 ? "YES ⏳" : "NO"}`);
}, 60000); // Every 60 seconds

// ==================== ERROR HANDLING ====================
process.on('uncaughtException', (err) => {
    console.error(`\n❌ UNCAUGHT EXCEPTION:\n`, err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`\n❌ UNHANDLED REJECTION:\n`, reason);
});

// ==================== SERVER STARTUP ====================
const startServer = () => {
    const hasSSL = fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH);
    
    if (hasSSL) {
        try {
            const options = {
                key: fs.readFileSync(SSL_KEY_PATH),
                cert: fs.readFileSync(SSL_CERT_PATH)
            };
            
            https.createServer(options, app).listen(PORT, HOST, () => {
                console.log(`\n${'='.repeat(70)}`);
                console.log(`✅ HTTPS WEBHOOK SERVER STARTED - v4.1`);
                console.log(`${'='.repeat(70)}`);
                console.log(`🔐 Protocol: HTTPS (Secure)`);
                console.log(`🌐 Address:  https://${HOST}:${PORT}`);
                console.log(`📍 Main:     POST /webhook`);
                console.log(`❤️  Health:   GET /health`);
                console.log(`📊 Status:   GET /status`);
                console.log(`🔑 Token:    ${SECRET_TOKEN.substring(0, 15)}...`);
                console.log(`${'='.repeat(70)}\n`);
                
                console.log(`⏰ Keep-alive Heartbeat: Active (60s interval)`);
                console.log(`📡 Ready to receive signals from TradingView & MT5 EA\n`);
            });
        } catch (err) {
            console.error(`⚠️  SSL Error: ${err.message}`);
            console.log("Falling back to HTTP...\n");
            startHTTP();
        }
    } else {
        startHTTP();
    }
};

const startHTTP = () => {
    app.listen(PORT, HOST, () => {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`⚠️  HTTP SERVER STARTED (DEVELOPMENT ONLY) - v4.1`);
        console.log(`${'='.repeat(70)}`);
        console.log(`🌐 Protocol: HTTP (Not Secure)`);
        console.log(`🌐 Address:  http://${HOST}:${PORT}`);
        console.log(`📍 Main:     POST /webhook`);
        console.log(`❤️  Health:   GET /health`);
        console.log(`📊 Status:   GET /status`);
        console.log(`🔑 Token:    ${SECRET_TOKEN.substring(0, 15)}...`);
        console.log(`📝 Note:     For production, place cert.pem & key.pem in root`);
        console.log(`${'='.repeat(70)}\n`);
        
        console.log(`⏰ Keep-alive Heartbeat: Active (60s interval)`);
        console.log(`📡 Ready to receive signals from TradingView & MT5 EA\n`);
    });
};

// Start server
startServer();

