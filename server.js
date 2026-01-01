const express = require('express');
const https = require('https');
const fs = require('fs');
const app = express();

// Configuration
const SECRET_TOKEN = process.env.WEBHOOK_SECRET_TOKEN || "37ehADKNLy5psq1IvdUDYshxx_zuy2RYD72n7E858DYqR2";
const HOST = process.env.HOST || "0.0.0.0";
const PORT = process.env.PORT || 8443;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || "cert.pem";
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || "key.pem";

// Middleware
app.use(express.json());

// In-memory signal storage
let latest_signal = {
    signal: 0,
    symbol: "",
    timestamp: null,
    action: ""
};

/**
 * POST /webhook
 * Accept token from X-Webhook-Token header or 'secret' field in JSON body.
 * Convert BUY/SELL actions to numeric signals and store them.
 */
app.post("/webhook", (req, res) => {
    // Get token from header
    let token = req.headers["x-webhook-token"] || "";
    
    // Validate request body
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
        return res.status(400).json({
            status: "bad_request",
            message: "invalid json"
        });
    }
    
    // Fallback: get token from JSON body if header is empty
    if (!token) {
        token = payload.secret || "";
    }
    
    // Validate token
    if (token !== SECRET_TOKEN) {
        return res.status(401).json({
            status: "unauthorized",
            message: "invalid or missing token"
        });
    }
    
    // Validate required 'event' field
    if (!payload.event) {
        return res.status(400).json({
            status: "bad_request",
            message: "missing 'event' field"
        });
    }
    
    const event_type = payload.event;
    
    // Handle ping event
    if (event_type === "ping") {
        return res.status(200).json({
            status: "ok",
            message: "pong"
        });
    }
    
    // Handle alert event (TradingView signals)
    else if (event_type === "alert") {
        const symbol = payload.symbol || "";
        const action = payload.action || payload.signal || "";
        const price = payload.price || "";
        
        // Convert action to numeric signal: BUY → 1, SELL → -1
        let numeric_signal = 0;
        if (action && typeof action === 'string') {
            const action_upper = action.toUpperCase();
            if (action_upper === "BUY") {
                numeric_signal = 1;
            } else if (action_upper === "SELL") {
                numeric_signal = -1;
            }
        }
        
        // Store signal
        latest_signal = {
            signal: numeric_signal,
            symbol: symbol,
            action: action,
            timestamp: new Date().toISOString()
        };
        
        console.log(`[ALERT] Symbol: ${symbol}, Action: ${action}, Signal: ${numeric_signal}, Price: ${price}`);
        
        return res.status(200).json({
            status: "ok",
            message: "alert received",
            signal: numeric_signal
        });
    }
    
    // Handle create event
    else if (event_type === "create") {
        const data = payload.data || {};
        return res.status(201).json({
            status: "created",
            data: data
        });
    }
    
    // Unknown event type
    else {
        return res.status(202).json({
            status: "ignored",
            message: `unknown event ${event_type}`
        });
    }
});

/**
 * GET /get_signal
 * Endpoint for EA to poll and retrieve the latest numeric signal.
 * Returns signal and auto-resets to 0 (prevents duplicate trades).
 */
app.get("/get_signal", (req, res) => {
    if (latest_signal.signal !== 0) {
        const signal_to_return = latest_signal.signal;
        latest_signal.signal = 0; // Reset after retrieval
        
        return res.status(200).json({
            signal: signal_to_return,
            symbol: latest_signal.symbol,
            action: latest_signal.action,
            timestamp: latest_signal.timestamp
        });
    } else {
        return res.status(200).json({
            signal: 0
        });
    }
});

/**
  and status endpoint
 */
app.get("/", (req, res) => {
    res.status(200).json({
        status: "running",
        secure: fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH),
        latest_signal: latest_signal
    });
});

// Server startup logic - FIXED ✅
const startServer = () => {
    const hasSSL = fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH);
    
    if (hasSSL) {
        try {
            const options = {
                key: fs.readFileSync(SSL_KEY_PATH),
                cert: fs.readFileSync(SSL_CERT_PATH)
            };
            https.createServer(options, app).listen(PORT, HOST, () => {
                console.log(`✅ HTTPS server on https://${HOST}:${PORT}`);
            });
        } catch (err) {
            console.error(`⚠️  SSL Error: ${err.message}`);
            startHTTP();
        }
    } else {
        startHTTP();
    }
};

const startHTTP = () => {
    app.listen(PORT, HOST, () => {
        console.log(`⚠️  HTTP server on http://${HOST}:${PORT} (development only)`);
        console.log(`📝 Place cert.pem and key.pem for HTTPS support`);
    });
};

// Start server
startServer();
console.log(`🔐 Webhook Secret Configured: ${!!process.env.WEBHOOK_SECRET_TOKEN}`);
