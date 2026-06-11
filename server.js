const express = require('express');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

let sock = null;
let clientReady = false;
let currentQR = null;
let isConnecting = false;  // FIX 3: prevent overlapping reconnect calls

// ==============================
// SUPABASE SESSION STORE
// ==============================

const SESSION_DIR = '/tmp/whatsapp-session';

async function loadSessionFromSupabase() {
    try {
        const { data, error } = await supabase
            .from('whatsapp_sessions')
            .select('session')
            .eq('id', 'dojo-whatsapp')
            .single();
        if (error || !data) {
            console.log('No session found in Supabase, starting fresh');
            return;
        }
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        const sessionData = JSON.parse(data.session);
        for (const [filename, content] of Object.entries(sessionData)) {
            fs.writeFileSync(
                path.join(SESSION_DIR, filename),
                JSON.stringify(content)
            );
        }
        console.log('✅ Session loaded from Supabase');
    } catch (e) {
        console.error('Error loading session:', e);
    }
}

async function saveSessionToSupabase() {
    try {
        if (!fs.existsSync(SESSION_DIR)) return;
        const files = fs.readdirSync(SESSION_DIR);
        const sessionData = {};
        for (const file of files) {
            const content = fs.readFileSync(path.join(SESSION_DIR, file), 'utf8');
            try { sessionData[file] = JSON.parse(content); }
            catch { sessionData[file] = content; }
        }
        const { error } = await supabase
            .from('whatsapp_sessions')
            .upsert({
                id: 'dojo-whatsapp',
                session: JSON.stringify(sessionData),
                updated_at: new Date().toISOString()
            });
        if (error) throw error;
        console.log('✅ Session saved to Supabase');
    } catch (e) {
        console.error('Error saving session:', e);
    }
}

// ==============================
// WHATSAPP CONNECTION
// ==============================

