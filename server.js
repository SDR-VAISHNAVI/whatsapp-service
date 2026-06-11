const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

let clientReady = false;
let currentQR = null;

// ==============================
// CHROME PATH RESOLUTION
// ==============================

function findChrome() {
    console.log('--- Chrome Discovery ---');
    console.log('__dirname:', __dirname);
    console.log('HOME:', process.env.HOME);
    console.log('PUPPETEER_EXECUTABLE_PATH env:', process.env.PUPPETEER_EXECUTABLE_PATH || '(not set)');

    // Log everything we can find
    try {
        const allChrome = execSync('find / -name "chrome" -type f 2>/dev/null | grep -v proc | head -20').toString().trim();
        console.log('All chrome binaries found:\n', allChrome || '(none)');
    } catch (_) {}

    try {
        const cacheContents = execSync('find /opt/render -type d -name "puppeteer" 2>/dev/null').toString().trim();
        console.log('Puppeteer dirs under /opt/render:\n', cacheContents || '(none)');
    } catch (_) {}

    try {
        const projectCache = execSync(`find "${__dirname}" -type d -name "chrome*" 2>/dev/null | head -5`).toString().trim();
        console.log('Chrome dirs in project:\n', projectCache || '(none)');
    } catch (_) {}

    // 1. Explicit env var — but VERIFY the file actually exists first
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
        if (fs.existsSync(envPath)) {
            console.log('✅ Using verified env path:', envPath);
            return envPath;
        } else {
            console.warn('⚠️  Env var path does NOT exist on disk:', envPath, '— ignoring it');
        }
    }

    // 2. Project-local cache (where `npx puppeteer browsers install chrome` puts it
    //    when run from the project dir during build)
    const projectCacheDirs = [
        path.join(__dirname, '.cache', 'puppeteer'),
        path.join(__dirname, 'node_modules', 'puppeteer', '.local-chromium'),
        path.join(__dirname, 'node_modules', 'puppeteer-core', '.local-chromium'),
    ];
    for (const dir of projectCacheDirs) {
        if (fs.existsSync(dir)) {
            try {
                const found = execSync(`find "${dir}" -name "chrome" -type f 2>/dev/null | head -1`).toString().trim();
                if (found) { console.log('✅ Found in project cache:', found); return found; }
            } catch (_) {}
        }
    }

    // 3. Broad search under the project root
    try {
        const found = execSync(`find "${__dirname}" -name "chrome" -type f 2>/dev/null | head -1`).toString().trim();
        if (found) { console.log('✅ Found under project root:', found); return found; }
    } catch (_) {}

    // 4. HOME cache
    const home = process.env.HOME || '/root';
    try {
        const found = execSync(`find "${home}" -name "chrome" -type f 2>/dev/null | head -1`).toString().trim();
        if (found) { console.log('✅ Found under HOME:', found); return found; }
    } catch (_) {}

    // 5. System chrome
    try {
        const sys = execSync('which google-chrome-stable google-chrome chromium-browser chromium 2>/dev/null | head -1').toString().trim();
        if (sys) { console.log('✅ System Chrome:', sys); return sys; }
    } catch (_) {}

    console.error('❌ Chrome not found anywhere. Build command may not be persisting files.');
    return null;
}

// ==============================
// WHATSAPP CLIENT
// ==============================

const chromePath = findChrome();
console.log('--- Using Chrome:', chromePath, '---');

if (!chromePath) {
    console.error('FATAL: No Chrome binary found. Cannot start WhatsApp client.');
    console.error('Fix: make sure your Render build command is: npm install && npx puppeteer browsers install chrome');
    process.exit(1);
}

const client = new Client({
    authStrategy: new LocalAuth(),
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

client.on('disconnected', () => {
    console.log('⚠️ WhatsApp disconnected! Reinitializing...');
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
        message: clientReady ? '✅ WhatsApp connected!' : '⏳ Waiting for QR scan...',
        chromePath
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
                <p>Please wait and refresh this page in 10 seconds.</p>
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
    console.log(`📱 Open /qr to scan QR code`);
});
