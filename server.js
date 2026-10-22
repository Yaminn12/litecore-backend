const express = require('express');
const mongoose = require('mongoose');
const app = express();

const BOT_TOKEN = "8977720240:AAFIn6-XE3NpxV9wjqgCgYlf5P3DlV6SoPU";
const ADMIN_ID = "7108686404";
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "nbx12345";

mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log('✅ Connected to MongoDB Atlas Successfully!');
        try {
            const currentTime = Date.now();
            const allUsers = await mongoose.model('User').find({});
            for (let u of allUsers) {
                if (u.planActive && u.ghs > 0 && (!u.planStartDate || u.planStartDate === 0)) {
                    if (u.deposits && Array.isArray(u.deposits)) {
                        const paidDep = u.deposits.find(d => d.status === 'PAID');
                        if (paidDep && paidDep.date) {
                            let parsedTime = Date.parse(paidDep.date);
                            if (!isNaN(parsedTime)) {
                                u.planStartDate = parsedTime;
                                u.planExpiryDate = parsedTime + (10 * 24 * 60 * 60 * 1000);
                                await u.save();
                            }
                        }
                    }
                }

                if (u.planActive && u.planExpiryDate && u.planExpiryDate > 0 && currentTime >= u.planExpiryDate) {
                    u.ghs = 0;
                    u.planActive = false;
                    u.planExpiryDate = 0;
                    u.planStartDate = 0;
                    await u.save();
                    continue;
                }

                let realDepositSum = 0;
                if (u.deposits && Array.isArray(u.deposits)) {
                    u.deposits.forEach(d => {
                        if (d.status === 'PAID') {
                            realDepositSum += Number(d.usdtAmount || 1);
                        }
                    });
                }
                if (u.planActive && u.ghs !== realDepositSum && realDepositSum > 0) {
                    u.ghs = realDepositSum;
                    await u.save();
                }
            }
            console.log('✅ All users GHS powers & 10-day plan expiries auto-synced!');
        } catch (err) {
            console.log('Auto-sync GHS error:', err);
        }
    })
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

const userSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, default: 'User' },
    balance: { type: Number, default: 0 },
    ghs: { type: Number, default: 0 },
    lastClaimTime: { type: Number, default: Date.now },
    deposits: { type: Array, default: [] },
    withdrawals: { type: Array, default: [] },
    isBanned: { type: Boolean, default: false },
    planActive: { type: Boolean, default: true },
    planStartDate: { type: Number, default: 0 },  
    planExpiryDate: { type: Number, default: 0 },   
    referredBy: { type: String, default: null },
    referrals: {
        level1: { type: [String], default: [] },
        level2: { type: [String], default: [] },
        level3: { type: [String], default: [] }
    },
    refEarnings: {
        level1: { type: Number, default: 0 },
        level2: { type: Number, default: 0 },
        level3: { type: Number, default: 0 }
    }
});
const User = mongoose.model('User', userSchema);

const pendingRequestSchema = new mongoose.Schema({
    reqId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    userId: { type: String, required: true },
    amount: { type: String, required: true },
    usdtAmount: { type: Number, default: 1 },
    coin: { type: String },
    txHash: { type: String },
    address: { type: String },
    status: { type: String, default: 'PENDING' }
});
const PendingRequest = mongoose.model('PendingRequest', pendingRequestSchema);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    req.cookies = {};
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
        cookieHeader.split(';').forEach(cookie => {
            const parts = cookie.split('=');
            req.cookies[parts.shift().trim()] = decodeURIComponent(parts.join('='));
        });
    }
    next();
});

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    next();
});

const activeSessions = new Set();

function checkAdminAuth(req, res, next) {
    const sessionToken = req.cookies.admin_session;
    if (sessionToken && activeSessions.has(sessionToken)) {
        return next();
    }
    return res.redirect('/admin/login');
}

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
    try {
        let body = { chat_id: chatId, text: text, parse_mode: 'Markdown' };
        if (replyMarkup) body.reply_markup = replyMarkup;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (e) {
        console.log("Telegram API Error:", e);
    }
}

async function sendTelegramPhoto(chatId, photoUrl, caption = '', replyMarkup = null) {
    try {
        let body = { chat_id: chatId, photo: photoUrl, caption: caption, parse_mode: 'Markdown' };
        if (replyMarkup) body.reply_markup = replyMarkup;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (e) {
        console.log("Telegram Photo Broadcast Error:", e);
    }
}

async function editTelegramMessage(chatId, messageId, text, replyMarkup = null) {
    try {
        let body = { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'Markdown' };
        if (replyMarkup) body.reply_markup = replyMarkup;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (e) {
        console.log("Telegram Edit Error:", e);
    }
}

async function answerCallbackQuery(callbackQueryId, text) {
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId, text: text })
        });
    } catch (e) {
        console.log("Callback Answer Error:", e);
    }
}

setInterval(async () => {
    try {
        const currentTime = Date.now();
        const expiredUsers = await User.find({ 
            planActive: true, 
            planExpiryDate: { $gt: 0, $lte: currentTime } 
        });

        for (let u of expiredUsers) {
            u.ghs = 0;
            u.planActive = false;
            u.planExpiryDate = 0;
            u.planStartDate = 0;
            await u.save();

            sendTelegramMessage(
                u.id, 
                `❌ *Plan Expired:* Your plan was expired plzz renew plan agin 🚀`
            );
        }
        if (expiredUsers.length > 0) {
            console.log(`⚡ Auto-expired ${expiredUsers.length} user plans.`);
        }
    } catch (err) {
        console.log("Background Plan Expiry Error:", err);
    }
}, 5 * 60 * 1000);

function getPlanDaysFormat(user) {
    if (!user.planActive || user.ghs <= 0) {
        return "N/A";
    }

    let startTimestamp = user.planStartDate;

    if (!startTimestamp || startTimestamp === 0) {
        if (user.deposits && Array.isArray(user.deposits)) {
            const paidDep = user.deposits.find(d => d.status === 'PAID');
            if (paidDep && paidDep.date) {
                let parsedTime = Date.parse(paidDep.date);
                if (!isNaN(parsedTime)) {
                    startTimestamp = parsedTime;
                }
            }
        }
    }

    if (!startTimestamp || startTimestamp === 0) {
        startTimestamp = Date.now();
    }

    const now = Date.now();
    const elapsed = now - startTimestamp;

    let daysPassed = Math.floor(elapsed / (1000 * 60 * 60 * 24)) + 1;
    if (daysPassed > 10) daysPassed = 10;
    if (daysPassed < 1) daysPassed = 1;

    return `${daysPassed}/10 Days`;
}

