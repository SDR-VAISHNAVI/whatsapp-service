const express  = require('express');
const QRCode   = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs   = require('fs');
const path = require('path');
const pino = require('pino');

const app  = express();
app.use(express.json());

const PORT     = process.env.PORT || 3000;
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Fixed row id for the single-owner session in Supabase. Using 1 keeps the
// existing whatsapp_sessions table schema (owner_id column) without a migration.
const SESSION_ID = 1;

// ── Single global runtime state (no per-owner Map needed) ─
const state = { sock: null, ready: false, qr: null, connecting: false };

// ── Session dir ────────────────────────────────────────────
const SESSION_DIR = path.join('/tmp', 'wa-session');
function ensureSessionDir() {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    return SESSION_DIR;
}

// ── Supabase session load/save ────────────────────────────
async function loadSession() {
    const { data, error } = await supabase
        .from('whatsapp_sessions')
        .select('session')
        .eq('owner_id', SESSION_ID)
        .single();
    if (error || !data) return;
    try {
        const dir   = ensureSessionDir();
        const files = JSON.parse(data.session);
        for (const [file, content] of Object.entries(files)) {
            fs.writeFileSync(path.join(dir, file), JSON.stringify(content));
        }
        console.log('✅ session loaded');
    } catch (e) {
        console.error('load error:', e.message);
    }
}

async function saveSession() {
    try {
        const dir = ensureSessionDir();
        if (!fs.existsSync(dir)) return;
        const files = {};
        for (const file of fs.readdirSync(dir)) {
            const raw = fs.readFileSync(path.join(dir, file), 'utf8');
            try { files[file] = JSON.parse(raw); } catch { files[file] = raw; }
        }
        const { error } = await supabase.from('whatsapp_sessions').upsert({
            owner_id:   SESSION_ID,
            session:    JSON.stringify(files),
            status:     'active',
            updated_at: new Date().toISOString()
        }, { onConflict: 'owner_id' });
        if (error) throw error;
        console.log('✅ session saved');
    } catch (e) {
        console.error('save error:', e.message);
    }
}

async function clearSession() {
    if (fs.existsSync(SESSION_DIR)) fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    await supabase.from('whatsapp_sessions').delete().eq('owner_id', SESSION_ID);
}

// Marks the row as logged-out WITHOUT deleting it — keeps history/data for debugging,
// only clears the local /tmp auth files so a fresh QR scan can happen.
async function markLoggedOut() {
    if (fs.existsSync(SESSION_DIR)) fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    try {
        const { error } = await supabase.from('whatsapp_sessions').update({
            status:     'logged_out',
            updated_at: new Date().toISOString()
        }).eq('owner_id', SESSION_ID);
        if (error) throw error;
        console.log('marked logged_out (Supabase row kept)');
    } catch (e) {
        console.error('markLoggedOut error:', e.message);
    }
}

// ── Core connect function ─────────────────────────────────
async function connectWhatsApp() {
    if (state.connecting) return;
    state.connecting = true;

    try {
        await loadSession();
        const dir = ensureSessionDir();

        // Validate creds
        const credsPath = path.join(dir, 'creds.json');
        if (fs.existsSync(credsPath)) {
            try {
                const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                if (!creds.me) {
                    console.log('incomplete creds — clearing');
                    fs.rmSync(dir, { recursive: true, force: true });
                    fs.mkdirSync(dir, { recursive: true });
                }
            } catch {
                console.log('corrupt creds — clearing');
                fs.rmSync(dir, { recursive: true, force: true });
                fs.mkdirSync(dir, { recursive: true });
            }
        }

        const { state: authState, saveCreds } = await useMultiFileAuthState(dir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth:              authState,
            printQRInTerminal: true,
            logger:            pino({ level: 'warn' }),
            browser:           ['BeltBook', 'Chrome', '120.0.0'],
        });

        state.sock = sock;

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            await saveSession();
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                state.qr    = await QRCode.toDataURL(qr);
                state.ready = false;
                console.log('QR generated');
            }

            if (connection === 'open') {
                state.ready      = true;
                state.qr         = null;
                state.connecting = false;
                await saveSession();
                console.log('✅ connected');
            }

            if (connection === 'close') {
                state.ready      = false;
                state.connecting = false;
                const code = lastDisconnect?.error instanceof Boom
                    ? lastDisconnect.error.output?.statusCode : null;
                const reconnect = code !== DisconnectReason.loggedOut;
                console.log(`closed (${code}). reconnect=${reconnect}`);
                if (reconnect) {
                    setTimeout(() => connectWhatsApp(), 5000);
                } else {
                    await markLoggedOut();
                    state.qr   = null;
                    state.sock = null;
                    setTimeout(() => connectWhatsApp(), 5000);
                }
            }
        });

    } catch (err) {
        console.error('connect error:', err.message);
        state.connecting = false;
        setTimeout(() => connectWhatsApp(), 10000);
    }
}

