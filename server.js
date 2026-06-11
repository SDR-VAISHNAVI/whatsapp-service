const { Client, RemoteAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const SupabaseStore = require('./SupabaseStore');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

let clientReady = false;
let currentQR = null;

// ==============================
// SUPABASE
// ==============================

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ==============================
// CHROME PATH RESOLUTION
// ==============================

function findChrome() {
    console.log('--- Chrome Discovery ---');
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
        if (fs.existsSync(envPath)) {
            console.log('✅ Using env path:', envPath);
            return envPath;
        }
    }
    const projectCacheDirs = [
        path.join(__dirname, '.cache', 'puppeteer'),
        path.join(__dirname, 'node_modules', 'puppeteer', '.local-chromium'),
    ];
    for (const dir of projectCacheDirs) {
        if (fs.existsSync(dir)) {
            try {
                const found = execSync(`find "${dir}" -name "chrome" -type f 2>/dev/null | head -1`).toString().trim();
                if (found) return found;
            } catch (_) {}
        }
    }
    try {
        const found = execSync(`find "${__dirname}" -name "chrome" -type f 2>/dev/null | head -1`).toString().trim();
        if (found) return found;
    } catch (_) {}
    try {
        const sys = execSync('which google-chrome-stable google-chrome chromium 2>/dev/null | head -1').toString().trim();
        if (sys) return sys;
    } catch (_) {}
    return null;
}

const chromePath = findChrome();
if (!chromePath) {
    console.error('FATAL: No Chrome binary found.');
    process.exit(1);
}

// ==============================
// WHATSAPP CLIENT
// ==============================

const store = new SupabaseStore(supabase);

const client = new Client({
    authStrategy: new RemoteAuth({
        clientId: 'dojo-whatsapp',
        store,
        backupSyncIntervalMs: 300000
    }),
    puppeteer: {
        headless: true,
        executablePath: chromePath,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

client.on('qr', async (qr) => {
    console.log('\n📱 New QR Code generated!');
    qrcode.generate(qr, { small: true });
    try {
        currentQR = await QRCode.toDataURL(qr);
        console.log('QR available at /qr endpoint');
    } catch (e) {
        console.error('QR generation error:', e);
    }
});

client.on('ready', () => {
    console.log('✅ WhatsApp client is ready!');
    clientReady = true;
    currentQR = null;
});

client.on('auth_failure', () => {
    console.error('❌ Auth failed!');
    clientReady = false;
});

client.on('remote_session_saved', () => {
    console.log('✅ Session saved to Supabase!');
});

client.on('disconnected', () => {
    console.log('⚠️ Disconnected! Reinitializing...');
    clientReady = false;
    client.initialize();
});

console.log('🚀 Initializing WhatsApp client...');
client.initialize();

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
        const number = phone + '@c.us';
        const message =
`🥋 *Dojo Attendance Alert*

Dear Parent,
Your ward *${student.name}* was absent for today's karate class on *${date}*.

Please ensure regular attendance to maintain progress.

Regards,
Dojo Management 🥋`;
        try {
            await client.sendMessage(number, message);
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

app.listen(PORT, () => {
    console.log(`🌐 WhatsApp service running on port ${PORT}`);
});
