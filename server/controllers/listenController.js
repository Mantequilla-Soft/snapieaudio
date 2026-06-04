/**
 * Event-driven listen tracking — ported from the 3speak-checker
 * (preview.3speak.tv) pay-per-listen counter.
 *
 * A track counts as "one listen" only when ≥66% of its duration has actually
 * been *streamed* — never on mere page/audio load and never trustable from a
 * single client-reported number (trivially forged with curl). Instead:
 *   1. POST /api/audio/play-start → opens a server-side session, returns an
 *      HMAC-bound token + heartbeat interval.
 *   2. POST /api/audio/play-beat  → sent every ~3s while the audio is really
 *      playing (plus a final beat on pause/finish). The server credits only
 *      the *wall-clock gap it measures* between beats, clamped per beat — so
 *      faking one listen costs ~66% of the track's real duration of kept-alive
 *      heartbeats, not one HTTP call.
 *
 * Every credited listen writes ONE row to `audio-listen-log` (and bumps the
 * denormalised `plays` counter), so all reporting reads a single collection.
 * Each row carries `payable`:
 *   • payable:false — anonymous (or non-ppl / self / unmeasured) listen. Counts
 *     toward `plays` and analytics only.
 *   • payable:true  — logged-in listener on a pay-per-listen (`ppl`) track who
 *     is not the author. Eligible for the weekly payout.
 * IMPORTANT: the shared payout worker (3speak-checker audioPayouts.js) credits
 * the track owner for every row, so it MUST filter `payable: { $ne: false }`
 * or anonymous plays would inflate author payouts.
 *
 * Durationless tracks (duration missing/zero) can't be measured, so play-start
 * records one full listen deduped by IP per day (payable:false) as a fallback.
 */

const crypto = require('crypto');
const AudioMessage = require('../models/AudioMessage');

const LISTEN_LOG_COLLECTION = 'audio-listen-log';
const LISTEN_SESSION_COLLECTION = 'audio-listen-sessions';
const LISTEN_THRESHOLD = 0.66;
const BEAT_SECONDS = Math.max(1, parseInt(process.env.LISTEN_BEAT_SECONDS, 10) || 3);
// A single beat can credit at most this much real time (covers a slightly
// late beat / tab throttling) — a long gap from a paused/backgrounded tab is
// clamped, so silence is never counted. Floored so a short beat interval still
// tolerates the occasional delayed/throttled beat without under-counting.
const MAX_BEAT_CREDIT_MS = Math.max(BEAT_SECONDS * 1000 * 1.6, 8000);
// Same logged-in listener + same track within this window counts as one listen.
const LISTEN_DEDUPE_MS = (parseInt(process.env.LISTEN_DEDUPE_MIN, 10) || 30) * 60 * 1000;
// Same IP + same track within this window counts as one anonymous play.
const PLAY_DEDUPE_MS = (parseInt(process.env.PLAY_DEDUPE_MIN, 10) || 30) * 60 * 1000;
// Durationless fallback: one full listen per IP+track per day.
const NO_DURATION_DEDUPE_MS = 24 * 60 * 60 * 1000;
// Per-process secret. Sessions live only minutes (< one track), so losing
// them on restart is fine and we don't need a configured secret.
const SESSION_SECRET = crypto.randomBytes(32);

const HIVE_NAME_RE = /^[a-z][a-z0-9.-]{2,15}$/;

// Optional, env-gated heartbeat obfuscation. When LISTEN_BEAT_KEY is set the
// /play-beat body must be AES-256-GCM ciphertext keyed off it. NOTE: the
// frontend key ships in the public JS, so this is *obfuscation /
// anti-casual-tampering*, NOT cryptographic protection — the real anti-forge
// guarantee is the server-measured wall-clock between beats. Unset → plain
// JSON beats (backward compatible).
const LISTEN_BEAT_KEY = process.env.LISTEN_BEAT_KEY || '';
const beatKeyBuf = LISTEN_BEAT_KEY
    ? crypto.createHash('sha256').update(LISTEN_BEAT_KEY).digest()
    : null;

// Layout: base64( iv[12] | ciphertext | gcmTag[16] ) — matches WebCrypto's
// AES-GCM output (tag appended to ciphertext).
function decryptBeat(encB64) {
    const raw = Buffer.from(String(encB64), 'base64');
    if (raw.length < 12 + 16 + 2) throw new Error('short');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', beatKeyBuf, iv);
    d.setAuthTag(tag);
    const pt = Buffer.concat([d.update(ct), d.final()]);
    return JSON.parse(pt.toString('utf8'));
}