async function handleWebhookLogic(req, res) {
    const update = req.body;
    res.sendStatus(200);

    try {
        if (update.message) {
            const msg = update.message;
            const chatId = String(msg.chat.id);
            const text = msg.text || '';

            let user = await User.findOne({ id: chatId });
            if (user && user.isBanned) {
                await sendTelegramMessage(chatId, "⚠️ *Access Denied:* Your account has been banned by the admin.");
                return;
            }

            if (text.startsWith('/start')) {
                let referrerId = null;
                const match = text.match(/\/start\s+(\d+)/);
                if (match && match[1]) {
                    referrerId = String(match[1]).trim();
                }

                let isNewUser = false;

                if (!user) {
                    isNewUser = true;
                    user = new User({
                        id: chatId,
                        username: msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || 'User'),
                        referredBy: (referrerId && referrerId !== chatId) ? referrerId : null
                    });
                    await user.save();
                } else {
                    let currentUsername = msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || 'User');
                    if (user.username !== currentUsername) {
                        user.username = currentUsername;
                        await user.save();
                    }
                    if (!user.referredBy && referrerId && referrerId !== chatId) {
                        user.referredBy = referrerId;
                        await user.save();
                        isNewUser = true;
                    }
                }

                if (isNewUser && user.referredBy) {
                    const l1Id = user.referredBy;
                    await User.updateOne(
                        { id: l1Id },
                        { $addToSet: { "referrals.level1": chatId } }
                    );
                    sendTelegramMessage(l1Id, `🎉 *New Level 1 Referral Joined!*\nUser ID: \`${chatId}\``);

                    const refL1 = await User.findOne({ id: l1Id });
                    if (refL1 && refL1.referredBy) {
                        const l2Id = refL1.referredBy;
                        await User.updateOne(
                            { id: l2Id },
                            { $addToSet: { "referrals.level2": chatId } }
                        );

                        const refL2 = await User.findOne({ id: l2Id });
                        if (refL2 && refL2.referredBy) {
                            const l3Id = refL2.referredBy;
                            await User.updateOne(
                                { id: l3Id },
                                { $addToSet: { "referrals.level3": chatId } }
                            );
                        }
                    }
                }

                const vercelAppUrl = "https://lite-core.vercel.app/";
                const welcomeCaption = `🎁 *Welcome to Lite Core!*\n\nReady to grow your portfolio?\n\n✅ Earn LTC\n✅ Invite Friends\n✅ Instant Payouts\n\n🚀 *Launch the App to begin your journey!*`;
                const startPhotoUrl = "https://ibb.co/ymZ191Fr";
                
                const webAppMarkup = {
                    inline_keyboard: [
                        [
                            { text: "✅ Lite Core Payments", url: "https://t.me/bnbvaultpayments" },
                            { text: "💬 Lite Core Official", url: "https://t.me/+sN2MH1z94A9lOTFk" }
                        ],
                        [
                            { text: "🔨 ➔ Open Lite Core Mining ⛏️", web_app: { url: vercelAppUrl } }
                        ]
                    ]
                };

                await sendTelegramPhoto(chatId, startPhotoUrl, welcomeCaption, webAppMarkup);

            } else if (text === '/admin' && chatId === String(ADMIN_ID)) {
                const renderAppUrl = process.env.RENDER_EXTERNAL_URL || "https://dashboard.render.com";
                await sendTelegramMessage(chatId, `👑 **Lite Core Admin Access**\n\nClick below to open Login Page:`, {
                    inline_keyboard: [[ { text: "🔐 Admin Login Panel", url: `${renderAppUrl}/admin/login` } ]]
                });
            }
        } else if (update.callback_query) {
            const query = update.callback_query;
            const chatId = String(query.message.chat.id);
            const data = query.data;
            const messageId = query.message.message_id;

            let userCheck = await User.findOne({ id: chatId });
            if (userCheck && userCheck.isBanned) {
                return answerCallbackQuery(query.id, "⚠️ Your account is banned!");
            }

            if (data.startsWith('approve_') || data.startsWith('reject_')) {
                if (chatId !== String(ADMIN_ID)) return answerCallbackQuery(query.id, "Unauthorized!");

                const isApprove = data.startsWith('approve_');
                const reqId = data.replace(isApprove ? 'approve_' : 'reject_', '');
                const reqDoc = await PendingRequest.findOne({ reqId });

                if (!reqDoc) return answerCallbackQuery(query.id, "Request already handled!");

                const u = await User.findOne({ id: reqDoc.userId });

                if (isApprove) {
                    if (reqDoc.type === 'deposit' && u) {
                        let numericDepAmount = reqDoc.usdtAmount ? Number(reqDoc.usdtAmount) : 1;
                        
                        let idx = u.deposits.findIndex(d => String(d.id) === String(reqId));
                        if (idx !== -1) {
                            u.deposits[idx].status = 'PAID';
                        } else {
                            let p = u.deposits.find(d => d.status === 'PENDING');
                            if (p) p.status = 'PAID';
                        }
                        u.markModified('deposits');

                        let totalApprovedGhs = 0;
                        u.deposits.forEach(d => {
                            if (d.status === 'PAID') {
                                totalApprovedGhs += Number(d.usdtAmount || 1);
                            }
                        });
                        u.ghs = totalApprovedGhs;
                        u.planActive = true;
                        
                        u.planStartDate = Date.now();
                        u.planExpiryDate = Date.now() + (10 * 24 * 60 * 60 * 1000);

                        await u.save();

                        if (u.referredBy) {
                            let refL1 = await User.findOne({ id: u.referredBy });
                            if (refL1) {
                                let commL1 = numericDepAmount * 0.15;
                                refL1.balance += commL1;
                                refL1.refEarnings.level1 = (refL1.refEarnings.level1 || 0) + commL1;
                                refL1.markModified('refEarnings');
                                await refL1.save();
                                sendTelegramMessage(refL1.id, `🎁 Received +${commL1.toFixed(4)} USDT (15% Level 1 Referral Commission)!`);

                                if (refL1.referredBy) {
                                    let refL2 = await User.findOne({ id: refL1.referredBy });
                                    if (refL2) {
                                        let commL2 = numericDepAmount * 0.03;
                                        refL2.balance += commL2;
                                        refL2.refEarnings.level2 = (refL2.refEarnings.level2 || 0) + commL2;
                                        refL2.markModified('refEarnings');
                                        await refL2.save();
                                        sendTelegramMessage(refL2.id, `🎁 Received +${commL2.toFixed(4)} USDT (3% Level 2 Referral Commission)!`);

                                        if (refL2.referredBy) {
                                            let refL3 = await User.findOne({ id: refL2.referredBy });
                                            if (refL3) {
                                                let commL3 = numericDepAmount * 0.01;
                                                refL3.balance += commL3;
                                                refL3.refEarnings.level3 = (refL3.refEarnings.level3 || 0) + commL3;
                                                refL3.markModified('refEarnings');
                                                await refL3.save();
                                                sendTelegramMessage(refL3.id, `🎁 Received +${commL3.toFixed(4)} USDT (1% Level 3 Referral Commission)!`);
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        sendTelegramMessage(reqDoc.userId, `✅ Your deposit of ${reqDoc.amount} has been approved!\n⚡ +${numericDepAmount} GHS Mining Power added (Valid for 10 Days).`);
                    } else if (reqDoc.type === 'withdraw' && u) {
                        let idx = u.withdrawals.findIndex(w => String(w.id) === String(reqId));
                        if (idx !== -1) {
                            u.withdrawals[idx].status = 'PAID';
                        } else {
                            let p = u.withdrawals.find(w => w.status === 'PENDING' || w.status === 'PEND1NG');
                            if (p) p.status = 'PAID';
                        }
                        u.markModified('withdrawals');
                        await u.save();
                        sendTelegramMessage(reqDoc.userId, `✅ Your withdrawal of ${reqDoc.amount} LTC has been approved!`);
                    }

                    editTelegramMessage(chatId, messageId, `✅ **Request Approved**\nUser ID: ${reqDoc.userId}\nAmount:${reqDoc.amount}`);
                } else {
                    if (reqDoc.type === 'deposit' && u) {
                        let idx = u.deposits.findIndex(d => String(d.id) === String(reqId));
                        if (idx !== -1) {
                            u.deposits[idx].status = 'DECLINED';
                        } else {
                            let p = u.deposits.find(d => d.status === 'PENDING');
                            if (p) p.status = 'DECLINED';
                        }
                        u.markModified('deposits');
                        
                        let totalApprovedGhs = 0;
                        u.deposits.forEach(d => {
                            if (d.status === 'PAID') {
                                totalApprovedGhs += Number(d.usdtAmount || 1);
                            }
                        });
                        u.ghs = totalApprovedGhs;
                        await u.save();
                        sendTelegramMessage(reqDoc.userId, `❌ Your deposit request was declined.`);
                    } else if (reqDoc.type === 'withdraw' && u) {
                        u.balance += parseFloat(reqDoc.amount);
                        let idx = u.withdrawals.findIndex(w => String(w.id) === String(reqId));
                        if (idx !== -1) {
                            u.withdrawals[idx].status = 'DECLINED';
                        } else {
                            let p = u.withdrawals.find(w => w.status === 'PENDING' || w.status === 'PEND1NG');
                            if (p) p.status = 'DECLINED';
                        }
                        u.markModified('withdrawals');
                        await u.save();
                        sendTelegramMessage(reqDoc.userId, `❌ Your withdrawal request was declined and funds refunded.`);
                    }

                    editTelegramMessage(chatId, messageId, `❌ **Request Rejected**\nUser ID: ${reqDoc.userId}\nAmount:${reqDoc.amount}`);
                }

                await PendingRequest.deleteOne({ reqId });
                answerCallbackQuery(query.id, "Done!");
            }
        }
    } catch (err) {
        console.log("Webhook error:", err);
    }
}

app.post(`/api/webhook/${BOT_TOKEN}`, handleWebhookLogic);
app.post('/webhook', handleWebhookLogic);
app.post('/api/webhook/*', handleWebhookLogic);

app.get('/', (req, res) => {
    res.send(`<h1>Lite Core Mining Backend Active</h1><p>Please launch via Telegram Bot.</p>`);
});

app.get('/admin/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Login - Lite Core</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * { box-sizing: border-box; font-family: 'Segoe UI', sans-serif; }
                body { background: #0c0a09; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .login-card { background: #1c1917; border: 1px solid #292524; padding: 30px; border-radius: 16px; width: 90%; max-width: 360px; text-align: center; }
                h2 { color: #38bdf8; margin-bottom: 20px; }
                input { width: 100%; padding: 12px; margin-bottom: 12px; background: #0c0a09; border: 1px solid #44403c; color: #fff; border-radius: 8px; }
                button { width: 100%; padding: 12px; background: #38bdf8; color: #000; font-weight: bold; border: none; border-radius: 8px; cursor: pointer; }
            </style>
        </head>
        <body>
            <div class="login-card">
                <h2>🔐 Admin Login</h2>
                <form action="/admin/login" method="POST">
                    <input type="text" name="username" placeholder="Username" required>
                    <input type="password" name="password" placeholder="Password" required>
                    <button type="submit">Login</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const sessionToken = "token_" + Math.random().toString(36).substring(2) + Date.now();
        activeSessions.add(sessionToken);
        
        res.setHeader('Set-Cookie', `admin_session=${sessionToken}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`);
        return res.redirect('/admin/dashboard');
    }
    res.send(`<script>alert('Invalid Credentials!'); window.location.href='/admin/login';</script>`);
});

app.get('/admin/logout', (req, res) => {
    const sessionToken = req.cookies.admin_session;
    if (sessionToken) activeSessions.delete(sessionToken);
    res.setHeader('Set-Cookie', 'admin_session=; Path=/; HttpOnly; Max-Age=0');
    res.redirect('/admin/login');
});

app.get('/admin/dashboard', checkAdminAuth, async (req, res) => {
    const requests = await PendingRequest.find({});
    const totalUsers = await User.countDocuments();
    const allUsers = await User.find({});

    let totalPaidOut = 0;
    let totalGlobalDeposit = 0;
    let activeDepositUsersCount = 0;
    let activeDepositUsersList = [];

    allUsers.forEach(u => {
        let userActualDepositSum = 0;
        if (u.deposits) {
            u.deposits.forEach(d => {
                if (d.status === 'PAID') {
                    let depUsdtVal = parseFloat(d.usdtAmount || 1);
                    userActualDepositSum += depUsdtVal;
                    totalGlobalDeposit += depUsdtVal;
                }
            });
        }

        if (userActualDepositSum >= 1 && u.planActive !== false) {
            activeDepositUsersCount++;
            activeDepositUsersList.push(u);
        }

        if (u.withdrawals) {
            u.withdrawals.forEach(w => {
                if (w.status === 'PAID') totalPaidOut += parseFloat(w.amount || 0);
            });
        }
    });

    let searchId = req.query.search ? req.query.search.trim() : '';
    let searchedUser = null;
    let userTotalDeposit = 0;
    let userTotalWithdraw = 0;
    let userPaidWithdrawCount = 0;
    let totalRefEarn = 0;

    if (searchId) {
        searchedUser = await User.findOne({
            $or: [{ id: searchId }, { username: searchId.replace('@', '') }]
        });

        if (searchedUser) {
            if (searchedUser.deposits) {
                searchedUser.deposits.forEach(d => {
                    if (d.status === 'PAID') {
                        userTotalDeposit += parseFloat(d.usdtAmount || 1);
                    }
                });
            }
            if (searchedUser.withdrawals) {
                searchedUser.withdrawals.forEach(w => {
                    if (w.status === 'PAID') {
                        userTotalWithdraw += parseFloat(w.amount || 0);
                        userPaidWithdrawCount++;
                    }
                });
            }
            let l1Earn = searchedUser.refEarnings?.level1 || 0;
            let l2Earn = searchedUser.refEarnings?.level2 || 0;
            let l3Earn = searchedUser.refEarnings?.level3 || 0;
            totalRefEarn = l1Earn + l2Earn + l3Earn;
        }
    }

    let html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Lite Core Admin Panel</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * { box-sizing: border-box; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
                body { background: #0c0a09; color: #f3f4f6; margin: 0; padding: 20px; }
                .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
                .header h1 { color: #38bdf8; margin: 0; font-size: 24px; }
                .logout-btn { background: #ef4444; color: #fff; padding: 6px 12px; border-radius: 6px; text-decoration: none; font-size: 12px; font-weight: bold; }
                .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 20px; }
                .stat-card { background: #1c1917; border: 1px solid #292524; border-radius: 12px; padding: 15px; text-align: left; }
                .stat-title { font-size: 11px; color: #a8a29e; text-transform: uppercase; letter-spacing: 0.5px; }
                .stat-value { font-size: 20px; font-weight: bold; color: #38bdf8; margin-top: 6px; }
                .nav-tabs { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; background: #1c1917; padding: 10px; border-radius: 12px; border: 1px solid #292524; }
                .nav-tab { background: #292524; color: #a8a29e; padding: 8px 16px; border-radius: 8px; text-decoration: none; font-size: 13px; font-weight: bold; cursor: pointer; transition: 0.2s; }
                .nav-tab.active { background: #38bdf8; color: #000; }
                .tab-content { display: none; }
                .tab-content.active { display: block; }
                .card { background: #1c1917; border: 1px solid #292524; border-radius: 12px; padding: 18px; margin-bottom: 20px; }
                .card h3 { color: #38bdf8; margin-top: 0; font-size: 16px; border-bottom: 1px solid #292524; padding-bottom: 8px; }
                .search-box { display: flex; gap: 10px; margin-bottom: 15px; }
                input, textarea { background: #0c0a09; border: 1px solid #44403c; color: #fff; padding: 10px; border-radius: 8px; width: 100%; font-size: 14px; }
                .btn { background: #38bdf8; color: #000; border: none; font-weight: bold; padding: 10px 18px; border-radius: 8px; cursor: pointer; }
                .btn-green { background: #22c55e; color: #fff; }
                .btn-red { background: #ef4444; color: #fff; }
                .btn-blue { background: #3b82f6; color: #fff; }
                .btn-gray { background: #6b7280; color: #fff; }
                table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                th, td { padding: 10px; text-align: left; border-bottom: 1px solid #292524; font-size: 12px; }
                th { color: #a8a29e; }
                .user-details-box { background: #0c0a09; padding: 14px; border-radius: 8px; border: 1px solid #292524; margin-top: 10px; font-size: 13px; line-height: 1.8; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>👑 Lite Core Admin Panel</h1>
                <div>
                    <a href="/admin/logout" class="logout-btn">Logout</a>
                </div>
            </div>
            
            <div class="stats-grid">
                <div class="stat-card"><div class="stat-title">Total Users</div><div class="stat-value">${totalUsers}</div></div>
                <div class="stat-card"><div class="stat-title">Total User Deposit</div><div class="stat-value">${totalGlobalDeposit.toFixed(2)} USDT</div></div>
                <div class="stat-card"><div class="stat-title">Total Active Plan Users ($1+)</div><div class="stat-value">${activeDepositUsersCount} Users</div></div>
                <div class="stat-card"><div class="stat-title">Paid Out</div><div class="stat-value">${totalPaidOut.toFixed(2)} LTC</div></div>
                <div class="stat-card"><div class="stat-title">Pending Requests</div><div class="stat-value">${requests.length}</div></div>
            </div>

            <div class="nav-tabs">
                <div class="nav-tab active" onclick="switchTab('tab-users', this)">👥 Users & Plans</div>
                <div class="nav-tab" onclick="switchTab('tab-search', this)">🔍 Search & Manage</div>
                <div class="nav-tab" onclick="switchTab('tab-requests', this)">⏳ Pending Requests (${requests.length})</div>
                <div class="nav-tab" onclick="switchTab('tab-broadcast', this)">📢 Broadcast</div>
            </div>

            <!-- TAB 1: USERS -->
            <div id="tab-users" class="tab-content active">
                <div class="card">
                    <h3>👥 Users With Active Plans ($1+ Deposits Only)</h3>
                    ${activeDepositUsersList.length === 0 ? `<p style="font-size:12px; color:#a8a29e;">No active plan users found.</p>` : `
                        <table>
                            <tr><th>User ID</th><th>Username</th><th>Total Deposit</th><th>GHS Power</th><th>Plan Expiry</th></tr>
                            ${activeDepositUsersList.map(depUser => {
                                let depTotal = 0;
                                if (depUser.deposits) {
                                    depUser.deposits.forEach(d => {
                                        if (d.status === 'PAID') depTotal += parseFloat(d.usdtAmount || 1);
                                    });
                                }
                                let displayUname = depUser.username ? (depUser.username.startsWith('@') ? depUser.username : '@' + depUser.username) : '@User';
                                let planDaysStr = getPlanDaysFormat(depUser);
                                return `
                                    <tr>
                                        <td><code>${depUser.id}</code></td>
                                        <td>${displayUname}</td>
                                        <td><b style="color:#22c55e;">${depTotal.toFixed(2)} USDT</b></td>
                                        <td><b>${depUser.ghs} GHS</b></td>
                                        <td><b style="color:#38bdf8;">${planDaysStr}</b></td>
                                    </tr>
                                `;
                            }).join('')}
                        </table>
                    `}
                </div>
            </div>

            <!-- TAB 2: SEARCH & MANAGE -->
            <div id="tab-search" class="tab-content">
                <div class="card">
                    <h3>🔍 Search User Details & Manage Plan</h3>
                    <form method="GET" action="/admin/dashboard" class="search-box">
                        <input type="text" name="search" placeholder="Enter Telegram User ID or Username" value="${searchId}">
                        <button type="submit" class="btn">Search</button>
                    </form>
                    ${searchedUser ? `
                        <div class="user-details-box">
                            <p>👤 <b>User Name:</b> ${searchedUser.username.startsWith('@') ? searchedUser.username : '@' + searchedUser.username} | <b>ID:</b> <code>${searchedUser.id}</code></p>
                            <p>💰 <b>Current Balance:</b> <span style="color:#38bdf8; font-weight:bold;">${searchedUser.balance.toFixed(4)} LTC</span> | ⚡ <b>GHS Power:</b> ${searchedUser.ghs} GHS</p>
                            <p>🚫 <b>Account Status:</b> ${searchedUser.isBanned ? '<span style="color:#ef4444; font-weight:bold;">BANNED</span>' : '<span style="color:#22c55e; font-weight:bold;">ACTIVE</span>'}</p>
                            <p>⚡ <b>Mining Plan Status:</b> ${searchedUser.planActive !== false && searchedUser.ghs > 0 ? '<span style="color:#22c55e; font-weight:bold;">ACTIVE (' + getPlanDaysFormat(searchedUser) + ')</span>' : '<span style="color:#ef4444; font-weight:bold;">DEACTIVATED / EXPIRED</span>'}</p>
                            <p>📥 <b>Total Approved Deposit:</b> <span style="color:#22c55e; font-weight:bold;">${userTotalDeposit.toFixed(2)} USDT</span></p>
                            <p>📤 <b>Total Approved Withdraw:</b> <span style="color:#ef4444; font-weight:bold;">${userTotalWithdraw.toFixed(4)} LTC</span> (<span style="color:#38bdf8;">${userPaidWithdrawCount} Times Paid</span>)</p>
                            <p>👥 <b>Referrals Count:</b> L1: ${searchedUser.referrals?.level1?.length || 0} | L2: ${searchedUser.referrals?.level2?.length || 0} | L3: ${searchedUser.referrals?.level3?.length || 0}</p>
                            <p>🎁 <b>Total Referral Commission:</b> <span style="color:#38bdf8; font-weight:bold;">${totalRefEarn.toFixed(4)} USDT</span></p>
                            <p>🔗 <b>Referred By ID:</b> ${searchedUser.referredBy || 'Direct Join'}</p>
                            <hr style="border-color:#292524; margin:12px 0;">
                            <b>⚙️ Manage User Balance, Plan & Status:</b>
                            <div style="display:flex; gap:10px; margin-top:8px; flex-wrap:wrap;">
                                <input type="number" id="mod-amt" placeholder="Enter amount" style="flex:1; min-width:140px;">
                                <button class="btn btn-green" onclick="modifyBal('${searchedUser.id}', 'add')">+ Add</button>
                                <button class="btn btn-red" onclick="modifyBal('${searchedUser.id}', 'cut')">- Cut</button>
                                <button class="btn btn-blue" onclick="togglePlan('${searchedUser.id}', 'activate')">⚡ Activate Plan (10 Days)</button>
                                <button class="btn btn-red" onclick="togglePlan('${searchedUser.id}', 'deactivate')">❌ Deactivate Plan</button>
                                <button class="btn btn-red" onclick="toggleBan('${searchedUser.id}', 'ban')">🚫 Ban User</button>
                                <button class="btn btn-green" onclick="toggleBan('${searchedUser.id}', 'unban')">✅ Unban User</button>
                            </div>
                            <hr style="border-color:#292524; margin:12px 0;">
                            <b>✉️ Send Personal Message to this User:</b>
                            <div style="display:flex; gap:10px; margin-top:8px;">
                                <input type="text" id="single-msg" placeholder="Type message for this user..." style="flex:1;">
                                <button class="btn" onclick="sendSingleMsg('${searchedUser.id}')">Send Msg</button>
                            </div>
                        </div>
                    ` : searchId ? `<p style="color:#ef4444; font-size:12px;">User not found!</p>` : ''}
                </div>
            </div>

            <!-- TAB 3: PENDING REQUESTS -->
            <div id="tab-requests" class="tab-content">
                <div class="card">
                    <h3>⏳ Pending Requests</h3>
                    ${requests.length === 0 ? `<p style="font-size:12px; color:#a8a29e;">No pending requests right now.</p>` : `
                        <table>
                            <tr><th>Type</th><th>User ID</th><th>Amount</th><th>Details</th><th>Action</th></tr>
                            ${requests.map(r => `
                                <tr>
                                    <td style="color:${r.type==='deposit'?'#22c55e':'#ef4444'}; font-weight:bold;">${r.type.toUpperCase()}</td>
                                    <td>${r.userId}</td>
                                    <td><b>${r.amount}</b></td>
                                    <td>${r.txHash ? 'Tx: ' + r.txHash.substring(0,10) + '...' : 'Addr: ' + r.address.substring(0,10) + '...'}</td>
                                    <td>
                                        <button class="btn btn-green" style="padding:4px 8px; font-size:11px;" onclick="handleReq('${r.reqId}', 'approve')">Approve</button>
                                        <button class="btn btn-red" style="padding:4px 8px; font-size:11px;" onclick="handleReq('${r.reqId}', 'reject')">Reject</button>
                                        <button class="btn btn-gray" style="padding:4px 8px; font-size:11px;" onclick="handleReq('${r.reqId}', 'close')">Close</button>
                                    </td>
                                </tr>
                            `).join('')}
                        </table>
                    `}
                </div>
            </div>

            <!-- TAB 4: BROADCAST -->
            <div id="tab-broadcast" class="tab-content">
                <div class="card">
                    <h3>📢 Broadcast Message with Photo to All Users</h3>
                    <input type="text" id="bc-photo" placeholder="Enter Direct Image URL (Optional)" style="margin-bottom:10px;">
                    <textarea id="bc-msg" placeholder="Write message to send to all bot users..."></textarea>
                    <button class="btn" style="margin-top:10px; width:100%;" onclick="sendBroadcast()">Send Broadcast Message</button>
                </div>
            </div>

            <script>
                function switchTab(tabId, el) {
                    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
                    document.querySelectorAll('.nav-tab').forEach(nt => nt.classList.remove('active'));
                    document.getElementById(tabId).classList.add('active');
                    el.classList.add('active');
                }

                if('${searchId}' !== '') {
                    switchTab('tab-search', document.querySelectorAll('.nav-tab')[1]);
                }

                async function handleReq(reqId, action) {
                    let res = await fetch('/admin/action', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ reqId, action })
                    });
                    let data = await res.json();
                    alert(data.message);
                    location.reload();
                }
                async function modifyBal(userId, action) {
                    let amount = document.getElementById('mod-amt').value;
                    if(!amount) return alert("Enter amount!");
                    let res = await fetch('/admin/manage-balance', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ userId, amount, action })
                    });
                    let data = await res.json();
                    alert(data.message);
                    location.reload();
                }
                async function togglePlan(userId, action) {
                    let res = await fetch('/admin/manage-plan', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ userId, action })
                    });
                    let data = await res.json();
                    alert(data.message);
                    location.reload();
                }
                async function toggleBan(userId, action) {
                    let res = await fetch('/admin/ban-user', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ userId, action })
                    });
                    let data = await res.json();
                    alert(data.message);
                    location.reload();
                }
                async function sendSingleMsg(userId) {
                    let message = document.getElementById('single-msg').value;
                    if(!message) return alert("Enter message!");
                    let res = await fetch('/admin/send-single', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ userId, message })
                    });
                    let data = await res.json();
                    alert(data.message);
                    document.getElementById('single-msg').value = '';
                }
                async function sendBroadcast() {
                    let message = document.getElementById('bc-msg').value;
                    let photoUrl = document.getElementById('bc-photo').value;
                    if(!message && !photoUrl) return alert("Please enter message or photo URL!");
                    let res = await fetch('/admin/broadcast', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ message, photoUrl })
                    });
                    let data = await res.json();
                    alert(data.message);
                }
            </script>
        </body>
        </html>
    `;
    res.send(html);
});

app.post('/admin/manage-plan', checkAdminAuth, async (req, res) => {
    const { userId, action } = req.body;
    let u = await User.findOne({ id: userId });
    if (!u) return res.status(404).json({ success: false, message: "User not found!" });

    if (action === 'activate') {
        u.planActive = true;
        if (u.ghs <= 0) u.ghs = 1;
        u.planStartDate = Date.now();
        u.planExpiryDate = Date.now() + (10 * 24 * 60 * 60 * 1000);
        await u.save();
        sendTelegramMessage(userId, `⚡ *Plan Activated:* Admin has activated your mining plan for 10 Days!`);
        res.json({ success: true, message: `Plan activated successfully for user ${userId}!` });
    } else {
        u.planActive = false;
        u.ghs = 0;
        u.planStartDate = 0;
        u.planExpiryDate = 0;
        await u.save();
        sendTelegramMessage(userId, `❌ *Plan Expired:* Your plan was expired plzz renew plan agin 🚀`);
        res.json({ success: true, message: `Plan deactivated successfully for user ${userId}!` });
    }
});

app.post('/admin/action', checkAdminAuth, async (req, res) => {
    const { reqId, action } = req.body;
    const reqDoc = await PendingRequest.findOne({ reqId });
    if (!reqDoc) return res.status(404).json({ success: false, message: "Request not found" });

    const u = await User.findOne({ id: reqDoc.userId });

    if (action === 'approve') {
        if (reqDoc.type === 'deposit' && u) {
            let numericDepAmount = reqDoc.usdtAmount ? Number(reqDoc.usdtAmount) : 1;
            
            let idx = u.deposits.findIndex(d => String(d.id) === String(reqId));
            if (idx !== -1) {
                u.deposits[idx].status = 'PAID';
            } else {
                let p = u.deposits.find(d => d.status === 'PENDING');
                if (p) p.status = 'PAID';
            }
            u.markModified('deposits');

            let totalApprovedGhs = 0;
            u.deposits.forEach(d => {
                if (d.status === 'PAID') {
                    totalApprovedGhs += Number(d.usdtAmount || 1);
                }
            });
            u.ghs = totalApprovedGhs;
            u.planActive = true;
            u.planStartDate = Date.now();
            u.planExpiryDate = Date.now() + (10 * 24 * 60 * 60 * 1000);

            await u.save();

            if (u.referredBy) {
                let refL1 = await User.findOne({ id: u.referredBy });
                if (refL1) {
                    let commL1 = numericDepAmount * 0.15;
                    refL1.balance += commL1;
                    refL1.refEarnings.level1 = (refL1.refEarnings.level1 || 0) + commL1;
                    refL1.markModified('refEarnings');
                    await refL1.save();
                    sendTelegramMessage(refL1.id, `🎁 Received +${commL1.toFixed(4)} USDT (15% Level 1 Referral Commission)!`);

                    if (refL1.referredBy) {
                        let refL2 = await User.findOne({ id: refL1.referredBy });
                        if (refL2) {
                            let commL2 = numericDepAmount * 0.03;
                            refL2.balance += commL2;
                            refL2.refEarnings.level2 = (refL2.refEarnings.level2 || 0) + commL2;
                            refL2.markModified('refEarnings');
                            await refL2.save();
                            sendTelegramMessage(refL2.id, `🎁 Received +${commL2.toFixed(4)} USDT (3% Level 2 Referral Commission)!`);

                            if (refL2.referredBy) {
                                let refL3 = await User.findOne({ id: refL2.referredBy });
                                if (refL3) {
                                    let commL3 = numericDepAmount * 0.01;
                                    refL3.balance += commL3;
                                    refL3.refEarnings.level3 = (refL3.refEarnings.level3 || 0) + commL3;
                                    refL3.markModified('refEarnings');
                                    await refL3.save();
                                    sendTelegramMessage(refL3.id, `🎁 Received +${commL3.toFixed(4)} USDT (1% Level 3 Referral Commission)!`);
                                }
                            }
                        }
                    }
                }
            }

            sendTelegramMessage(reqDoc.userId, `✅ Your deposit of ${reqDoc.amount} has been approved!\n⚡ +${numericDepAmount} GHS Mining Power added (Valid for 10 Days).`);
        } else if (reqDoc.type === 'withdraw' && u) {
            let idx = u.withdrawals.findIndex(w => String(w.id) === String(reqId));
            if (idx !== -1) {
                u.withdrawals[idx].status = 'PAID';
            } else {
                let p = u.withdrawals.find(w => w.status === 'PENDING' || w.status === 'PEND1NG');
                if (p) p.status = 'PAID';
            }
            u.markModified('withdrawals');
            await u.save();
            sendTelegramMessage(reqDoc.userId, `✅ Your withdrawal of ${reqDoc.amount} LTC has been approved!`);
        }
    } else if (action === 'reject') {
        if (reqDoc.type === 'deposit' && u) {
            let idx = u.deposits.findIndex(d => String(d.id) === String(reqId));
            if (idx !== -1) {
                u.deposits[idx].status = 'DECLINED';
            } else {
                let p = u.deposits.find(d => d.status === 'PENDING');
                if (p) p.status = 'DECLINED';
            }
            u.markModified('deposits');
            
            let totalApprovedGhs = 0;
            u.deposits.forEach(d => {
                if (d.status === 'PAID') {
                    totalApprovedGhs += Number(d.usdtAmount || 1);
                }
            });
            u.ghs = totalApprovedGhs;
            await u.save();
            sendTelegramMessage(reqDoc.userId, `❌ Your deposit request was declined.`);
        } else if (reqDoc.type === 'withdraw' && u) {
            u.balance += parseFloat(reqDoc.amount);
            let idx = u.withdrawals.findIndex(w => String(w.id) === String(reqId));
            if (idx !== -1) {
                u.withdrawals[idx].status = 'DECLINED';
            } else {
                let p = u.withdrawals.find(w => w.status === 'PENDING' || w.status === 'PEND1NG');
                if (p) p.status = 'DECLINED';
            }
            u.markModified('withdrawals');
            await u.save();
            sendTelegramMessage(reqDoc.userId, `❌ Your withdrawal request was declined and funds refunded.`);
        }
    } else if (action === 'close') {
        if (reqDoc.type === 'deposit' && u) {
            let idx = u.deposits.findIndex(d => String(d.id) === String(reqId));
            if (idx !== -1) u.deposits[idx].status = 'CLOSED';
            u.markModified('deposits');
            await u.save();
        } else if (reqDoc.type === 'withdraw' && u) {
            u.balance += parseFloat(reqDoc.amount);
            let idx = u.withdrawals.findIndex(w => String(w.id) === String(reqId));
            if (idx !== -1) u.withdrawals[idx].status = 'CLOSED';
            u.markModified('withdrawals');
            await u.save();
        }
    }

    await PendingRequest.deleteOne({ reqId });
    res.json({ success: true, message: "Action executed successfully!" });
});

app.post('/admin/manage-balance', checkAdminAuth, async (req, res) => {
    const { userId, amount, action } = req.body;
    let u = await User.findOne({ id: userId });
    if (!u) return res.status(404).json({ success: false, message: "User not found!" });

    let amt = parseFloat(amount);
    if (action === 'add') {
        u.balance += amt;
        sendTelegramMessage(userId, `🎁 Admin added +${amt} LTC to your balance!`);
    } else {
        u.balance = Math.max(0, u.balance - amt);
        sendTelegramMessage(userId, `⚠️ Admin deducted -${amt} LTC from your balance.`);
    }
    await u.save();
    res.json({ success: true, message: `Successfully ${action}ed ${amt} LTC for user ${userId}!` });
});

app.post('/admin/ban-user', checkAdminAuth, async (req, res) => {
    const { userId, action } = req.body;
    let u = await User.findOne({ id: userId });
    if (!u) return res.status(404).json({ success: false, message: "User not found!" });

    if (action === 'ban') {
        u.isBanned = true;
        await u.save();
        sendTelegramMessage(userId, `🚫 *Account Banned:* You have been banned by the admin.`);
        res.json({ success: true, message: `User ${userId} has been banned successfully!` });
    } else {
        u.isBanned = false;
        await u.save();
        sendTelegramMessage(userId, `✅ *Account Unbanned:* Your account has been unbanned by the admin.`);
        res.json({ success: true, message: `User ${userId} has been unbanned successfully!` });
    }
});

app.post('/admin/send-single', checkAdminAuth, async (req, res) => {
    const { userId, message } = req.body;
    let u = await User.findOne({ id: userId });
    if (!u) return res.status(404).json({ success: false, message: "User not found!" });

    await sendTelegramMessage(userId, `📩 *Message from Admin:*\n\n${message}`);
    res.json({ success: true, message: `Message sent to user ${userId} successfully!` });
});

app.post('/admin/broadcast', checkAdminAuth, async (req, res) => {
    const { message, photoUrl } = req.body;
    const users = await User.find({});
    let count = 0;
    for (let u of users) {
        if (photoUrl && photoUrl.trim() !== '') {
            await sendTelegramPhoto(u.id, photoUrl.trim(), message || '');
        } else if (message && message.trim() !== '') {
            await sendTelegramMessage(u.id, message);
        }
        count++;
    }
    res.json({ success: true, message: `Broadcast sent to ${count} users successfully!` });
});

app.get('/api/user/:userId', async (req, res) => {
    const userId = req.params.userId;
    let user = await User.findOne({ id: userId });
    
    if (user && user.isBanned) {
        return res.status(403).json({ success: false, isBanned: true, message: "Your account is banned by admin." });
    }

    if (!user) {
        user = new User({ id: userId, username: 'User' });
        await user.save();
    } else if (user.planActive && user.planExpiryDate && user.planExpiryDate > 0 && Date.now() >= user.planExpiryDate) {
        user.ghs = 0;
        user.planActive = false;
        user.planExpiryDate = 0;
        user.planStartDate = 0;
        await user.save();
    }
    res.json(user);
});

app.post('/api/update-ghs', async (req, res) => {
    const { userId, ghs } = req.body;
    let u = await User.findOne({ id: userId });
    if (u && u.isBanned) return res.status(403).json({ success: false, isBanned: true, message: "Your account is banned." });

    if (!u) {
        u = new User({ id: userId, ghs: ghs });
    } else {
        let realDepositSum = 0;
        if (u.deposits) {
            u.deposits.forEach(d => {
                if (d.status === 'PAID') realDepositSum += Number(d.usdtAmount || 1);
            });
        }
        if (ghs <= realDepositSum) {
            u.ghs = ghs;
        } else {
            u.ghs = realDepositSum;
        }
    }
    await u.save();
    res.json({ success: true, ghs: u.ghs });
});

app.post('/api/claim', async (req, res) => {
    const { userId } = req.body;
    const u = await User.findOne({ id: userId });
    if (!u || u.isBanned || u.planActive === false) return res.status(400).json({ success: false, message: "User not found, banned or plan deactivated" });

    if (u.planExpiryDate && u.planExpiryDate > 0 && Date.now() >= u.planExpiryDate) {
        u.ghs = 0;
        u.planActive = false;
        u.planExpiryDate = 0;
        u.planStartDate = 0;
        await u.save();
        return res.status(400).json({ success: false, message: "Your 10-day mining plan has expired." });
    }

    let dailyProfit = u.ghs > 0 ? u.ghs * 0.3 : 0.01;
    let perSecondRate = dailyProfit / 86400;
    let elapsedSeconds = (Date.now() - u.lastClaimTime) / 1000;
    let MinedAmount = Math.max(0, elapsedSeconds * perSecondRate);

    u.balance += MinedAmount;
    u.lastClaimTime = Date.now();
    await u.save();

    res.json({ success: true, balance: u.balance, lastClaimTime: u.lastClaimTime });
});

app.post('/api/deposit', async (req, res) => {
    const { userId, username, amount, usdtAmount, coin, txHash } = req.body;
    if (!userId || !amount || !txHash) {
        return res.status(400).json({ success: false, message: "Invalid deposit data." });
    }

    const cleanTxHash = String(txHash).trim();

    const existingPending = await PendingRequest.findOne({ txHash: cleanTxHash });
    if (existingPending) {
        return res.status(400).json({ 
            success: false, 
            message: "This TxHash has already been submitted and is currently pending!" 
        });
    }

    const existingUserHash = await User.findOne({ "deposits.txHash": cleanTxHash });
    if (existingUserHash) {
        return res.status(400).json({ 
            success: false, 
            message: "This TxHash has already been used! Please provide a new transaction hash." 
        });
    }

    let u = await User.findOne({ id: userId });
    if (u && u.isBanned) return res.status(403).json({ success: false, isBanned: true, message: "Your account is banned." });
    if (!u) u = new User({ id: userId, username: username || 'User' });

    if (username && username !== 'User') {
        u.username = username;
    }

    let exactUsdtVal = Number(usdtAmount) || 1;
    const reqId = 'dep_' + Date.now();
    
    u.deposits.unshift({ 
        id: reqId, 
        amount: amount, 
        usdtAmount: exactUsdtVal,
        coin: coin || 'LTC', 
        txHash: cleanTxHash, 
        status: 'PENDING', 
        date: new Date().toLocaleDateString() 
    });
    u.markModified('deposits');
    await u.save();

    await PendingRequest.create({ 
        reqId, 
        type: 'deposit', 
        userId, 
        amount: amount, 
        usdtAmount: exactUsdtVal,
        coin: coin || 'LTC',
        txHash: cleanTxHash, 
        status: 'PENDING' 
    });

    if (ADMIN_ID) {
        const msgText = `📥 **New Deposit Request**\n\n👤 User ID: \`${userId}\`\n💰 Amount: **${amount}** (${exactUsdtVal} USDT)\n🪙 Coin: **${coin || 'LTC'}**\n🔑 TxHash: \`${cleanTxHash}\``;
        const inlineKeyboard = {
            inline_keyboard: [[
                { text: "✅ Approve", callback_data: `approve_${reqId}` },
                { text: "❌ Reject", callback_data: `reject_${reqId}` }
            ]]
        };
        await sendTelegramMessage(ADMIN_ID, msgText, inlineKeyboard);
    }

    res.json({ success: true, message: "Deposit request submitted successfully" });
});

app.post('/api/withdraw', async (req, res) => {
    const { userId, username, amount, address } = req.body;
    let amt = parseFloat(amount);
    if (!userId || !amt || isNaN(amt) || amt <= 0 || !address) {
        return res.status(400).json({ success: false, message: "Invalid withdrawal data" });
    }

    let u = await User.findOne({ id: userId });
    if (!u || u.isBanned) {
        return res.status(403).json({ success: false, message: "Account restricted or banned" });
    }

    const existingPending = await PendingRequest.findOne({ userId: userId, type: 'withdraw', status: 'PENDING' });
    if (existingPending) {
        return res.status(400).json({ 
            success: false, 
            message: "Aapki pehle se ek withdrawal request pending hai. Pehle wo process hone dein!" 
        });
    }

    if (u.balance < amt) {
        let errMessage = "Gaaffiin kun sirriitti qabamee jira.";
        return res.status(400).json({ success: false, message: "Insufficient balance for withdrawal!" });
    }

    if (username && username !== 'User') {
        u.username = username;
    }

    u.balance = Math.max(0, u.balance - amt);

    const reqId = 'wd_' + Date.now();
    u.withdrawals.unshift({ 
        id: reqId, 
        amount: amt, 
        address, 
        status: 'PENDING', 
        date: new Date().toLocaleDateString() 
    });
    u.markModified('withdrawals');
    await u.save();

    await PendingRequest.create({ 
        reqId, 
        type: 'withdraw', 
        userId, 
        amount: amt, 
        address, 
        status: 'PENDING' 
    });

    if (ADMIN_ID) {
        const msgText = `📤 **New Withdraw Request**\n\n👤 User ID: \`${userId}\`\n💰 Amount: **${amt} LTC**\n🏦 Address: \`${address}\``;
        const inlineKeyboard = {
            inline_keyboard: [[
                { text: "✅ Approve", callback_data: `approve_${reqId}` },
                { text: "❌ Reject", callback_data: `reject_${reqId}` }
            ]]
        };
        await sendTelegramMessage(ADMIN_ID, msgText, inlineKeyboard);
    }

    res.json({ success: true, message: "Withdrawal request submitted successfully", newBalance: u.balance });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
    if (RENDER_URL) {
        try {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${RENDER_URL}/api/webhook/${BOT_TOKEN}`);
            console.log("Telegram Webhook Set Successfully!");
        } catch (e) {
            console.log("Failed to set webhook:", e);
        }
    }
});
