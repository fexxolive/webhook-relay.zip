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

// Request logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
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
    
    console.log(`[SIGNAL-STORED] ${signal_obj.action} | ${signal_obj.symbol} | Numeric: ${signal_obj.signal}`);
}

/**
 * Validate token from header or body
 */
function validateToken(req) {
    let token = req.headers["x-webhook-token"] || "";
    
    if (!token && req.body) {
        token = req.body.secret || "";
    }
    
    return token === SECRET_TOKEN;
}

/**
 * Sanitize input
 */
function sanitize(str) {
    if (typeof str !== 'string') return "";
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
 */
app.post("/webhook", (req, res) => {
    // Validate token
    if (!validateToken(req)) {
        return res.status(401).json({
            status: "unauthorized",
            message: "Invalid or missing token",
            timestamp: new Date().toISOString()
        });
    }
    
    // Validate request body
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
        return res.status(400).json({
            status: "bad_request",
            message: "Invalid JSON payload",
            timestamp: new Date().toISOString()
        });
    }
    
    // Get event type
    const event_type = sanitize(payload.event || "");
    
    if (!event_type) {
        return res.status(400).json({
            status: "bad_request",
            message: "Missing 'event' field",
            timestamp: new Date().toISOString()
        });
    }
    
    // ========== PING EVENT ==========
    if (event_type === "PING") {
        return res.status(200).json({
            status: "ok",
            message: "pong",
            timestamp: new Date().toISOString()
        });
    }
    
    // ========== ALERT EVENT (TradingView) ==========
    else if (event_type === "ALERT") {
        const symbol = sanitize(payload.symbol || "");
        const action = sanitize(payload.action || payload.signal || "");
        const price = payload.price || "";
        const timeframe = payload.timeframe || "";
        
        // Validate symbol
        if (!symbol) {
            return res.status(400).json({
                status: "bad_request",
                message: "Symbol is required for ALERT event",
                timestamp: new Date().toISOString()
            });
        }
        
        // Validate action
        if (!["BUY", "SELL"].includes(action)) {
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
        
        console.log(`✅ [ALERT-RECEIVED] Symbol: ${symbol} | Action: ${action} | Price: ${price} | TF: ${timeframe}`);
        
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
        if (latest_signal.signal !== 0) {
            const signal_to_send = {
                signal: latest_signal.signal,
                symbol: latest_signal.symbol,
                action: latest_signal.action,
                timestamp: latest_signal.timestamp,
                id: latest_signal.id
            };
            
            // Reset after retrieval (prevent duplicate trades)
            console.log(`📤 [SIGNAL-SENT] ${latest_signal.action} | ${latest_signal.symbol} | ID: ${latest_signal.id}`);
            latest_signal.signal = 0;
            
            return res.status(200).json({
                status: "ok",
                ...signal_to_send
            });
        } else {
            return res.status(200).json({
                status: "no_signal",
                signal: 0
            });
        }
    }
    
    // ========== CREATE EVENT ==========
    else if (event_type === "CREATE") {
        return res.status(201).json({
            status: "created",
            data: payload.data || {},
            timestamp: new Date().toISOString()
        });
    }
    
    // ========== UNKNOWN EVENT ==========
    else {
        return res.status(202).json({
            status: "ignored",
            message: `Unknown event type: ${event_type}`,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * POST /webhook/signal
 * Alternative endpoint (same functionality as POST /webhook with GET_SIGNAL)
 */
app.post("/webhook/signal", (req, res) => {
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
        
        return res.json({
            status: "ok",
            ...signal_to_send
        });
    }
    
    return res.json({
        status: "no_signal",
        signal: 0
    });
});

/**
 * GET /get_signal
 * Legacy endpoint for backward compatibility
 */
app.get("/get_signal", (req, res) => {
    const token = req.headers["x-webhook-token"] || req.query.token || "";
    
    if (token !== SECRET_TOKEN) {
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
        
        return res.json({
            status: "ok",
            ...signal_to_send
        });
    }
    
    return res.json({
        status: "no_signal",
        signal: 0
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
        latest_signal_state: latest_signal.signal
    });
});

/**
 * GET /status
 * Detailed status endpoint
 */
app.get("/status", (req, res) => {
    res.json({
        status: "running",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        latest_signal: latest_signal,
        recent_history: signal_history.slice(-10),
        total_signals_processed: signal_history.length
    });
});

/**
 * GET /
 * Main status page
 */
app.get("/", (req, res) => {
    const hasSSL = fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH);
    
    res.json({
        status: "running",
        secure: hasSSL,
        endpoints: {
            "POST /webhook": "Main webhook endpoint (TradingView + EA)",
            "POST /webhook/signal": "Alternative signal endpoint",
            "GET /get_signal": "Legacy signal retrieval",
            "GET /health": "Health check",
            "GET /status": "Detailed status"
        },
        latest_signal: latest_signal,
        timestamp: new Date().toISOString()
    });
});

/**
 * 404 Handler
 */
app.use((req, res) => {
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
    console.log(`🔄 [PING] Server alive at ${new Date().toISOString()}`);
}, 60000); // Every 60 seconds

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
                console.log(`\n${'='.repeat(60)}`);
                console.log(`✅ HTTPS Webhook Server Started`);
                console.log(`🔐 https://${HOST}:${PORT}`);
                console.log(`📍 Main Endpoint: /webhook`);
                console.log(`❤️  Health Check: /health`);
                console.log(`📊 Status Page: /status`);
                console.log(`${'='.repeat(60)}\n`);
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
        console.log(`\n${'='.repeat(60)}`);
        console.log(`⚠️  HTTP Server Started (Development Only)`);
        console.log(`🌐 http://${HOST}:${PORT}`);
        console.log(`📝 For HTTPS, place cert.pem and key.pem in project root`);
        console.log(`📍 Main Endpoint: /webhook`);
        console.log(`❤️  Health Check: /health`);
        console.log(`📊 Status Page: /status`);
        console.log(`${'='.repeat(60)}\n`);
    });
};

// Start server
startServer();

console.log(`🔑 Token Auth: ${process.env.WEBHOOK_SECRET_TOKEN ? 'Custom' : 'Default'}`);
console.log(`⏰ Keep-alive: Active (60s interval)\n`);
