const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

let clientReady = false;
let currentQR = null;

// ==============================
// WHATSAPP CLIENT
// ==============================
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: '/opt/render/project/src/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome',
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
    // Store QR as base64 image for web display
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

// Debug: find Chrome path
const { execSync } = require('child_process');
try {
    const chromePath = execSync('find /opt/render/.cache/puppeteer -name "chrome" -type f 2>/dev/null').toString().trim();
    console.log('✅ Chrome found at:', chromePath);
} catch(e) {
    try {
        const sys = execSync('which google-chrome chromium-browser chromium 2>/dev/null').toString().trim();
        console.log('✅ System Chrome:', sys);
    } catch(e2) {
        console.log('❌ No Chrome found!');
    }
}

console.log('🚀 Initializing WhatsApp client...');
client.initialize();

// ==============================
// ROUTES
// ==============================

// Health check
app.get('/', (req, res) => {
    res.json({
        status: clientReady ? 'ready' : 'waiting',
        message: clientReady ? '✅ WhatsApp connected!' : '⏳ Waiting for QR scan...'
    });
});

// Show QR code page — open this in browser to scan
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

// Send absence notifications — called by Flask app
app.post('/send-absence', async (req, res) => {
    if (!clientReady) {
        return res.status(503).json({ error: 'WhatsApp not connected yet. Please scan QR first.' });
    }

    const { students, date } = req.body;
    // students = [{ name: "John", phone_number: "919876543210" }, ...]

    if (!students || !students.length) {
        return res.json({ success: true, sent: 0, message: 'No absent students' });
    }

    const results = [];

    for (const student of students) {
        if (!student.phone_number) continue;

        // Clean phone number - remove +, spaces, dashes
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
            // Small delay between messages to avoid spam detection
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
// START SERVER
// ==============================
app.listen(PORT, () => {
    console.log(`🌐 WhatsApp service running on port ${PORT}`);
    console.log(`📱 Open /qr to scan QR code`);
});
