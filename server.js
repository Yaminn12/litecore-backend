const express = require('express');
const mongoose = require('mongoose');
const app = express();

// ================== SETTINGS ==================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) console.error('❌ BOT_TOKEN is missing! Add BOT_TOKEN in Render -> Environment.');
const ADMIN_ID = process.env.ADMIN_ID || "7108686404";
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "nbx12345";

// ================== MINING RULES ==================
const PLAN_DURATION_MS = 10 * 24 * 60 * 60 * 1000;
const PAID_RATE_PER_GHS_USD = 0.30;
const FREE_DAILY_USD = 0.01;

let ltcPriceCache = { price: 60, time: 0 };
async function getLtcPrice() {
    if (Date.now() - ltcPriceCache.time < 60000) return ltcPriceCache.price;
    try {
        const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=LTCUSDT');
        const d = await r.json();
        const p = parseFloat(d.price);
        if (p > 0) { ltcPriceCache = { price: p, time: Date.now() }; return p; }
    } catch (e) {}
    try {
        const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd');
        const d = await r.json();
        const p = Number(d && d.litecoin && d.litecoin.usd);
        if (p > 0) { ltcPriceCache = { price: p, time: Date.now() }; return p; }
    } catch (e) {}
    return ltcPriceCache.price;
}

function isPaidPlanActive(u, now = Date.now()) {
    return u.planActive !== false && Number(u.ghs) > 0 && !(u.planExpiryDate > 0 && now >= u.planExpiryDate);
}

function dailyUsdRate(u, now = Date.now()) {
    return isPaidPlanActive(u, now) ? Number(u.ghs) * PAID_RATE_PER_GHS_USD : FREE_DAILY_USD;
}

function accrueUsd(u, now = Date.now()) {
    const last = Number(u.lastClaimTime) || now;
    if (now <= last) return 0;
    let usd = 0;
    let cursor = last;
    if (u.planActive !== false && Number(u.ghs) > 0) {
        const paidEnd = (u.planExpiryDate > 0) ? Math.min(now, u.planExpiryDate) : now;
        if (paidEnd > cursor) {
            usd += ((paidEnd - cursor) / 1000) * (Number(u.ghs) * PAID_RATE_PER_GHS_USD / 86400);
            cursor = paidEnd;
        }
    }
    if (now > cursor) {
        usd += ((now - cursor) / 1000) * (FREE_DAILY_USD / 86400);
    }
    return usd;
}

function settleAccrual(u, now = Date.now()) {
    u.accruedUsd = Number(u.accruedUsd || 0) + accrueUsd(u, now);
    u.lastClaimTime = now;
}

function expireUserPlan(u, now = Date.now()) {
    settleAccrual(u, now);
    u.ghs = 0;
    u.planActive = false;
    u.planExpiryDate = 0;
    u.planStartDate = 0;
}

// ================== DATABASE ==================
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
                                u.planExpiryDate = parsedTime + PLAN_DURATION_MS;
                                await u.save();
                            }
                        }
                    }
                }

                if (u.planActive && u.planExpiryDate && u.planExpiryDate > 0 && currentTime >= u.planExpiryDate) {
                    expireUserPlan(u, currentTime);
                    await u.save();
                }
            }
            console.log('✅ All users plans & 10-day plan expiries auto-synced!');
        } catch (err) {
            console.log('Auto-sync error:', err);
        }
    })
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

const userSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, default: 'User' },
    balance: { type: Number, default: 0 },
    ghs: { type: Number, default: 0 },
    lastClaimTime: { type: Number, default: Date.now },
    accruedUsd: { type: Number, default: 0 },
    deposits: { type: Array, default: [] },
    withdrawals: { type: Array, default: [] },
    isBanned: { type: Boolean, default: false },
    planActive: { type: Boolean, default: true },
    planStartDate: { type: Number, default: 0 },
    planExpiryDate: { type: Number, default: 0 },
    referredBy: { type: String, default: null },
    referrals: {
        level1: { type: Array, default: [] },
        level2: { type: Array, default: [] },
        level3: { type: Array, default: [] }
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
    if (req.method === 'OPTIONS') return res.sendStatus(204);
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

// ================== TELEGRAM HELPERS ==================
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
            expireUserPlan(u, currentTime);
            await u.save();

            sendTelegramMessage(
                u.id,
                `❌ *Plan Expired:* Your plan was expired plzz renew plan agin 🚀`
            );
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

function setRequestStatus(list, reqId, pendingNames, newStatus) {
    let idx = list.findIndex(x => String(x.id) === String(reqId));
    if (idx !== -1) {
        list[idx].status = newStatus;
    } else {
        let p = list.find(x => pendingNames.includes(x.status));
        if (p) p.status = newStatus;
    }
}

async function payReferralCommissions(depositUser, usdtAmount) {
    const rates = [0.15, 0.03, 0.01];
    let current = depositUser;
    const ltcPrice = await getLtcPrice();
    const depositingUserId = depositUser.id;

    for (let lvl = 1; lvl <= 3; lvl++) {
        if (!current.referredBy) break;
        const refUser = await User.findOne({ id: current.referredBy });
        if (!refUser) break;

        const commUsdt = usdtAmount * rates[lvl - 1];
        const commLtc = commUsdt / ltcPrice;

        refUser.balance += commLtc;
        refUser.refEarnings[`level${lvl}`] = (refUser.refEarnings[`level${lvl}`] || 0) + commLtc;
        refUser.markModified('refEarnings');

        if (!refUser.referrals[`level${lvl}`]) {
            refUser.referrals[`level${lvl}`] = [];
        }
        
        let refList = refUser.referrals[`level${lvl}`];
        let existingRefIndex = refList.findIndex(r => (typeof r === 'string' ? r === depositingUserId : r.id === depositingUserId));

        if (existingRefIndex !== -1) {
            if (typeof refList[existingRefIndex] === 'string') {
                refList[existingRefIndex] = {
                    id: depositingUserId,
                    joinedDate: 'Active',
                    bonusEarned: commLtc
                };
            } else {
                refList[existingRefIndex].bonusEarned = (Number(refList[existingRefIndex].bonusEarned) || 0) + commLtc;
            }
        } else {
            refList.push({
                id: depositingUserId,
                joinedDate: 'Active',
                bonusEarned: commLtc
            });
        }
        refUser.markModified(`referrals.level${lvl}`);

        await refUser.save();

        sendTelegramMessage(
            refUser.id, 
            `🎁 Received +${commLtc.toFixed(4)} LTC ($${commUsdt.toFixed(2)} USDT) (${rates[lvl - 1] * 100}% Level ${lvl} Referral Commission)!`
        );
        
        current = refUser;
    }
}

async function approveRequest(reqDoc, u, reqId) {
    if (reqDoc.type === 'deposit' && u) {
        const depAmount = reqDoc.usdtAmount ? Number(reqDoc.usdtAmount) : 1;

        setRequestStatus(u.deposits, reqId, ['PENDING'], 'PAID');
        u.markModified('deposits');

        const now = Date.now();
        settleAccrual(u, now);

        const hadPaidPlan = isPaidPlanActive(u, now);
        u.ghs = hadPaidPlan ? Number(u.ghs) + depAmount : depAmount;
        u.planActive = true;
        u.planStartDate = now;
        u.planExpiryDate = now + PLAN_DURATION_MS;

        await u.save();
        await payReferralCommissions(u, depAmount);

        sendTelegramMessage(reqDoc.userId, `✅ Your deposit of ${reqDoc.amount} has been approved!\n⚡ +${depAmount} GHS Mining Power added (Valid for 10 Days).\n⛏️ Mining is now active. Collect your profit anytime from the app.`);
    } else if (reqDoc.type === 'withdraw' && u) {
        setRequestStatus(u.withdrawals, reqId, ['PENDING', 'PEND1NG'], 'PAID');
        u.markModified('withdrawals');
        await u.save();
        sendTelegramMessage(reqDoc.userId, `✅ Your withdrawal of ${reqDoc.amount} LTC has been approved!`);
    }
}

async function rejectRequest(reqDoc, u, reqId) {
    if (reqDoc.type === 'deposit' && u) {
        setRequestStatus(u.deposits, reqId, ['PENDING'], 'DECLINED');
        u.markModified('deposits');
        await u.save();
        sendTelegramMessage(reqDoc.userId, `❌ Your deposit request was declined.`);
    } else if (reqDoc.type === 'withdraw' && u) {
        u.balance += parseFloat(reqDoc.amount);
        setRequestStatus(u.withdrawals, reqId, ['PENDING', 'PEND1NG'], 'DECLINED');
        u.markModified('withdrawals');
        await u.save();
        sendTelegramMessage(reqDoc.userId, `❌ Your withdrawal request was declined and funds refunded.`);
    }
}

// ================== TELEGRAM WEBHOOK ==================
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
                    let refL1User = await User.findOne({ id: l1Id });
                    if (refL1User) {
                        let exists = refL1User.referrals.level1.some(r => (typeof r === 'string' ? r === chatId : r.id === chatId));
                        if (!exists) {
                            refL1User.referrals.level1.push({ id: chatId, joinedDate: 'Active', bonusEarned: 0 });
                            refL1User.markModified('referrals.level1');
                            await refL1User.save();
                        }
                    }
                    sendTelegramMessage(l1Id, `🎁 *New Level 1 Referral Joined!*\nUser ID: \`${chatId}\``);

                    const refL1 = await User.findOne({ id: l1Id });
                    if (refL1 && refL1.referredBy) {
                        const l2Id = refL1.referredBy;
                        let refL2User = await User.findOne({ id: l2Id });
                        if (refL2User) {
                            let existsL2 = refL2User.referrals.level2.some(r => (typeof r === 'string' ? r === chatId : r.id === chatId));
                            if (!existsL2) {
                                refL2User.referrals.level2.push({ id: chatId, joinedDate: 'Active', bonusEarned: 0 });
                                refL2User.markModified('referrals.level2');
                                await refL2User.save();
                            }
                        }

                        const refL2 = await User.findOne({ id: l2Id });
                        if (refL2 && refL2.referredBy) {
                            const l3Id = refL2.referredBy;
                            let refL3User = await User.findOne({ id: l3Id });
                            if (refL3User) {
                                let existsL3 = refL3User.referrals.level3.some(r => (typeof r === 'string' ? r === chatId : r.id === chatId));
                                if (!existsL3) {
                                    refL3User.referrals.level3.push({ id: chatId, joinedDate: 'Active', bonusEarned: 0 });
                                    refL3User.markModified('referrals.level3');
                                    await refL3User.save();
                                }
                            }
                        }
                    }
                }

                const vercelAppUrl = "https://lite-core-0r7t.vercel.app/";
                const welcomeCaption =