// ── ROUTES ────────────────────────────────────────────────
// No owner_id needed anywhere — single fixed session for this whole service.

// Status check — called from Flask /api/whatsapp/status
app.get('/status', (req, res) => {
    res.json({ connected: state.ready, has_qr: !!state.qr });
});

// QR data — called from Flask /api/whatsapp/qr
app.get('/qr-data', (req, res) => {
    if (state.ready) return res.json({ connected: true });
    if (!state.qr)   return res.json({ connected: false, qr: null, message: 'Generating QR…' });
    res.json({ connected: false, qr: state.qr });
});

// Connect (start session) — called from frontend
app.post('/connect', (req, res) => {
    if (!state.ready && !state.connecting) {
        connectWhatsApp();
    }
    res.json({ started: true });
});

// Logout (clear session)
app.post('/logout', async (req, res) => {
    state.ready = false; state.qr = null;
    if (state.sock) {
        try { await state.sock.logout(); } catch {}
        state.sock = null;
    }
    await clearSession();
    setTimeout(() => connectWhatsApp(), 1000);
    res.json({ success: true });
});

// Send absence messages
app.post('/send-absence', async (req, res) => {
    const { students, date } = req.body;

    if (!state.ready) {
        return res.status(503).json({ error: 'WhatsApp not connected. Scan QR first.' });
    }
    if (!students?.length) {
        return res.json({ success: true, sent: 0, failed: 0, results: [] });
    }

    const results = [];
    for (const student of students) {
        if (!student.phone_number) continue;
        const phone  = String(student.phone_number).replace(/[^0-9]/g, '');
        const number = phone.startsWith('91') ? phone : '91' + phone;
        const jid    = number + '@s.whatsapp.net';
        const msg    =
`🥋 *Belt Book — Absence Alert*

Dear Parent,
Your ward *${student.name}* was absent for today's karate class on *${date}*.

Please ensure regular attendance to maintain belt progression.

Regards,
Dojo Management 🏯`;
        try {
            await state.sock.sendMessage(jid, { text: msg });
            results.push({ name: student.name, status: 'sent' });
            // Randomized 3-5s delay between sends — looks more human, less bot-like to WhatsApp
            const delay = 3000 + Math.floor(Math.random() * 2000);
            await new Promise(r => setTimeout(r, delay));
        } catch (err) {
            results.push({ name: student.name, status: 'failed', error: err.message });
        }
    }
    res.json({
        success: true,
        sent:    results.filter(r => r.status === 'sent').length,
        failed:  results.filter(r => r.status === 'failed').length,
        results
    });
});

// Health
app.get('/', (req, res) => res.json({ service: 'BeltBook WhatsApp', status: 'ok' }));

// ── START ─────────────────────────────────────────────────
app.listen(PORT, async () => {
    console.log(`🌐 WhatsApp service on port ${PORT}`);
    // Auto-reconnect on boot if a saved (non-logged-out) session exists,
    // so a Render restart doesn't silently leave WhatsApp disconnected
    // until someone happens to hit /connect again.
    try {
        const { data, error } = await supabase
            .from('whatsapp_sessions')
            .select('owner_id')
            .eq('owner_id', SESSION_ID)
            .neq('status', 'logged_out')
            .maybeSingle();
        if (error) throw error;
        if (data) {
            console.log('auto-reconnecting on boot');
            connectWhatsApp();
        }
    } catch (e) {
        console.error('auto-reconnect on boot failed:', e.message);
    }
});