let listenIndexesEnsured = false;
async function ensureListenIndexes(db) {
    if (listenIndexesEnsured) return;
    listenIndexesEnsured = true;
    try {
        const log = db.collection(LISTEN_LOG_COLLECTION);
        await log.createIndex({ username: 1, permlink: 1, createdAt: -1 }); // user dedupe + payout
        await log.createIndex({ ip: 1, permlink: 1, createdAt: -1 });       // anon dedupe
        await log.createIndex({ permlink: 1, createdAt: -1 });              // per-track reporting
        await log.createIndex({ owner: 1, createdAt: -1 });                 // per-author reporting
        const sess = db.collection(LISTEN_SESSION_COLLECTION);
        await sess.createIndex({ sid: 1 }, { unique: true });
        await sess.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL cleanup
    } catch (err) {
        listenIndexesEnsured = false;
        console.error('Failed to ensure audio-listen indexes:', err.message);
    }
}

// Real client IP — the player sits behind nginx which sets X-Real-IP /
// X-Forwarded-For. Fall back to the socket address for direct hits.
function clientIp(req) {
    const xri = req.headers['x-real-ip'];
    if (xri) return String(xri).trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    return req.socket?.remoteAddress || req.ip || 'unknown';
}

function sessionToken(sid, permlink, ip) {
    return crypto.createHmac('sha256', SESSION_SECRET)
        .update(`${sid}.${permlink}.${ip}`).digest('hex');
}
function tokenMatches(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}

/**
 * Append one listen row + bump `plays`, deduped so a refresh/replay loop can't
 * inflate counts. A logged-in listener dedupes by username (so they count once
 * across devices/IPs); anonymous listeners dedupe by IP. Returns true if a new
 * row was written.
 */
async function recordListen(db, row, dedupeMs) {
    const log = db.collection(LISTEN_LOG_COLLECTION);
    const ident = row.username
        ? { username: row.username, permlink: row.permlink }
        : { ip: row.ip, permlink: row.permlink };
    const dupe = await log.findOne(
        { ...ident, createdAt: { $gt: new Date(row.createdAt.getTime() - dedupeMs) } },
        { projection: { _id: 1 } },
    );
    if (dupe) return false;
    // UTC calendar day of the listen (YYYY-MM-DD) — convenient for reporting
    // and the consolidation job's per-day/per-period grouping.
    await log.insertOne({ ...row, listenDate: row.createdAt.toISOString().slice(0, 10) });
    await AudioMessage.incrementPlays(row.permlink);
    return true;
}

/**
 * POST /api/audio/play-start — open a measured listen session.
 * body: { permlink, username? }   (username only credited if logged in)
 *
 * We open a session for every track (the anonymous `plays` counter needs the
 * same anti-forge measurement). `payable` tells the client whether this
 * session can also earn a pay-per-listen credit. A durationless track can't be
 * measured, so it records one full listen here and returns no session.
 */