`🎉 *Welcome to Lite Core!*

_Mine LTC, invite friends and withdraw instantly._

⛏️ Start mining with free power
🎁 Buy plans & earn daily profit
👥 Invite friends & earn 3-level commission
💸 Withdraw straight to your wallet

👇 *Tap Open Mining to start!*`;
                const startPhotoUrl = "https://ibb.co/wFg2dtBX";

                const webAppMarkup = {
                    inline_keyboard: [
                        [{ text: "📢 Join Official Channel", url: "https://t.me/litecoreofficial" }],
                        [{ text: "💸 Join Payment Channel", url: "https://t.me/litecorepayments" }],
                        [{ text: "⛏️ Open Mining", web_app: { url: vercelAppUrl } }]
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

                const reqDoc = await PendingRequest.findOneAndDelete({ reqId });
                if (!reqDoc) return answerCallbackQuery(query.id, "Request already handled!");

                const u = await User.findOne({ id: reqDoc.userId });

                if (isApprove) {
                    await approveRequest(reqDoc, u, reqId);
                    editTelegramMessage(chatId, messageId, `✅ **Request Approved**\nUser ID: ${reqDoc.userId}\nAmount:${reqDoc.amount}`);
                } else {
                    await rejectRequest(reqDoc, u, reqId);
                    editTelegramMessage(chatId, messageId, `❌ **Request Rejected**\nUser ID: ${reqDoc.userId}\nAmount:${reqDoc.amount}`);
                }

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

// ================== ADMIN PANEL ==================
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
    const liveLtcPrice = await getLtcPrice();

    let totalPaidOut = 0;
    let totalGlobalDepositUsdt = 0;
    let activeDepositUsersCount = 0;
    let activeDepositUsersList = [];

    allUsers.forEach(u => {
        let userActualDepositSum = 0;
        if (u.deposits) {
            u.deposits.forEach(d => {
                if (d.status === 'PAID') {
                    let depUsdtVal = parseFloat(d.usdtAmount || 1);
                    userActualDepositSum += depUsdtVal;
                    totalGlobalDepositUsdt += depUsdtVal;
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

    let totalGlobalDepositLtc = totalGlobalDepositUsdt / liveLtcPrice;

    let searchId = req.query.search ? req.query.search.trim() : '';
    let searchedUser = null;
    let userTotalDepositUsdt = 0;
    let userTotalWithdrawLtc = 0;
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
                        userTotalDepositUsdt += parseFloat(d.usdtAmount || 1);
                    }
                });
            }
            if (searchedUser.withdrawals) {
                searchedUser.withdrawals.forEach(w => {
                    if (w.status === 'PAID') {
                        userTotalWithdrawLtc += parseFloat(w.amount || 0);
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

            <div style="background: #1c1917; border: 1px solid #292524; border-radius: 10px; padding: 10px 15px; margin-bottom: 15px; font-size: 13px; color: #38bdf8; display: flex; justify-content: space-between; align-items: center;">
                <span>📈 <b>Live LTC Price:</b> $${liveLtcPrice.toFixed(2)} USDT</span>
                <span style="font-size: 11px; color: #a8a29e;">Auto-updated</span>
            </div>

            <div class="stats-grid">
                <div class="stat-card"><div class="stat-title">Total Users</div><div class="stat-value">${totalUsers}</div></div>
                <div class="stat-card"><div class="stat-title">Total User Deposit</div><div class="stat-value">${totalGlobalDepositUsdt.toFixed(2)} USDT<br><span style="font-size:13px; color:#22c55e;">(${totalGlobalDepositLtc.toFixed(4)} LTC)</span></div></div>
                <div class="stat-card"><div class="stat-title">Total Active Plan Users ($1+)</div><div class="stat-value">${activeDepositUsersCount} Users</div></div>
                <div class="stat-card"><div class="stat-title">Paid Out</div><div class="stat-value">${totalPaidOut.toFixed(4)} LTC<br><span style="font-size:13px; color:#38bdf8;">($${(totalPaidOut * liveLtcPrice).toFixed(2)} USDT)</span></div></div>
                <div class="stat-card"><div class="stat-title">Pending Requests</div><div class="stat-value">${requests.length}</div></div>
            </div>

            <div class="nav-tabs">
                <div class="nav-tab active" onclick="switchTab('tab-users', this)">👥 Users & Plans</div>
                <div class="nav-tab" onclick="switchTab('tab-search', this)">🔍 Search & Manage</div>
                <div class="nav-tab" onclick="switchTab('tab-requests', this)">⏳ Pending Requests (${requests.length})</div>
                <div class="nav-tab" onclick="switchTab('tab-broadcast', this)">📢 Broadcast</div>
            </div>

            <div id="tab-users" class="tab-content active">
                <div class="card">
                    <h3>👥 Users With Active Plans ($1+ Deposits Only)</h3>
                    ${activeDepositUsersList.length === 0 ? `<p style="font-size:12px; color:#a8a29e;">No active plan users found.</p>` : `
                        <table>
                            <tr><th>User ID</th><th>Username</th><th>Total Deposit</th><th>GHS Power</th><th>Plan Expiry</th></tr>
                            ${activeDepositUsersList.map(depUser => {
                                let depTotalUsdt = 0;
                                if (depUser.deposits) {
                                    depUser.deposits.forEach(d => {
                                        if (d.status === 'PAID') depTotalUsdt += parseFloat(d.usdtAmount || 1);
                                    });
                                }
                                let depTotalLtc = depTotalUsdt / liveLtcPrice;
                                let displayUname = depUser.username ? (depUser.username.startsWith('@') ? depUser.username : '@' + depUser.username) : '@User';
                                let planDaysStr = getPlanDaysFormat(depUser);
                                return `
                                    <tr>
                                        <td><code>${depUser.id}</code></td>
                                        <td>${displayUname}</td>
                                        <td><b style="color:#22c55e;">${depTotalUsdt.toFixed(2)} USDT</b><br><span style="font-size:10px; color:#38bdf8;">(${depTotalLtc.toFixed(4)} LTC)</span></td>
                                        <td><b>${depUser.ghs} GHS</b></td>
                                        <td><b style="color:#38bdf8;">${planDaysStr}</b></td>
                                    </tr>
                                `;
                            }).join('')}
                        </table>
                    `}
                </div>
            </div>

            <div id="tab-search" class="tab-content">
                <div class="card">
                    <h3>🔍 Search User Details & Manage Plan</h3>
                    <form method="GET" action="/admin/dashboard" class="search-box">
                        <input type="text" name="search" placeholder="Enter Telegram User ID or Username" value="${searchId}">
                        <button type="submit" class="btn">Search</button>
                    </form>
                    ${searchedUser ? `
                        <div class="user-details-box">
                            <p>👤 <b>User Name:</b> ${searchedUser.username.startsWith('@' ) ? searchedUser.username : '@' + searchedUser.username} | <b>ID:</b> <code>${searchedUser.id}</code></p>
                            <p>💰 <b>Current Balance:</b> <span style="color:#38bdf8; font-weight:bold;">${searchedUser.balance.toFixed(4)} LTC</span> <span style="color:#22c55e;">($${(searchedUser.balance * liveLtcPrice).toFixed(2)} USDT)</span> | ⚡ <b>GHS Power:</b> ${searchedUser.ghs} GHS</p>
                            <p>🚫 <b>Account Status:</b> ${searchedUser.isBanned ? '<span style="color:#ef4444; font-weight:bold;">BANNED</span>' : '<span style="color:#22c55e; font-weight:bold;">ACTIVE</span>'}</p>
                            <p>⚡ <b>Mining Plan Status:</b> ${searchedUser.planActive !== false && searchedUser.ghs > 0 ? '<span style="color:#22c55e; font-weight:bold;">ACTIVE (' + getPlanDaysFormat(searchedUser) + ')</span>' : '<span style="color:#ef4444; font-weight:bold;">DEACTIVATED / EXPIRED (Free plan)</span>'}</p>
                            <p>📥 <b>Total Approved Deposit:</b> <span style="color:#22c55e; font-weight:bold;">${userTotalDepositUsdt.toFixed(2)} USDT</span> <span style="color:#38bdf8;">(${(userTotalDepositUsdt / liveLtcPrice).toFixed(4)} LTC)</span></p>
                            <p>📤 <b>Total Approved Withdraw:</b> <span style="color:#ef4444; font-weight:bold;">${userTotalWithdrawLtc.toFixed(4)} LTC</span> <span style="color:#38bdf8;">($${(userTotalWithdrawLtc * liveLtcPrice).toFixed(2)} USDT)</span> (<span style="color:#38bdf8;">${userPaidWithdrawCount} Times Paid</span>)</p>
                            <p>👥 <b>Referrals Count:</b> L1: ${searchedUser.referrals?.level1?.length || 0} | L2: ${searchedUser.referrals?.level2?.length || 0} | L3: ${searchedUser.referrals?.level3?.length || 0}</p>
                            <p>🎁 <b>Total Referral Commission:</b> <span style="color:#38bdf8; font-weight:bold;">${totalRefEarn.toFixed(4)} LTC</span> <span style="color:#22c55e;">($${(totalRefEarn * liveLtcPrice).toFixed(2)} USDT)</span></p>
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

    const now = Date.now();
    settleAccrual(u, now);

    if (action === 'activate') {
        u.planActive = true;
        if (u.ghs <= 0) u.ghs = 1;
        u.planStartDate = now;
        u.planExpiryDate = now + PLAN_DURATION_MS;
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

    const reqDoc = await PendingRequest.findOneAndDelete({ reqId });
    if (!reqDoc) return res.status(404).json({ success: false, message: "Request not found" });

    const u = await User.findOne({ id: reqDoc.userId });

    if (action === 'approve') {
        await approveRequest(reqDoc, u, reqId);
    } else if (action === 'reject') {
        await rejectRequest(reqDoc, u, reqId);
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

// ================== MINI APP API ==================
app.get('/api/user/:userId', async (req, res) => {
    const userId = String(req.params.userId);
    let user = await User.findOne({ id: userId });

    if (user && user.isBanned) {
        return res.status(403).json({ success: false, isBanned: true, message: "Your account is banned by admin." });
    }

    const now = Date.now();

    if (!user) {
        user = new User({ id: userId, username: 'User' });
        await user.save();
    } else if (user.planActive && user.planExpiryDate && user.planExpiryDate > 0 && now >= user.planExpiryDate) {
        expireUserPlan(user, now);
        await user.save();
    }

    const price = await getLtcPrice();
    const data = user.toObject();

    ['level1', 'level2', 'level3'].forEach(lvl => {
        if (data.referrals && Array.isArray(data.referrals[lvl])) {
            data.referrals[lvl] = data.referrals[lvl].map(r => {
                if (typeof r === 'string') {
                    return { id: r, joinedDate: 'Active', bonusEarned: 0 };
                }
                return {
                    id: r.id || r,
                    joinedDate: r.joinedDate || 'Active',
                    bonusEarned: Number(r.bonusEarned || 0)
                };
            });
        }
    });

    data.pendingUsd = Number(user.accruedUsd || 0) + accrueUsd(user, now);
    data.dailyUsd = dailyUsdRate(user, now);
    data.paidPlan = isPaidPlanActive(user, now);
    data.ltcPrice = price;
    res.json(data);
});

app.post('/api/update-ghs', async (req, res) => {
    const { userId } = req.body;
    let u = await User.findOne({ id: String(userId) });
    if (u && u.isBanned) return res.status(403).json({ success: false, isBanned: true, message: "Your account is banned." });
    res.json({ success: true, ghs: u ? u.ghs : 0 });
});

app.post('/api/claim', async (req, res) => {
    const userId = String(req.body.userId || '');
    const u = await User.findOne({ id: userId });
    if (!u || u.isBanned) return res.status(400).json({ success: false, message: "User not found or banned" });

    const now = Date.now();
    const totalUsd = Number(u.accruedUsd || 0) + accrueUsd(u, now);
    if (!(totalUsd > 0)) return res.status(400).json({ success: false, message: "Nothing to collect yet" });

    const price = await getLtcPrice();
    const ltcAmount = totalUsd / price;

    const updated = await User.findOneAndUpdate(
        { id: userId, lastClaimTime: u.lastClaimTime },
        { $inc: { balance: ltcAmount }, $set: { accruedUsd: 0, lastClaimTime: now } },
        { new: true }
    );
    if (!updated) return res.status(409).json({ success: false, message: "Please try again." });

    res.json({
        success: true,
        balance: updated.balance,
        lastClaimTime: updated.lastClaimTime,
        claimedLtc: ltcAmount,
        claimedUsd: totalUsd,
        ltcPrice: price
    });
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
    if (RENDER_URL && BOT_TOKEN) {
        try {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${RENDER_URL}/api/webhook/${BOT_TOKEN}`);
            console.log("Telegram Webhook Set Successfully!");
        } catch (e) {
            console.log("Failed to set webhook:", e);
        }
    }
});