async function connectWhatsApp() {
    // FIX 3: prevent duplicate connections
    if (isConnecting) {
        console.log('⚠️ Already connecting, skipping duplicate call');
        return;
    }
    isConnecting = true;

    try {
        await loadSessionFromSupabase();
        fs.mkdirSync(SESSION_DIR, { recursive: true });

        // FIX 1: clear stale/corrupt session files before connecting
        // If they exist but are broken, Baileys skips QR and fails silently.
        // We detect this by checking if creds.json is actually valid.
        const credsPath = path.join(SESSION_DIR, 'creds.json');
        if (fs.existsSync(credsPath)) {
            try {
                const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                // If me is missing, session is incomplete — wipe it so QR shows
                if (!creds.me) {
                    console.log('⚠️ Incomplete creds.json (no "me" field) — clearing session to force QR');
                    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                    fs.mkdirSync(SESSION_DIR, { recursive: true });
                }
            } catch {
                console.log('⚠️ Corrupt creds.json — clearing session to force QR');
                fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                fs.mkdirSync(SESSION_DIR, { recursive: true });
            }
        }

        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

        // FIX 2: use warn-level logger (not silent) so Baileys QR events fire reliably
        const logger = pino({ level: 'warn' });

        // FIX 2: fetch latest WA version to avoid version-mismatch QR failures
        const { version } = await fetchLatestBaileysVersion();
        console.log(`Using WA version: ${version.join('.')}`);

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            logger,
            // FIX 2: browser identity helps avoid QR being skipped by WA servers
            browser: ['Dojo Bot', 'Chrome', '120.0.0'],
        });

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            await saveSessionToSupabase();
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('📱 New QR generated');
                currentQR = await QRCode.toDataURL(qr);
                clientReady = false;
            }

            if (connection === 'open') {
                console.log('✅ WhatsApp connected!');
                clientReady = true;
                currentQR = null;
                isConnecting = false;
                await saveSessionToSupabase();
            }

            if (connection === 'close') {
                clientReady = false;
                isConnecting = false;  // allow reconnect
                const statusCode = lastDisconnect?.error instanceof Boom
                    ? lastDisconnect.error.output?.statusCode
                    : null;

                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`⚠️ Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);

                if (shouldReconnect) {
                    setTimeout(connectWhatsApp, 5000);
                } else {
                    console.log('Logged out — clearing session');
                    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                    await supabase
                        .from('whatsapp_sessions')
                        .delete()
                        .eq('id', 'dojo-whatsapp');
                    currentQR = null;
                    setTimeout(connectWhatsApp, 5000);
                }
            }
        });

    } catch (err) {
        console.error('connectWhatsApp error:', err);
        isConnecting = false;
        setTimeout(connectWhatsApp, 10000);
    }
}

// ==============================
// ROUTES
// ==============================

app.get('/', (req, res) => {
    res.json({
        status: clientReady ? 'ready' : 'waiting',
        message: clientReady ? '✅ WhatsApp connected!' : '⏳ Waiting for QR scan...'
    });
});

app.get('/qr', (req, res) => {
    if (clientReady) {
        return res.send(`
            <html><body style="background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:40px;">
                <h2 style="color:#00e676;">✅ WhatsApp Already Connected!</h2>
                <p>No need to scan QR. Service is running.</p>
            </body></html>
        `);
    }
    if (!currentQR) {
        return res.send(`
            <html><body style="background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:40px;">
                <h2>⏳ Generating QR Code...</h2>
                <p>Please wait and refresh in 10 seconds.</p>
                <script>setTimeout(() => location.reload(), 5000);</script>
            </body></html>
        `);
    }
    res.send(`
        <html><body style="background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:40px;">
            <h2 style="color:#00c8ff;">📱 Scan QR Code with WhatsApp</h2>
            <p>Open WhatsApp → Settings → Linked Devices → Link a Device</p>
            <img src="${currentQR}" style="margin:20px auto;display:block;border:4px solid #fff;border-radius:12px;"/>
            <p style="color:#888;">Page auto-refreshes every 10 seconds</p>
            <script>setTimeout(() => location.reload(), 10000);</script>
        </body></html>
    `);
});

// Endpoint to force re-login (clears session and triggers new QR)
app.post('/logout', async (req, res) => {
    clientReady = false;
    currentQR = null;
    if (sock) {
        try { await sock.logout(); } catch {}
        sock = null;
    }
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    await supabase.from('whatsapp_sessions').delete().eq('id', 'dojo-whatsapp');
    setTimeout(connectWhatsApp, 1000);
    res.json({ success: true, message: 'Logged out. New QR will appear at /qr shortly.' });
});

app.post('/send-absence', async (req, res) => {
    if (!clientReady) {
        return res.status(503).json({ error: 'WhatsApp not connected yet. Please scan QR first.' });
    }
    const { students, date } = req.body;
    if (!students || !students.length) {
        return res.json({ success: true, sent: 0, message: 'No absent students' });
    }
    const results = [];
    for (const student of students) {
        if (!student.phone_number) continue;
        const phone = String(student.phone_number).replace(/[^0-9]/g, '');
        const number = phone.startsWith('91') ? phone : '91' + phone;
        const jid = number + '@s.whatsapp.net';

        const message =
`🥋 *Dojo Attendance Alert*

Dear Parent,
Your ward *${student.name}* was absent for today's karate class on *${date}*.

Please ensure regular attendance to maintain progress.

Regards,
Dojo Management 🥋`;

        try {
            await sock.sendMessage(jid, { text: message });
            console.log(`✅ Sent to ${student.name} (${phone})`);
            results.push({ name: student.name, status: 'sent' });
            await new Promise(r => setTimeout(r, 1000));
        } catch (err) {
            console.error(`❌ Failed for ${student.name}:`, err.message);
            results.push({ name: student.name, status: 'failed', error: err.message });
        }
    }
    res.json({
        success: true,
        sent: results.filter(r => r.status === 'sent').length,
        failed: results.filter(r => r.status === 'failed').length,
        results
    });
});

// ==============================
// START
// ==============================

app.listen(PORT, () => {
    console.log(`🌐 WhatsApp service running on port ${PORT}`);
    connectWhatsApp();  // FIX 3: start after server is ready
});