exports.playStart = async (req, res) => {
    try {
        const db = await AudioMessage.connectDB();
        await ensureListenIndexes(db);

        const permlink = typeof req.body?.permlink === 'string' ? req.body.permlink.trim() : '';
        if (!permlink || permlink.length > 256) {
            return res.status(400).json({ error: 'Invalid permlink' });
        }
        const rawName = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
        const username = HIVE_NAME_RE.test(rawName) ? rawName : null;

        const track = await db.collection(AudioMessage.getAudioCollectionName()).findOne(
            { permlink },
            { projection: { owner: 1, post_permlink: 1, duration: 1, ppl: 1 } },
        );
        if (!track) return res.status(404).json({ error: 'Unknown track' });

        const ip = clientIp(req);
        const duration = Number(track.duration);

        // Durationless track: we can't measure ≥66%, so fall back to counting
        // one full listen per IP per day. Never payable — an unmeasured listen
        // must not earn (it would be pay-on-load).
        if (!Number.isFinite(duration) || duration <= 0) {
            await recordListen(db, {
                ip,
                username,
                permlink,
                owner: track.owner || null,
                post_permlink: track.post_permlink || null,
                listenedSeconds: null,
                trackDuration: null,
                payable: false,
                noDuration: true,
                createdAt: new Date(),
            }, NO_DURATION_DEDUPE_MS);
            return res.json({ tracked: false, payable: false, reason: 'no_duration' });
        }

        // A session earns a pay-per-listen credit only when the track opts in
        // (ppl) AND a logged-in listener who is NOT the author is streaming it
        // (self-listen would be self-dealing). Otherwise it still counts the
        // play, just without a payout-eligible row.
        const payable = !!username && track.ppl === true && username !== track.owner;

        const sid = crypto.randomBytes(16).toString('hex');
        const durationMs = Math.round(duration * 1000);
        const now = new Date();

        await db.collection(LISTEN_SESSION_COLLECTION).insertOne({
            sid,
            permlink,
            owner: track.owner || null,
            post_permlink: track.post_permlink || null,
            durationMs,
            ip,
            username,             // stored for reporting even when not payable
            payable,
            accumulatedMs: 0,
            credited: false,
            startedAt: now,
            lastBeatAt: now,
            // Generous TTL: a few track-lengths so a paused tab can resume.
            expiresAt: new Date(Date.now() + durationMs * 4 + 5 * 60 * 1000),
        });

        res.json({
            sid,
            token: sessionToken(sid, permlink, ip),
            beatSeconds: BEAT_SECONDS,
            threshold: LISTEN_THRESHOLD,
            payable,
            encrypted: !!beatKeyBuf,
        });
    } catch (error) {
        console.error('Error starting listen session:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * POST /api/audio/play-beat — heartbeat while the audio is really playing.
 * body: { sid, token }  — or { enc } when LISTEN_BEAT_KEY is set
 */
exports.playBeat = async (req, res) => {
    try {
        const db = await AudioMessage.connectDB();

        let sid, token;
        if (beatKeyBuf) {
            if (typeof req.body?.enc !== 'string') {
                return res.status(400).json({ error: 'encryption_required' });
            }
            try {
                const dec = decryptBeat(req.body.enc);
                sid = typeof dec?.sid === 'string' ? dec.sid : '';
                token = typeof dec?.token === 'string' ? dec.token : '';
            } catch {
                return res.status(400).json({ error: 'bad_ciphertext' });
            }
        } else {
            sid = typeof req.body?.sid === 'string' ? req.body.sid : '';
            token = typeof req.body?.token === 'string' ? req.body.token : '';
        }
        if (!sid || !token) return res.status(400).json({ error: 'Invalid beat' });

        const sessions = db.collection(LISTEN_SESSION_COLLECTION);
        const s = await sessions.findOne({ sid });
        if (!s) return res.status(410).json({ error: 'no_session' });

        // Token is bound to the session's permlink + the IP seen at start —
        // a sid alone can't be replayed against another track.
        if (!tokenMatches(token, sessionToken(sid, s.permlink, s.ip))) {
            return res.status(403).json({ error: 'bad_token' });
        }
        if (s.credited) {
            return res.json({ progress: 1, credited: true, done: true });
        }

        const now = Date.now();
        const gap = Math.max(0, now - new Date(s.lastBeatAt).getTime());
        // The crux: credit only the real elapsed time between beats, capped
        // so one delayed/forged beat can't claim a huge span.
        const credit = Math.min(gap, MAX_BEAT_CREDIT_MS);
        const accumulatedMs = s.accumulatedMs + credit;
        const qualifies = accumulatedMs >= s.durationMs * LISTEN_THRESHOLD;

        // Always advance the running total + last-beat clock.
        await sessions.updateOne(
            { sid },
            { $set: { accumulatedMs, lastBeatAt: new Date(now) } },
        );

        let credited = false;
        if (qualifies) {
            // Atomically claim the credit exactly once for this session.
            const claim = await sessions.findOneAndUpdate(
                { sid, credited: { $ne: true } },
                { $set: { credited: true } },
            );
            if ((claim?.value ?? claim)) {
                credited = true;
                await recordListen(db, {
                    ip: s.ip,
                    username: s.username || null,
                    permlink: s.permlink,
                    owner: s.owner,
                    post_permlink: s.post_permlink,
                    listenedSeconds: Math.round(accumulatedMs / 1000),
                    trackDuration: Math.round(s.durationMs / 1000),
                    payable: !!s.payable,
                    createdAt: new Date(now),
                }, s.username ? LISTEN_DEDUPE_MS : PLAY_DEDUPE_MS);
            }
        }

        res.json({
            progress: Math.min(1, accumulatedMs / s.durationMs),
            credited,
            done: credited,
        });
    } catch (error) {
        console.error('Error recording listen beat:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};
