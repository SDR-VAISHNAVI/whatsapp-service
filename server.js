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

// ── Per-owner runtime state ────────────────────────────────
// Map<owner_id_string, { sock, ready, qr, connecting }>
const ownerSessions = new Map();

function getState(ownerId) {
    const key = String(ownerId);
    if (!ownerSessions.has(key)) {
        ownerSessions.set(key, { sock: null, ready: false, qr: null, connecting: false });
    }
    return ownerSessions.get(key);
}

// ── Session dir per owner ─────────────────────────────────
function sessionDir(ownerId) {
    const dir = path.join('/tmp', `wa-session-${ownerId}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// ── Supabase session load/save ────────────────────────────
async function loadSession(ownerId) {
    const { data, error } = await supabase
        .from('whatsapp_sessions')
        .select('session')
        .eq('owner_id', ownerId)
        .single();
    if (error || !data) return;
    try {
        const dir   = sessionDir(ownerId);
        const files = JSON.parse(data.session);
        for (const [file, content] of Object.entries(files)) {
            fs.writeFileSync(path.join(dir, file), JSON.stringify(content));
        }
        console.log(`[owner:${ownerId}] ✅ session loaded`);
    } catch (e) {
        console.error(`[owner:${ownerId}] load error:`, e.message);
    }
}

async function saveSession(ownerId) {
    try {
        const dir = sessionDir(ownerId);
        if (!fs.existsSync(dir)) return;
        const files = {};
        for (const file of fs.readdirSync(dir)) {
            const raw = fs.readFileSync(path.join(dir, file), 'utf8');
            try { files[file] = JSON.parse(raw); } catch { files[file] = raw; }
        }
        const { error } = await supabase.from('whatsapp_sessions').upsert({
            owner_id:   ownerId,
            session:    JSON.stringify(files),
            updated_at: new Date().toISOString()
        }, { onConflict: 'owner_id' });
        if (error) throw error;
        console.log(`[owner:${ownerId}] ✅ session saved`);
    } catch (e) {
        console.error(`[owner:${ownerId}] save error:`, e.message);
    }
}

async function clearSession(ownerId) {
    const dir = sessionDir(ownerId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    await supabase.from('whatsapp_sessions').delete().eq('owner_id', ownerId);
}

// ── Core connect function ─────────────────────────────────
async function connectOwner(ownerId) {
    const state = getState(ownerId);
    if (state.connecting) return;
    state.connecting = true;

    try {
        await loadSession(ownerId);
        const dir = sessionDir(ownerId);

        // Validate creds
        const credsPath = path.join(dir, 'creds.json');
        if (fs.existsSync(credsPath)) {
            try {
                const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                if (!creds.me) {
                    console.log(`[owner:${ownerId}] incomplete creds — clearing`);
                    fs.rmSync(dir, { recursive: true, force: true });
                    fs.mkdirSync(dir, { recursive: true });
                }
            } catch {
                console.log(`[owner:${ownerId}] corrupt creds — clearing`);
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
            await saveSession(ownerId);
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                state.qr    = await QRCode.toDataURL(qr);
                state.ready = false;
                console.log(`[owner:${ownerId}] QR generated`);
            }

            if (connection === 'open') {
                state.ready      = true;
                state.qr         = null;
                state.connecting = false;
                await saveSession(ownerId);
                console.log(`[owner:${ownerId}] ✅ connected`);
            }

            if (connection === 'close') {
                state.ready      = false;
                state.connecting = false;
                const code = lastDisconnect?.error instanceof Boom
                    ? lastDisconnect.error.output?.statusCode : null;
                const reconnect = code !== DisconnectReason.loggedOut;
                console.log(`[owner:${ownerId}] closed (${code}). reconnect=${reconnect}`);
                if (reconnect) {
                    setTimeout(() => connectOwner(ownerId), 5000);
                } else {
                    await clearSession(ownerId);
                    state.qr   = null;
                    state.sock = null;
                    setTimeout(() => connectOwner(ownerId), 5000);
                }
            }
        });

    } catch (err) {
        console.error(`[owner:${ownerId}] connect error:`, err.message);
        state.connecting = false;
        setTimeout(() => connectOwner(ownerId), 10000);
    }
}

// ── Helper: validate owner_id ─────────────────────────────
function parseOwner(req) {
    const id = parseInt(req.query.owner_id || req.body?.owner_id);
    if (!id || isNaN(id)) return null;
    return id;
}

// ── ROUTES ────────────────────────────────────────────────

// Status check — called from Flask /api/whatsapp/status
app.get('/status', (req, res) => {
    const ownerId = parseOwner(req);
    if (!ownerId) return res.status(400).json({ error: 'owner_id required' });
    const state = getState(ownerId);
    res.json({ connected: state.ready, has_qr: !!state.qr });
});

// QR data — called from Flask /api/whatsapp/qr
app.get('/qr-data', (req, res) => {
    const ownerId = parseOwner(req);
    if (!ownerId) return res.status(400).json({ error: 'owner_id required' });
    const state = getState(ownerId);
    if (state.ready) return res.json({ connected: true });
    if (!state.qr)   return res.json({ connected: false, qr: null, message: 'Generating QR…' });
    res.json({ connected: false, qr: state.qr });
});

// Connect (start session for owner) — called from frontend
app.post('/connect', (req, res) => {
    const ownerId = parseOwner(req);
    if (!ownerId) return res.status(400).json({ error: 'owner_id required' });
    const state = getState(ownerId);
    if (!state.ready && !state.connecting) {
        connectOwner(ownerId);
    }
    res.json({ started: true });
});

// Logout (clear session for owner)
app.post('/logout', async (req, res) => {
    const ownerId = parseOwner(req);
    if (!ownerId) return res.status(400).json({ error: 'owner_id required' });
    const state = getState(ownerId);
    state.ready = false; state.qr = null;
    if (state.sock) {
        try { await state.sock.logout(); } catch {}
        state.sock = null;
    }
    await clearSession(ownerId);
    setTimeout(() => connectOwner(ownerId), 1000);
    res.json({ success: true });
});

// Send absence messages
app.post('/send-absence', async (req, res) => {
    const { owner_id, students, date } = req.body;
    const ownerId = parseInt(owner_id);
    if (!ownerId) return res.status(400).json({ error: 'owner_id required' });

    const state = getState(ownerId);
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
            await new Promise(r => setTimeout(r, 1000));
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
app.listen(PORT, () => {
    console.log(`🌐 WhatsApp service on port ${PORT}`);
    // Don't auto-connect here — owners connect on-demand from the UI
});
