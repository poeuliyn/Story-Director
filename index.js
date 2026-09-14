// Story Director — SillyTavern extension.
// A separate "Director" AI call reviews the story after every {char} reply
// and decides whether to open, advance, or resolve a plot thread. Character
// Diary entries are long first-person reflections tied to the same threads.
// Created by Purryverse.

let extension_settings, getContext, saveSettingsDebounced, eventSource, event_types, callGenericPopup, POPUP_TYPE;

async function loadCoreModules() {
    const errors = [];
    try {
        const mod = await import("../../../extensions.js");
        extension_settings = mod.extension_settings;
        getContext = mod.getContext;
        if (!extension_settings || !getContext) errors.push("extensions.js loaded but missing expected exports");
    } catch (e) {
        console.error("[Story Director] Failed to import extensions.js. Check install path.", e);
        errors.push("extensions.js");
    }
    try {
        const mod = await import("../../../../script.js");
        saveSettingsDebounced = mod.saveSettingsDebounced;
        eventSource = mod.eventSource;
        event_types = mod.event_types;
        if (!saveSettingsDebounced || !eventSource || !event_types) errors.push("script.js loaded but missing expected exports");
    } catch (e) {
        console.error("[Story Director] Failed to import script.js. Check install path.", e);
        errors.push("script.js");
    }
    try {
        const mod = await import("../../../popup.js");
        callGenericPopup = mod.callGenericPopup;
        POPUP_TYPE = mod.POPUP_TYPE;
        if (!callGenericPopup || !POPUP_TYPE) errors.push("popup.js loaded but missing expected exports");
    } catch (e) {
        console.error("[Story Director] Failed to import popup.js. Check install path.", e);
        errors.push("popup.js");
    }
    return errors;
}

const MODULE_NAME = "story_director";

// Optional grounding sources — character card, persona, World Info. Loaded
// defensively; if a path doesn't match your ST version, grounding is skipped.
let power_user_ref = null;
let getWorldInfoPromptRef = null;

async function loadOptionalModules() {
    try {
        const puMod = await import("../../../power-user.js");
        power_user_ref = puMod.power_user || null;
    } catch (e) {
        console.warn("[Story Director] Could not load power-user.js; persona grounding skipped.", e);
    }
    try {
        const wiMod = await import("../../../world-info.js");
        getWorldInfoPromptRef = wiMod.getWorldInfoPrompt || null;
    } catch (e) {
        console.warn("[Story Director] Could not load world-info.js; Lorebook grounding skipped.", e);
    }
}

// Connection Profile support — Director and diary calls always use a
// separate API call, never a piggybacked instruction on the main model.
let ConnectionManagerRequestServiceRef = null;
let lastConnectionManagerDiagnostic = "";

function resolveCustomRequestUrl() {
    try {
        const selfUrl = import.meta.url;
        const marker = "/scripts/";
        const idx = selfUrl.indexOf(marker);
        if (idx === -1) return null;
        return selfUrl.slice(0, idx + marker.length) + "custom-request.js";
    } catch (e) {
        return null;
    }
}

async function loadConnectionManagerModule() {
    if (ConnectionManagerRequestServiceRef) return;
    try {
        const context = getContext();
        if (context && context.ConnectionManagerRequestService) {
            ConnectionManagerRequestServiceRef = context.ConnectionManagerRequestService;
            return;
        }
    } catch (e) { /* fall through */ }

    const rebased = resolveCustomRequestUrl();
    const candidatePaths = [rebased, "../../../custom-request.js", "../../../extensions/connection-manager/index.js"].filter(Boolean);
    for (const path of candidatePaths) {
        try {
            const mod = await import(/* webpackIgnore: true */ path);
            if (mod && mod.ConnectionManagerRequestService) {
                ConnectionManagerRequestServiceRef = mod.ConnectionManagerRequestService;
                return;
            }
        } catch (e) { /* try next */ }
    }

    let hints = [];
    try {
        const context = getContext();
        hints = Object.keys(context || {}).filter((k) => /connect|profile/i.test(k));
    } catch (e) { /* best effort */ }
    lastConnectionManagerDiagnostic = `context keys: ${hints.length ? hints.join(", ") : "(none found)"} | url: ${rebased || "n/a"}`;
    console.warn("[Story Director] Could not find ConnectionManagerRequestService. Requires Connection Profiles (ST 1.12.6+) enabled.");
}

function getSavedConnectionProfiles() {
    try {
        const context = getContext();
        const profiles = context.extensionSettings?.connectionManager?.profiles;
        return Array.isArray(profiles) ? profiles : [];
    } catch (e) {
        return [];
    }
}

function withTimeout(promise, ms, timeoutMessage) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage || "timeout")), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function requestSeparateGeneration(cfg, promptText, maxTokens) {
    try {
        if (!cfg.apiProfileId) {
            notify('Story Director: ยังไม่ได้เลือกโปรไฟล์ API (แท็บ "ทั่วไป")', true);
            return null;
        }
        if (!ConnectionManagerRequestServiceRef) await loadConnectionManagerModule();
        if (!ConnectionManagerRequestServiceRef) {
            notify(`Story Director: ไม่พบ Connection Profile — ${lastConnectionManagerDiagnostic || "ดู console"}`, true);
            return null;
        }
        const result = await withTimeout(
            ConnectionManagerRequestServiceRef.sendRequest(cfg.apiProfileId, promptText, Math.max(50, Number(maxTokens) || 300)),
            60000,
            "หมดเวลารอคำตอบจาก API (60 วินาที)"
        );
        if (typeof result === "string") return result;
        if (result && typeof result.content === "string") return result.content;
        if (result && Array.isArray(result.choices) && result.choices[0]?.message?.content) return result.choices[0].message.content;
        console.warn("[Story Director] Unrecognized response shape:", result);
        notify("Story Director: รูปแบบคำตอบจาก API ไม่ตรงที่คาดไว้ (ดู console)", true);
        return null;
    } catch (e) {
        console.warn("[Story Director] Separate API request failed:", e);
        notify(`Story Director: เรียก API ไม่สำเร็จ — ${e?.message || "unknown error"}`, true);
        return null;
    }
}

function getRecentChatTranscript(maxMessages) {
    try {
        const context = getContext();
        const chat = Array.isArray(context.chat) ? context.chat : [];
        const recent = chat.slice(-Math.max(1, maxMessages || 10));
        return recent.map((m) => `${m.is_user ? (context.name1 || "User") : (m.name || getCharacterName())}: ${truncateText(m.mes || "", 600)}`).join("\n");
    } catch (e) {
        console.warn("[Story Director] Could not build transcript:", e);
        return "";
    }
}

// Defaults

const THEME_TAGS = ["Comedy", "Sci-Fi", "Fantasy", "Romance", "Drama", "Horror", "Thriller", "Mystery", "Action"];

const DEFAULT_CHAT_SETTINGS = () => ({
    enabled: true,
    tags: [],

    maxActiveThreads: 3,
    frequencyMode: "random",      // 'interval' | 'random'
    intervalN: 6,
    randomChance: 20,
    eventIntensity: "medium",     // 'mild' | 'medium' | 'disruptive'
    presentation: "subtle",       // 'subtle' | 'narrator' | 'both'
    dormantMemory: 6,

    soundEnabled: true,
    soundStyle: "notif1",

    diaryEnabled: true,
    diaryAdvanceChance: 50,
    diaryStickersEnabled: true,
    diaryBannerEnabled: true,

    calendarStartDate: "",

    apiProfileId: "",
    apiMaxTokensDirector: 500,
    apiMaxTokensDiary: 1800,

    promptPreviewEnabled: false,
});

function getDefaultSettings() {
    return { globalEnabled: true, chats: {} };
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = getDefaultSettings();
    if (!extension_settings[MODULE_NAME].chats) extension_settings[MODULE_NAME].chats = {};
    return extension_settings[MODULE_NAME];
}

function getChatKey() {
    const context = getContext();
    try {
        if (typeof context.getCurrentChatId === "function") {
            const id = context.getCurrentChatId();
            if (id) return String(id);
        }
        if (context.chatId) return String(context.chatId);
        return "__default__";
    } catch (e) {
        return "__default__";
    }
}

function getChatSettings() {
    const settings = ensureSettings();
    const key = getChatKey();
    if (!settings.chats[key]) settings.chats[key] = DEFAULT_CHAT_SETTINGS();
    const cfg = settings.chats[key];
    const fresh = DEFAULT_CHAT_SETTINGS();
    for (const k of Object.keys(fresh)) if (cfg[k] === undefined) cfg[k] = fresh[k];
    if (!Array.isArray(cfg.tags)) cfg.tags = [];
    return cfg;
}

// Per-chat state: threads, diary log, calendar. Stored on chatMetadata.

const MAX_EVENT_LOG = 200;
const MAX_DORMANT_THREADS = 20;

function getChatState() {
    const context = getContext();
    if (!context.chatMetadata) context.chatMetadata = {};
    if (!context.chatMetadata[MODULE_NAME]) {
        context.chatMetadata[MODULE_NAME] = {
            activeThreads: [],
            dormantThreads: [],
            diaryLog: [],
            eventLog: [],
            totalFired: 0,
            lastProcessedMesId: -1,
            messagesSinceCheck: 0,
            forceNextCheck: false,
            storyCalendar: null,
        };
    }
    const state = context.chatMetadata[MODULE_NAME];
    if (!Array.isArray(state.activeThreads)) state.activeThreads = [];
    if (!Array.isArray(state.dormantThreads)) state.dormantThreads = [];
    if (!Array.isArray(state.diaryLog)) state.diaryLog = [];
    if (!Array.isArray(state.eventLog)) state.eventLog = [];
    if (typeof state.totalFired !== "number") state.totalFired = 0;
    if (typeof state.lastProcessedMesId !== "number") state.lastProcessedMesId = -1;
    if (typeof state.messagesSinceCheck !== "number") state.messagesSinceCheck = 0;
    if (typeof state.forceNextCheck !== "boolean") state.forceNextCheck = false;
    return state;
}

function saveChatState() {
    try {
        const context = getContext();
        if (typeof context.saveMetadataDebounced === "function") context.saveMetadataDebounced();
    } catch (e) {
        console.warn("[Story Director] Could not save chat state:", e);
    }
}

function logEvent(state, summary, action) {
    state.eventLog.push({ summary: summary || "(ไม่ทราบ)", action, time: new Date().toISOString() });
    if (state.eventLog.length > MAX_EVENT_LOG) state.eventLog.splice(0, state.eventLog.length - MAX_EVENT_LOG);
}

function clampNum(raw, fallback, min, max) {
    const n = Number(raw);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function escapeHtml(str) {
    return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function truncateText(str, max) {
    const s = String(str ?? "");
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function getCharacterName() {
    try {
        const context = getContext();
        const chid = context.characterId;
        const character = context.characters?.[chid];
        return (character && character.name) || context.name2 || "ตัวละครนี้";
    } catch (e) {
        return "ตัวละครนี้";
    }
}

// Grounding — character card + persona + World Info

function getGroupObject(context) {
    try {
        if (!context.groupId || !Array.isArray(context.groups)) return null;
        return context.groups.find((g) => String(g.id) === String(context.groupId)) || null;
    } catch (e) {
        return null;
    }
}

function getGroupMemberCharacters(context, group) {
    try {
        const members = Array.isArray(group.members) ? group.members : [];
        const disabled = new Set(Array.isArray(group.disabled_members) ? group.disabled_members : []);
        return members.filter((avatar) => !disabled.has(avatar))
            .map((avatar) => (context.characters || []).find((c) => c && c.avatar === avatar))
            .filter(Boolean);
    } catch (e) {
        return [];
    }
}

function getCharacterCardContext() {
    try {
        const context = getContext();
        const group = getGroupObject(context);
        if (group) {
            const members = getGroupMemberCharacters(context, group);
            if (members.length === 0) return "";
            const parts = members.map((character) => {
                const bits = [];
                if (character.description) bits.push(`Description: ${truncateText(character.description, 500)}`);
                if (character.personality) bits.push(`Personality: ${truncateText(character.personality, 250)}`);
                if (character.scenario) bits.push(`Scenario: ${truncateText(character.scenario, 250)}`);
                return `- ${character.name || "Unnamed character"}:\n  ${bits.join("\n  ")}`;
            });
            return `GROUP CHAT — facts below are per named character, do not blend them:\n${parts.join("\n")}`;
        }
        const chid = context.characterId;
        const character = context.characters?.[chid];
        if (!character) return "";
        const parts = [];
        if (character.description) parts.push(`Character description ({{char}}): ${truncateText(character.description, 900)}`);
        if (character.personality) parts.push(`Character personality traits: ${truncateText(character.personality, 400)}`);
        if (character.scenario) parts.push(`Scenario: ${truncateText(character.scenario, 400)}`);
        return parts.join("\n");
    } catch (e) {
        console.warn("[Story Director] Could not read character card:", e);
        return "";
    }
}

function getPersonaContext() {
    try {
        const desc = power_user_ref?.persona_description;
        return desc ? `User persona ({{user}}): ${truncateText(desc, 600)}` : "";
    } catch (e) {
        return "";
    }
}

let cachedWorldInfoText = "";
async function refreshWorldInfoCache() {
    try {
        if (typeof getWorldInfoPromptRef !== "function") { cachedWorldInfoText = ""; return; }
        const context = getContext();
        const chat = context.chat || [];
        const result = await getWorldInfoPromptRef(chat, 999999, true);
        cachedWorldInfoText = result?.worldInfoString || [result?.worldInfoBefore, result?.worldInfoAfter].filter(Boolean).join("\n") || "";
    } catch (e) {
        console.warn("[Story Director] World Info lookup failed:", e);
        cachedWorldInfoText = "";
    }
}

function buildGroundingBlock() {
    const parts = [
        getCharacterCardContext(),
        getPersonaContext(),
        cachedWorldInfoText ? `Active Lorebook/World Info entries:\n${truncateText(cachedWorldInfoText, 1500)}` : "",
    ].filter(Boolean);
    if (parts.length === 0) return "";
    return `\n\nEstablished facts — draw from these, don't contradict them:\n${parts.join("\n\n")}`;
}

// Shared prompt notes

const INTENSITY_NOTES = {
    mild: "Keep it a small, low-key beat that fits smoothly into the current scene without derailing it.",
    medium: "Make it a clear, noticeable development — enough that it actually changes what happens next, not just background color.",
    disruptive: "Make it a real disruption to the current routine or status quo. Change the situation, location, stakes, or relationships in a way the characters cannot simply ignore or return to normal from right away.",
};
function getIntensityNote(cfg) { return INTENSITY_NOTES[cfg.eventIntensity] || INTENSITY_NOTES.medium; }

function getStyleNote(cfg) {
    return cfg.presentation === "narrator"
        ? "Present it as a brief narrator/GM interjection, clearly tagged and visibly separate from the ongoing narration."
        : cfg.presentation === "both"
        ? "Either weave it into the prose narration or set it off as a brief narrator interjection — whichever fits the scene better."
        : "Weave it into the ongoing prose narration itself, seamlessly continuing the scene — not as something the character says out loud, and not as a separate visibly-tagged interjection.";
}

const ANTI_LEAK_NOTE = "Treat this as your own authorial choice for how the scene naturally continues, not an order from outside it — don't reference this note, mention any tool or app, or comment on having received directions of any kind.";
const PACING_NOTE = "Treat this as an addition to your reply to {{user}}'s last message, not a replacement for it — respond to what they said and weave the event in without padding the reply's length just to fit it.";
const COMPLETENESS_NOTE = "Make it a complete, self-contained beat: a clear trigger, a concrete development, and something that actually happens on the page.";

function buildEventInjectionText(cfg, detail) {
    return `Scene direction: let this shape what happens next in the story: ${detail}. ${getIntensityNote(cfg)} ${getStyleNote(cfg)} ${PACING_NOTE} ${COMPLETENESS_NOTE} ${ANTI_LEAK_NOTE}${buildGroundingBlock()}`;
}

// In-story calendar — no separate Time Skip subsystem; the Director
// estimates elapsed time as part of its normal decision.

const ELAPSED_DAYS = { same_day: 0, next_day: 1, few_days: 3, week_plus: 9 };

function ensureCalendar(cfg, state) {
    if (!state.storyCalendar) {
        const anchor = cfg.calendarStartDate ? new Date(cfg.calendarStartDate) : new Date();
        if (isNaN(anchor.getTime())) anchor.setTime(Date.now());
        state.storyCalendar = { anchorDate: anchor.toISOString(), daysSinceAnchor: 0 };
    }
    return state.storyCalendar;
}

function advanceStoryCalendar(cfg, state, hint) {
    const cal = ensureCalendar(cfg, state);
    cal.daysSinceAnchor += ELAPSED_DAYS[hint] ?? 0;
}

function getInStoryDate(cfg, state) {
    const cal = ensureCalendar(cfg, state);
    const d = new Date(cal.anchorDate);
    d.setDate(d.getDate() + cal.daysSinceAnchor);
    return d.toISOString();
}

const THAI_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const THAI_WEEKDAYS = ["วันอาทิตย์", "วันจันทร์", "วันอังคาร", "วันพุธ", "วันพฤหัสบดี", "วันศุกร์", "วันเสาร์"];

function formatThaiDate(isoString) {
    try {
        const d = new Date(isoString);
        return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${d.getFullYear()} ${THAI_WEEKDAYS[d.getDay()]}`;
    } catch (e) {
        return isoString;
    }
}

// Director — decides open/advance/resolve after every {char} message.

function buildDirectorPrompt(cfg, state) {
    const activeThreads = state.activeThreads;
    const threadBlock = activeThreads.length
        ? activeThreads.map((t, i) => `${i + 1}. [${t.status}] "${t.title}" (ความเข้มข้นสะสม: ${t.emotionalCharge}/100)\n   ล่าสุด: ${t.beats[t.beats.length - 1]?.summary || t.originSummary}`).join("\n")
        : "(ยังไม่มีเธรดที่ค้างอยู่)";

    const dormantBlock = state.dormantThreads.slice(-Math.max(1, cfg.dormantMemory || 6))
        .map((t) => `- "${t.title}" (ปิดไปแล้ว: ${t.beats[t.beats.length - 1]?.summary || t.originSummary})`).join("\n") || "(ไม่มี)";

    const tagList = cfg.tags.length ? cfg.tags.join(", ") : "อิสระตามโทนเรื่องปัจจุบัน";
    const transcript = getRecentChatTranscript(12);

    return `คุณคือ "Story Director" ของแชท roleplay เรื่องหนึ่ง หน้าที่ของคุณคือดูแลไม่ให้เรื่องนิ่งจนน่าเบื่อ โดยตัดสินใจแต่ละครั้งว่าจะทำอะไรกับ "เธรด" (ปมเรื่อง/ความสัมพันธ์ที่ยังค้างอยู่) ต่อไปนี้

เธรดที่กำลังดำเนินอยู่:
${threadBlock}

เธรดที่ปิดไปแล้วล่าสุด (ห้ามหยิบมาเปิดซ้ำ):
${dormantBlock}

ธีมที่อนุญาต: ${tagList}

บทสนทนาล่าสุด:
${transcript || "(ไม่มี)"}

กติกาการตัดสินใจ:
- ถ้ามีเธรดค้างอยู่แล้ว ให้เอนเอียงไปทาง "ดันเธรดเดิม" มากกว่าเปิดใหม่ (สูงสุด ${cfg.maxActiveThreads} เธรดพร้อมกัน)
- เธรดที่ emotionalCharge ใกล้ 100 ควรถูกดันไปที่ peak แล้วปิด ไม่ปล่อยค้างเรื่อยๆ
- ถ้าไม่มีเธรดค้างเลย หรือทุกเธรดเพิ่งขยับไปเมื่อกี้ ให้เปิดเธรดใหม่ 1 อัน
- ห้ามเปิดเธรดที่ซ้ำ/คล้ายกับเธรดที่ปิดไปแล้วด้านบน
- action "none" ใช้เมื่อบทสนทนาล่าสุดกำลังมีจังหวะดีอยู่แล้ว ไม่จำเป็นต้องแทรกอะไรตานี้
- ประเมิน timeElapsedHint ตามบริบทฉากปัจจุบันตามจริง อย่าข้ามเวลาพร่ำเพรื่อ

ตอบกลับเป็น JSON เท่านั้น ไม่มีข้อความอื่นก่อน/หลัง ตามรูปแบบนี้:
{
  "action": "open_new" | "advance" | "peak_and_close" | "none",
  "threadIndex": <เลขลำดับเธรดจากลิสต์ด้านบน ถ้า action คือ advance/peak_and_close, ไม่งั้นใส่ null>,
  "title": "<ชื่อเธรดสั้นๆ ถ้าเปิดใหม่, ไม่งั้น null>",
  "detail": "<2-4 ประโยค บอกว่าเกิดอะไรขึ้นในฉากนี้ ให้ narrator เอาไปเขียนต่อ>",
  "emotionalDelta": <ตัวเลข -20 ถึง 40 ที่จะบวกเข้า emotionalCharge ของเธรดนี้>,
  "timeElapsedHint": "same_day" | "next_day" | "few_days" | "week_plus"
}`;
}

function extractJson(raw) {
    if (typeof raw !== "string") return null;
    const match = raw.match(/\{[\s\S]*\}/);
    try {
        return JSON.parse(match ? match[0] : raw);
    } catch (e) {
        return null;
    }
}

async function runDirectorDecision(cfg, state) {
    const prompt = buildDirectorPrompt(cfg, state);
    const raw = await requestSeparateGeneration(cfg, prompt, cfg.apiMaxTokensDirector || 500);
    if (!raw) return null;
    const parsed = extractJson(raw);
    if (!parsed || !parsed.action) {
        console.warn("[Story Director] Director call returned unparseable JSON:", raw);
        notify("Story Director: คำตอบของ Director ไม่ใช่ JSON ที่ถูกต้อง (ดู console)", true);
        return null;
    }
    return parsed;
}

function applyDirectorDecision(cfg, state, decision) {
    if (decision.action === "none" || !decision.detail) return null;
    const nowIso = new Date().toISOString();

    if (decision.action === "open_new") {
        if (state.activeThreads.length >= Math.max(1, cfg.maxActiveThreads)) {
            const thread = state.activeThreads[0];
            thread.beats.push({ summary: decision.detail, status: "advance", time: nowIso, diaryWritten: false });
            thread.emotionalCharge = Math.min(100, Math.max(0, thread.emotionalCharge + (decision.emotionalDelta || 10)));
            thread.status = "rising";
            return { thread, detail: decision.detail, isNew: false };
        }
        const thread = {
            id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
            title: decision.title || "เหตุการณ์ใหม่",
            status: "seed",
            originSummary: decision.detail,
            beats: [{ summary: decision.detail, status: "seed", time: nowIso, diaryWritten: false }],
            emotionalCharge: Math.max(0, decision.emotionalDelta || 20),
            diaryEntryIds: [],
        };
        state.activeThreads.push(thread);
        return { thread, detail: decision.detail, isNew: true };
    }

    const thread = state.activeThreads[(decision.threadIndex || 0) - 1];
    if (!thread) return null;

    thread.beats.push({ summary: decision.detail, status: decision.action, time: nowIso, diaryWritten: false });
    thread.emotionalCharge = Math.min(100, Math.max(0, thread.emotionalCharge + (decision.emotionalDelta || 10)));

    if (decision.action === "peak_and_close") {
        thread.status = "resolved";
        state.activeThreads = state.activeThreads.filter((t) => t.id !== thread.id);
        state.dormantThreads.push(thread);
        if (state.dormantThreads.length > MAX_DORMANT_THREADS) state.dormantThreads.splice(0, state.dormantThreads.length - MAX_DORMANT_THREADS);
    } else {
        thread.status = "rising";
    }

    return { thread, detail: decision.detail, isNew: false };
}

function checkTriggerDue(cfg, state) {
    if (cfg.frequencyMode === "interval") return state.messagesSinceCheck >= Math.max(1, cfg.intervalN || 6);
    return Math.random() * 100 < Math.min(100, Math.max(0, cfg.randomChance ?? 20));
}

// Character Diary — long, first-person, tied to whichever thread beat
// just happened. Written by its own dedicated API call.

function shouldWriteDiaryForBeat(cfg, threadResult) {
    if (!cfg.diaryEnabled || !threadResult) return false;
    const status = threadResult.thread.status;
    if (threadResult.isNew || status === "resolved") return true;
    return Math.random() * 100 < (cfg.diaryAdvanceChance ?? 50);
}

function buildDiaryPrompt(cfg, threadResult) {
    const { thread, detail } = threadResult;
    const priorBeats = thread.beats.slice(0, -1).map((b) => b.summary).join(" → ") || "(นี่คือจุดเริ่มต้นของเรื่องนี้)";
    const transcript = getRecentChatTranscript(8);
    const charName = getCharacterName();

    return `คุณคือ ${charName} กำลังเขียนไดอารี่ส่วนตัวที่ไม่มีใครอ่าน เกี่ยวกับเรื่องนี้: "${thread.title}"

ความเป็นมาของเรื่องนี้จนถึงตอนนี้: ${priorBeats}
สิ่งที่เพิ่งเกิดขึ้น: ${detail}

บทสนทนาล่าสุดเพื่อให้บริบทตรงกับความจริง:
${transcript || "(ไม่มี)"}

เขียนบันทึกไดอารี่จากมุมมองบุคคลที่หนึ่งของ ${charName} เอง โดย:
- เขียนแบบระบายความรู้สึกละเอียด ไม่ใช่สรุปเหตุการณ์สั้นๆ — ความยาว 4-8 ย่อหน้า
- โฟกัสที่ความรู้สึกภายใน ความขัดแย้งในใจ สิ่งที่พูดไม่ออกตอนอยู่ในฉากจริง ไม่ใช่แค่เล่าว่าเกิดอะไรขึ้น
- ใส่ ==ประโยคหรือวลีสำคัญ== ไว้ 1-3 จุดตลอดบันทึก เฉพาะช่วงที่อารมณ์พีคที่สุดของย่อหน้านั้น
- ห้ามหลุดจากมุมมองตัวละคร ห้ามมีคำอธิบายนอกเรื่อง
${buildGroundingBlock()}

ตอบกลับเป็น JSON เท่านั้น:
{
  "mood": "<คำเดียวบอกอารมณ์หลัก เช่น หึงหวง, สับสน, อบอุ่น, โกรธ>",
  "weatherText": "<สภาพอากาศสั้นๆ เข้ากับอารมณ์ เช่น ฝนตกหนักและลมกระโชกแรง>",
  "temperature": <ตัวเลของศาเซลเซียส>,
  "body": "<เนื้อหาไดอารี่ทั้งหมด รวม ==highlight== ในนั้น>"
}`;
}

const MOOD_COLOR_MAP = [
    { color: "#e0546a", keywords: ["โกรธ", "โมโห", "ฉุนเฉียว", "หึงหวง", "เจ็บปวด", "ผิดหวัง"] },
    { color: "#5a7a99", keywords: ["สับสน", "งุนงง", "กังวล", "วิตก", "ลังเล"] },
    { color: "#c9a24b", keywords: ["ดีใจ", "อบอุ่น", "หวัง", "รัก", "ผูกพัน"] },
    { color: "#7d8ba1", keywords: ["เศร้า", "หดหู่", "หม่นหมอง"] },
];
function getMoodColor(moodText) {
    if (!moodText) return "#8a97a8";
    for (const entry of MOOD_COLOR_MAP) if (entry.keywords.some((k) => moodText.includes(k))) return entry.color;
    return "#8a97a8";
}

function renderDiaryBody(rawBody) {
    return String(rawBody || "").split(/\n{2,}/).filter((p) => p.trim()).map((p) =>
        `<p class="sd-diary-p">${escapeHtml(p.trim()).replace(/==(.+?)==/g, '<span class="sd-diary-highlight">$1</span>')}</p>`
    ).join("");
}

async function writeDiaryForThread(cfg, state, threadResult) {
    const prompt = buildDiaryPrompt(cfg, threadResult);
    const raw = await requestSeparateGeneration(cfg, prompt, cfg.apiMaxTokensDiary || 1800);
    if (!raw) return null;
    const parsed = extractJson(raw);
    if (!parsed || !parsed.body) {
        console.warn("[Story Director] Diary call returned unparseable JSON:", raw);
        notify("Story Director: คำตอบของไดอารี่ไม่ใช่ JSON ที่ถูกต้อง (ดู console)", true);
        return null;
    }

    const entry = {
        id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
        dateIso: getInStoryDate(cfg, state),
        weatherText: parsed.weatherText || "",
        temperature: typeof parsed.temperature === "number" ? parsed.temperature : null,
        mood: parsed.mood || "",
        moodColor: getMoodColor(parsed.mood),
        body: parsed.body,
        threadId: threadResult.thread.id,
        read: false,
    };

    state.diaryLog.push(entry);
    threadResult.thread.diaryEntryIds.push(entry.id);
    const lastBeat = threadResult.thread.beats[threadResult.thread.beats.length - 1];
    if (lastBeat) lastBeat.diaryWritten = true;

    return entry;
}

// Sound + mood stickers

const SOUND_STYLES = {
    notif1: { label: "เสียงแจ้งเตือน 1 (ค่าเริ่มต้น)", file: "sounds/notif-1.mp3" },
    notif2: { label: "เสียงแจ้งเตือน 2", file: "sounds/notif-2.mp3" },
    notif3: { label: "เสียงแจ้งเตือน 3", file: "sounds/notif-3.mp3" },
    notif4: { label: "เสียงแจ้งเตือน 4", file: "sounds/notif-4.mp3" },
    notif5: { label: "เสียงแจ้งเตือน 5", file: "sounds/notif-5.mp3" },
};
const DEFAULT_SOUND_STYLE = "notif1";

const MOOD_STICKERS = [
    { file: "mood-star.png", keywords: ["ดีใจ", "สดใส", "มีความหวัง", "ตื่นเต้น", "ยินดี"] },
    { file: "mood-smiley.png", keywords: ["พอใจ", "ยิ้ม", "มีความสุข", "สบายใจ"] },
    { file: "mood-raincloud.png", keywords: ["เศร้า", "หดหู่", "หม่นหมอง", "หนักใจ", "หม่น"] },
    { file: "mood-brokenheart.png", keywords: ["เจ็บปวด", "ผิดหวัง", "ใจสลาย", "ร้าวราน", "เจ็บใจ"] },
    { file: "mood-fire.png", keywords: ["โกรธ", "โมโห", "ฉุนเฉียว", "โกรธเกรี้ยว"] },
    { file: "mood-lightning.png", keywords: ["หงุดหงิด", "ปั่นป่วน", "กระวนกระวาย", "ตื่นตระหนก"] },
    { file: "mood-question.png", keywords: ["สับสน", "งุนงง", "ไม่แน่ใจ", "มึนงง"] },
    { file: "mood-tornado.png", keywords: ["กังวล", "วิตก", "กระสับกระส่าย", "ลังเล"] },
    { file: "mood-key.png", keywords: ["ลับ", "ซ่อนเร้น", "เก็บไว้", "ไม่กล้าพูด", "เป็นความลับ"] },
    { file: "mood-feather.png", keywords: ["ปล่อยวาง", "เบาใจ"] },
    { file: "mood-stickynote.png", keywords: ["โล่งใจ", "อุ่นใจ", "สงบ", "สงบใจ"] },
    { file: "mood-pinkheart.png", keywords: ["รัก", "ผูกพัน", "คิดถึง", "หวงแหน", "หึงหวง"] },
    { file: "mood-rabbit.png", keywords: ["เอ็นดู", "ละมุน", "น่ารัก", "อ่อนโยน"] },
    { file: "mood-candle.png", keywords: ["หวัง", "ปรารถนา", "อธิษฐาน", "ใฝ่ฝัน"] },
    { file: "mood-flower.png", keywords: ["เริ่มต้นใหม่", "สดชื่น", "เบ่งบาน", "ฟื้นตัว"] },
];
function pickMoodStickerFile(moodText) {
    if (!moodText) return null;
    for (const entry of MOOD_STICKERS) if (entry.keywords.some((kw) => String(moodText).includes(kw))) return entry.file;
    return null;
}

const EXTENSION_BASE_URL = new URL(".", import.meta.url);
function resolveStickerUrl(file) { return new URL(`stickers/${file}`, EXTENSION_BASE_URL).href; }

const _soundAudioCache = {};
function playEventSound(styleKey) {
    try {
        const style = SOUND_STYLES[styleKey] || SOUND_STYLES[DEFAULT_SOUND_STYLE];
        if (!style || !style.file) return;
        let base = _soundAudioCache[styleKey];
        if (!base) {
            base = new Audio(new URL(style.file, EXTENSION_BASE_URL).href);
            base.preload = "auto";
            _soundAudioCache[styleKey] = base;
        }
        const player = base.cloneNode(true);
        player.volume = 0.6;
        const playPromise = player.play();
        if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch((e) => console.warn("[Story Director] Sound playback blocked:", e));
        }
    } catch (e) {
        console.warn("[Story Director] Sound playback failed:", e);
    }
}

// Notifications

function notify(message, isError) {
    try {
        if (typeof toastr !== "undefined") { isError ? toastr.error(message) : toastr.success(message); return; }
    } catch (e) { /* fall through */ }
    console.log(`[Story Director] ${message}`);
    const status = document.getElementById("sd-io-status");
    if (status) status.textContent = message;
}

function ensureDiaryBannerContainer() {
    let container = document.getElementById("sd-diary-banner-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "sd-diary-banner-container";
        document.body.appendChild(container);
    }
    return container;
}
function dismissDiaryBanner(banner) {
    if (!banner || banner.dataset.dismissing === "1") return;
    banner.dataset.dismissing = "1";
    banner.classList.add("sd-diary-banner-out");
    setTimeout(() => banner.remove(), 300);
}
const DIARY_BANNER_LIFESPAN_MS = 8000;
const DIARY_ICON_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 4h11a2 2 0 0 1 2 2v14l-4-2-4 2-4-2-1 .5V6a2 2 0 0 1 2-2z"/></svg>';
function showDiaryNotificationBanner(cfg, entry) {
    try {
        const container = ensureDiaryBannerContainer();
        const stickerFile = cfg.diaryStickersEnabled ? pickMoodStickerFile(entry.mood) : null;
        const iconHtml = stickerFile
            ? `<img class="sd-diary-banner-icon" src="${resolveStickerUrl(stickerFile)}" alt="">`
            : `<div class="sd-diary-banner-icon sd-diary-banner-icon-fallback">${DIARY_ICON_SVG}</div>`;
        const snippet = truncateText((entry.body || "").replace(/[=\s]+/g, " ").trim(), 70);

        const banner = document.createElement("div");
        banner.className = "sd-diary-banner";
        banner.innerHTML = `
            ${iconHtml}
            <div class="sd-diary-banner-text">
                <div class="sd-diary-banner-title">ไดอารี่เล่มใหม่ — ${escapeHtml(getCharacterName())}</div>
                <div class="sd-diary-banner-snippet">${escapeHtml(snippet)}</div>
            </div>
            <button type="button" class="sd-diary-banner-close" title="ปิด" aria-label="ปิด">×</button>`;
        banner.addEventListener("click", (e) => {
            dismissDiaryBanner(banner);
            if (!e.target.closest(".sd-diary-banner-close")) openSettingsPopup("diary");
        });
        container.appendChild(banner);
        setTimeout(() => dismissDiaryBanner(banner), DIARY_BANNER_LIFESPAN_MS);
    } catch (e) {
        console.warn("[Story Director] Diary banner failed:", e);
    }
}

// Main loop — hooked to MESSAGE_RECEIVED. After every {char} reply: consume
// whatever injection guided this reply, then (if due) ask the Director for
// the next one. No GENERATION_STARTED hook needed — runs in the background
// between turns, adding no latency to the generation the user is waiting on.

const EXTENSION_PROMPT_KEY = "story_director_injection";
function clearInjection() {
    try {
        const context = getContext();
        if (typeof context.setExtensionPrompt === "function") context.setExtensionPrompt(EXTENSION_PROMPT_KEY, "", 1, 0);
    } catch (e) { /* best effort */ }
}

async function onCharacterMessageReceived(mesId) {
    try {
        const context = getContext();
        const msg = context.chat?.[mesId];
        if (!msg || msg.is_user) return;

        const state = getChatState();
        if (typeof mesId === "number" && mesId <= state.lastProcessedMesId) return; // swipe/dup guard
        if (typeof mesId === "number") state.lastProcessedMesId = mesId;

        clearInjection();

        const settings = ensureSettings();
        if (!settings.globalEnabled) { saveChatState(); return; }
        const cfg = getChatSettings();
        if (!cfg.enabled) { saveChatState(); return; }
        if (!cfg.apiProfileId) { saveChatState(); return; }

        state.messagesSinceCheck = (state.messagesSinceCheck || 0) + 1;
        const due = state.forceNextCheck || checkTriggerDue(cfg, state);
        if (!due) { saveChatState(); return; }

        state.forceNextCheck = false;
        state.messagesSinceCheck = 0;
        saveChatState();

        const decision = await runDirectorDecision(cfg, state);
        if (!decision || decision.action === "none") return;

        const result = applyDirectorDecision(cfg, state, decision);
        if (!result) return;

        advanceStoryCalendar(cfg, state, decision.timeElapsedHint);
        state.totalFired += 1;
        logEvent(state, result.detail, decision.action);

        const injectionText = buildEventInjectionText(cfg, result.detail);
        if (typeof context.setExtensionPrompt === "function") context.setExtensionPrompt(EXTENSION_PROMPT_KEY, injectionText, 1, 0);

        if (cfg.soundEnabled) playEventSound(cfg.soundStyle);
        notify(`Story Director: ${truncateText(result.detail, 70)}`);

        if (shouldWriteDiaryForBeat(cfg, result)) {
            const entry = await writeDiaryForThread(cfg, state, result);
            if (entry && cfg.diaryBannerEnabled) showDiaryNotificationBanner(cfg, entry);
        }

        saveChatState();
        refreshOpenPopupPanels(state);
    } catch (e) {
        console.warn("[Story Director] onCharacterMessageReceived failed:", e);
    }
}

function refreshOpenPopupPanels(state) {
    const threadPanel = document.getElementById("sd-thread-panel");
    if (threadPanel) threadPanel.innerHTML = renderThreadPanel(state);
    const historyPanel = document.getElementById("sd-full-history");
    if (historyPanel) historyPanel.innerHTML = renderFullHistory(state);
    const diaryListEl = document.getElementById("sd-diary-list");
    if (diaryListEl) diaryListEl.innerHTML = renderDiaryList(state);
}

// Settings popup UI

function renderTagPicker(cfg) {
    return THEME_TAGS.map((tag) => `<span class="sd-tag ${cfg.tags.includes(tag) ? "active" : ""}" data-tag="${tag}">${tag}</span>`).join("");
}

function renderThreadPanel(state) {
    const activeHtml = state.activeThreads.length
        ? state.activeThreads.map((t) => `
            <div class="sd-thread-row">
                <div class="sd-thread-title">${escapeHtml(t.title)} <span class="sd-thread-status">[${escapeHtml(t.status)}]</span></div>
                <div class="sd-thread-bar-wrap"><div class="sd-thread-bar-fill" style="width:${t.emotionalCharge}%"></div></div>
                <div class="sd-thread-last">${escapeHtml(truncateText(t.beats[t.beats.length - 1]?.summary || t.originSummary, 90))}</div>
            </div>`).join("")
        : `<div class="sd-help">(ยังไม่มีเธรดที่ค้างอยู่ในตอนนี้)</div>`;

    const dormantHtml = state.dormantThreads.length
        ? state.dormantThreads.slice().reverse().map((t) => `<div class="sd-dormant-row">— ${escapeHtml(t.title)}</div>`).join("")
        : `<div class="sd-help">(ยังไม่มีเธรดที่ปิดไปแล้ว)</div>`;

    return `<div class="sd-thread-active">${activeHtml}</div>
        <div class="sd-subsection" style="margin-top:8px;"><h4>เธรดที่ปิดไปแล้วล่าสุด</h4>${dormantHtml}</div>`;
}

const ACTION_LABELS = { open_new: "เปิดเธรดใหม่", advance: "ดันเธรดคืบ", peak_and_close: "ถึงจุดพีค/ปิด" };
function renderFullHistory(state) {
    const log = state.eventLog;
    if (log.length === 0) return `<div class="sd-help">(ยังไม่มีประวัติ)</div>`;
    return log.slice().reverse().map((entry) => {
        let timeLabel = "";
        try { timeLabel = new Date(entry.time).toLocaleString("th-TH", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch (e) { /* ignore */ }
        return `<div class="sd-log-entry">
            <span class="sd-log-time">${escapeHtml(timeLabel)}</span>
            <span class="sd-log-kind">${escapeHtml(ACTION_LABELS[entry.action] || entry.action)}</span>
            <span class="sd-log-summary">${escapeHtml(entry.summary)}</span>
        </div>`;
    }).join("");
}

function renderDiaryList(state) {
    if (state.diaryLog.length === 0) return `<div class="sd-help">(ยังไม่มีไดอารี่ ระบบจะเขียนให้เมื่อมีเธรดคืบหน้า)</div>`;
    return state.diaryLog.slice().reverse().map((entry) => {
        const dot = entry.read ? "" : `<span class="sd-diary-unread-dot"></span>`;
        const snippet = truncateText((entry.body || "").replace(/==/g, ""), 56);
        return `<div class="sd-diary-list-row" data-entry-id="${entry.id}">
            <div class="sd-diary-list-date">${dot}${escapeHtml(formatThaiDate(entry.dateIso))}</div>
            <div class="sd-diary-list-snippet">${escapeHtml(snippet)}</div>
        </div>`;
    }).join("");
}

function renderDiaryReader(entry) {
    const weatherLine = [entry.weatherText, entry.temperature != null ? `${entry.temperature}°C` : ""].filter(Boolean).join(" / ");
    return `
        <div class="sd-diary-card">
            <div class="sd-diary-date">${escapeHtml(formatThaiDate(entry.dateIso))}</div>
            ${weatherLine ? `<div class="sd-diary-weather">${escapeHtml(weatherLine)}</div>` : ""}
            <hr class="sd-diary-rule" />
            <div class="sd-diary-body">${renderDiaryBody(entry.body)}</div>
        </div>`;
}

const SD_TAB_ORDER = ["general", "threads", "diary", "history"];
const SD_TAB_LABELS = { general: "ทั่วไป", threads: "เธรด/เหตุการณ์", diary: "ไดอารี่", history: "สถิติ/ประวัติ" };

function buildPopupHtml(cfg, state) {
    const profiles = getSavedConnectionProfiles();
    const profileOptions = [`<option value="">— เลือกโปรไฟล์ —</option>`]
        .concat(profiles.map((p) => `<option value="${escapeHtml(p.id)}" ${cfg.apiProfileId === p.id ? "selected" : ""}>${escapeHtml(p.name || p.id)}</option>`)).join("");

    const unreadCount = state.diaryLog.filter((e) => !e.read).length;

    const tabButtons = SD_TAB_ORDER.map((tab, i) => `
        <button type="button" class="sd-tab-btn ${i === 0 ? "active" : ""}" data-tab="${tab}" role="tab" aria-selected="${i === 0 ? "true" : "false"}">
            ${tab === "general" ? '<i class="fa-fw fa-solid fa-house"></i>' : ""}
            <span>${SD_TAB_LABELS[tab]}</span>
            ${tab === "diary" && unreadCount > 0 ? `<span class="sd-tab-badge" id="sd-diary-badge">${unreadCount}</span>` : ""}
        </button>`).join("");

    return `
    <div class="sd-popup">
        <div class="sd-tabbar" id="sd-tabbar" role="tablist">
            <div class="sd-tab-pill" id="sd-tab-pill"></div>
            ${tabButtons}
        </div>

        <div class="sd-tab-panel" data-tab-panel="general">
            <div class="sd-row"><label><input type="checkbox" id="sd-enabled" ${cfg.enabled ? "checked" : ""}/> เปิดใช้งานกับแชทนี้</label></div>
            <div class="sd-help">เมื่อปิดใช้งาน ระบบทั้งหมดของแชทนี้จะหยุดทำงานชั่วคราว โดยการตั้งค่าที่บันทึกไว้จะยังอยู่ครบถ้วน และสามารถเปิดกลับมาใช้งานได้ทุกเมื่อ</div>

            <div class="sd-subsection">
                <h4>API สำหรับ Director (จำเป็น)</h4>
                <div class="sd-help">เลือกช่องทางเชื่อมต่อ (Connection Profile) ที่ตั้งค่าไว้แล้วในเมนู API ของ SillyTavern เพื่อให้ Story Director ใช้งาน จำเป็นต้องเลือกก่อนจึงจะเริ่มทำงานได้ เลือกโปรไฟล์จากรายการ แล้วกดปุ่ม "ทดสอบ" เพื่อตรวจสอบว่าเชื่อมต่อได้จริง</div>
                <div class="sd-row">
                    <label>โปรไฟล์ API</label>
                    <select id="sd-api-profile">${profileOptions}</select>
                    <button type="button" class="menu_button" id="sd-api-test-btn">ทดสอบ</button>
                </div>
                <div class="sd-row">
                    <label>Token สำหรับ Director</label><input type="number" id="sd-api-max-director" min="50" max="4000" value="${cfg.apiMaxTokensDirector}"/>
                    <label>Token สำหรับไดอารี่</label><input type="number" id="sd-api-max-diary" min="100" max="4000" value="${cfg.apiMaxTokensDiary}"/>
                </div>
                <div class="sd-help">กำหนดความยาวสูงสุดที่อนุญาต (หน่วยเป็นโทเคน) ช่องแรกใช้กับการตัดสินใจของ Director ปกติไม่จำเป็นต้องปรับ ส่วนช่องที่สองใช้กับไดอารี่ หากพบว่าไดอารี่ที่เขียนออกมาถูกตัดจบกลางประโยคบ่อยๆ ให้ลองเพิ่มตัวเลขนี้ขึ้น</div>
            </div>

            <div class="sd-row" style="margin-top:10px;">
                <button type="button" class="menu_button" id="sd-force-btn">เร่งให้ Director ตัดสินใจในข้อความถัดไป</button>
            </div>
            <div class="sd-help">เมื่อกดปุ่มนี้ Director จะตัดสินใจทำอะไรบางอย่างทันทีในข้อความถัดไปของตัวละคร โดยไม่ต้องรอตามความถี่ปกติที่ตั้งไว้ กดแล้วมีผลทันที ไม่ต้องกดบันทึกก่อน</div>

            <div class="sd-row"><label><input type="checkbox" id="sd-sound-enabled" ${cfg.soundEnabled ? "checked" : ""}/> เล่นเสียงสั้นๆ เมื่อ Director ตัดสินใจดำเนินการกับเธรดใดเธรดหนึ่ง</label></div>
            <div class="sd-row">
                <label>เลือกเสียง</label>
                <select id="sd-sound-style">${Object.entries(SOUND_STYLES).map(([k, s]) => `<option value="${k}" ${cfg.soundStyle === k ? "selected" : ""}>${escapeHtml(s.label)}</option>`).join("")}</select>
                <button type="button" class="menu_button" id="sd-sound-test-btn">ลองฟังเสียง</button>
            </div>
            <div class="sd-help">เมื่อเปิดใช้งาน จะมีเสียงสั้นๆ ดังขึ้นทุกครั้งที่มีเหตุการณ์ใหม่เกิดขึ้นในเรื่อง เลือกเสียงที่ต้องการจากรายการ และกดปุ่ม "ลองฟังเสียง" เพื่อฟังตัวอย่างได้ทันทีโดยไม่ต้องกดบันทึกก่อน</div>

            <div class="sd-subsection">
                <h4>นำเข้า/ส่งออก</h4>
                <div class="sd-row sd-io-row">
                    <button type="button" class="menu_button" id="sd-export-btn">ส่งออกเป็นไฟล์ .json</button>
                    <button type="button" class="menu_button" id="sd-import-btn">นำเข้าจากไฟล์ .json</button>
                    <input type="file" id="sd-import-file" accept="application/json,.json" style="display:none" />
                </div>
                <div class="sd-help" id="sd-io-status">ใช้สำหรับบันทึกการตั้งค่าปัจจุบันของแชทนี้เป็นไฟล์ เพื่อนำไปใช้ซ้ำกับแชทหรือตัวละครอื่น หรือเก็บไว้เป็นไฟล์สำรอง ไฟล์ที่ได้จะไม่รวมโปรไฟล์ API เธรด ไดอารี่ หรือประวัติของแชทนี้ หลังนำเข้าไฟล์ต้องกดปุ่ม <b>บันทึก</b> อีกครั้งจึงจะมีผล</div>
            </div>
        </div>

        <div class="sd-tab-panel sd-hidden" data-tab-panel="threads">
            <div class="sd-row"><label>ธีมที่อนุญาต</label></div>
            <div class="sd-tags">${renderTagPicker(cfg)}</div>
            <div class="sd-help">เลือกธีมที่ต้องการให้เนื้อเรื่องดำเนินไปในแนวทางนั้นๆ เลือกได้มากกว่าหนึ่งธีม หากไม่เลือกเลย เนื้อเรื่องจะดำเนินไปอย่างอิสระตามบรรยากาศของแชทในขณะนั้น</div>

            <div class="sd-row">
                <label>ความถี่ที่ Director จะพิจารณา</label>
                <select id="sd-frequency-mode">
                    <option value="random" ${cfg.frequencyMode === "random" ? "selected" : ""}>สุ่ม % ทุกข้อความ</option>
                    <option value="interval" ${cfg.frequencyMode === "interval" ? "selected" : ""}>ทุก N ข้อความ</option>
                </select>
            </div>
            <div class="sd-row"><label>โอกาส (%)</label><input type="number" id="sd-random-chance" min="0" max="100" value="${cfg.randomChance}"/>
                <label>N ข้อความ</label><input type="number" id="sd-interval-n" min="1" max="200" value="${cfg.intervalN}"/></div>
            <div class="sd-help">กำหนดว่าจะพิจารณาสร้างเหตุการณ์บ่อยแค่ไหน เลือก "สุ่ม % ทุกข้อความ" แล้วใส่ตัวเลขในช่องโอกาส เช่นใส่ 20 หมายถึงมีโอกาส 20% ในทุกข้อความของตัวละคร หรือเลือก "ทุก N ข้อความ" แล้วใส่จำนวนข้อความในช่อง N ข้อความ เช่นใส่ 6 หมายถึงพิจารณาทุกๆ 6 ข้อความ</div>

            <div class="sd-row"><label>ความรุนแรงของเหตุการณ์</label>
                <select id="sd-event-intensity">
                    <option value="mild" ${cfg.eventIntensity === "mild" ? "selected" : ""}>เบา</option>
                    <option value="medium" ${cfg.eventIntensity === "medium" ? "selected" : ""}>ปานกลาง</option>
                    <option value="disruptive" ${cfg.eventIntensity === "disruptive" ? "selected" : ""}>รุนแรง/พลิกสถานการณ์</option>
                </select>
            </div>
            <div class="sd-help">กำหนดว่าเหตุการณ์ที่เกิดขึ้นจะส่งผลต่อเรื่องมากแค่ไหน เลือก "เบา" สำหรับการเปลี่ยนแปลงเล็กน้อยที่ไม่รบกวนฉากปัจจุบัน "ปานกลาง" สำหรับเหตุการณ์ที่มีผลชัดเจนต่อเนื้อเรื่อง หรือ "รุนแรง/พลิกสถานการณ์" สำหรับการเปลี่ยนแปลงใหญ่ที่ตัวละครไม่สามารถมองข้ามได้</div>

            <div class="sd-row"><label>รูปแบบการนำเสนอ</label>
                <select id="sd-presentation">
                    <option value="subtle" ${cfg.presentation === "subtle" ? "selected" : ""}>แนบเนียน</option>
                    <option value="narrator" ${cfg.presentation === "narrator" ? "selected" : ""}>ผู้บรรยาย/GM แทรก</option>
                    <option value="both" ${cfg.presentation === "both" ? "selected" : ""}>ให้โมเดลเลือกเอง</option>
                </select>
            </div>
            <div class="sd-help">กำหนดว่าเหตุการณ์จะถูกนำเสนออย่างไรในข้อความ เลือก "แนบเนียน" เพื่อให้กลมกลืนไปกับบทบรรยายตามปกติ "ผู้บรรยาย/GM แทรก" เพื่อให้แยกออกมาชัดเจนว่าเป็นข้อความแทรก หรือ "ให้โมเดลเลือกเอง" เพื่อให้โมเดลเลือกรูปแบบที่เหมาะกับแต่ละฉากด้วยตัวเอง</div>

            <div class="sd-row"><label>เธรดพร้อมกันสูงสุด</label><input type="number" id="sd-max-threads" min="1" max="10" value="${cfg.maxActiveThreads}"/>
                <label>จำจำนวนเธรดที่ปิดแล้ว</label><input type="number" id="sd-dormant-memory" min="1" max="30" value="${cfg.dormantMemory}"/></div>
            <div class="sd-help">"เธรดพร้อมกันสูงสุด" คือจำนวนปมเรื่องที่อนุญาตให้ดำเนินไปพร้อมกันได้ในคราวเดียว ใส่ตัวเลขมากขึ้นหากต้องการให้เรื่องมีหลายเส้นเรื่องซ้อนกัน "จำจำนวนเธรดที่ปิดแล้ว" คือจำนวนปมเรื่องที่ปิดไปแล้วที่ระบบจะจดจำไว้ เพื่อไม่ให้หยิบเรื่องเดิมที่จบไปแล้วกลับมาใช้ซ้ำ</div>

            <div class="sd-row"><label><input type="checkbox" id="sd-preview-enabled" ${cfg.promptPreviewEnabled ? "checked" : ""}/> เปิด Prompt Preview</label></div>
            <div class="sd-help">เปิดใช้งานเพื่อดูตัวอย่างข้อความที่จะส่งให้ Director พิจารณา โดยไม่เสียค่าใช้จ่ายหรือเรียก API จริง เหมาะสำหรับตรวจสอบก่อนใช้งานจริง</div>
            <div class="sd-row ${cfg.promptPreviewEnabled ? "" : "sd-hidden"}" id="sd-preview-tools">
                <button type="button" class="menu_button" id="sd-preview-director-btn">พรีวิวพรอมต์ Director</button>
            </div>
            <textarea id="sd-preview-output" class="sd-pool-textarea ${cfg.promptPreviewEnabled ? "" : "sd-hidden"}" readonly rows="6"></textarea>

            <div class="sd-subsection" style="margin-top:8px;">
                <h4>สถานะเธรดตอนนี้</h4>
                <div class="sd-help">แสดงรายการปมเรื่องที่กำลังดำเนินอยู่ในแชทนี้ และปมเรื่องที่ปิดไปแล้วล่าสุด อัปเดตอัตโนมัติเมื่อมีความคืบหน้าใหม่</div>
                <div id="sd-thread-panel">${renderThreadPanel(state)}</div>
            </div>
        </div>

        <div class="sd-tab-panel sd-hidden" data-tab-panel="diary">
            <div class="sd-row"><label><input type="checkbox" id="sd-diary-enabled" ${cfg.diaryEnabled ? "checked" : ""}/> เปิดใช้สมุดไดอารี่</label></div>
            <div class="sd-help">เมื่อเปิดใช้งาน ตัวละครจะเขียนบันทึกไดอารี่ส่วนตัวเป็นระยะๆ ตามความคืบหน้าของเนื้อเรื่อง สามารถอ่านได้จากรายการด้านล่าง</div>

            <div class="sd-row"><label>โอกาสเขียนไดอารี่ตอนเธรดแค่ขยับ (%)</label><input type="number" id="sd-diary-advance-chance" min="0" max="100" value="${cfg.diaryAdvanceChance}"/></div>
            <div class="sd-help">กำหนดโอกาส (%) ที่จะมีการเขียนไดอารี่ในกรณีที่เนื้อเรื่องเพียงแค่คืบหน้าไปทีละขั้นตามปกติ ใส่ตัวเลข 0-100 เช่นใส่ 50 หมายถึงมีโอกาสครึ่งหนึ่ง ทั้งนี้เหตุการณ์สำคัญ เช่นการเริ่มหรือจบปมเรื่องหนึ่งๆ จะมีการเขียนไดอารี่เสมอโดยไม่ขึ้นกับค่านี้</div>

            <div class="sd-row"><label><input type="checkbox" id="sd-diary-stickers-enabled" ${cfg.diaryStickersEnabled ? "checked" : ""}/> แสดงสติกเกอร์อารมณ์บนหน้าไดอารี่</label></div>
            <div class="sd-help">เมื่อเปิดใช้งาน จะมีสติกเกอร์แสดงอารมณ์ปรากฏอยู่บนหน้าไดอารี่และการแจ้งเตือน</div>

            <div class="sd-row"><label><input type="checkbox" id="sd-diary-banner-enabled" ${cfg.diaryBannerEnabled ? "checked" : ""}/> แจ้งเตือนแบบ popup เมื่อมีไดอารี่หน้าใหม่</label></div>
            <div class="sd-help">เมื่อเปิดใช้งาน จะมีข้อความแจ้งเตือนเล็กๆ ปรากฏที่มุมหน้าจอทุกครั้งที่มีไดอารี่ฉบับใหม่</div>

            <div class="sd-row"><label>วันเริ่มต้นปฏิทินในเรื่อง</label><input type="date" id="sd-calendar-start" value="${escapeHtml(cfg.calendarStartDate)}"/></div>
            <div class="sd-help">กำหนดวันที่เริ่มต้นของปฏิทินในเรื่อง เลือกวันที่ที่ต้องการ หรือเว้นว่างไว้เพื่อใช้วันที่ปัจจุบันเป็นจุดเริ่มต้นโดยอัตโนมัติ</div>

            <div class="sd-subsection" id="sd-diary-shell" style="margin-top:8px;">
                <div id="sd-diary-list-view">
                    <h4>สมุดไดอารี่ — ${escapeHtml(getCharacterName())}</h4>
                    <div id="sd-diary-list" class="sd-diary-list">${renderDiaryList(state)}</div>
                </div>
                <div id="sd-diary-reader-view" class="sd-hidden">
                    <div class="sd-diary-page-header">
                        <button type="button" id="sd-diary-back-btn" class="sd-diary-back">‹</button>
                        <div class="sd-diary-page-title">${escapeHtml(getCharacterName())}的ไดอารี่</div>
                    </div>
                    <div id="sd-diary-reader-card"></div>
                </div>
            </div>
        </div>

        <div class="sd-tab-panel sd-hidden" data-tab-panel="history">
            <div class="sd-help">แสดงสถิติโดยรวมและรายการเหตุการณ์ทั้งหมดที่เคยเกิดขึ้นในแชทนี้ เรียงจากล่าสุดไปเก่าที่สุด</div>
            <div class="sd-stat-row"><span>จำนวนเหตุการณ์ทั้งหมด</span><span>${state.totalFired}</span></div>
            <div class="sd-stat-row"><span>เธรดที่กำลังดำเนินอยู่</span><span>${state.activeThreads.length}</span></div>
            <div class="sd-stat-row"><span>เธรดที่ปิดแล้ว</span><span>${state.dormantThreads.length}</span></div>
            <div class="sd-stat-row"><span>ไดอารี่ทั้งหมด</span><span>${state.diaryLog.length}</span></div>
            <div class="sd-row" style="margin-top:8px;"><button type="button" class="menu_button" id="sd-clear-log-btn">ล้างประวัติเหตุการณ์</button></div>
            <div id="sd-full-history" class="sd-full-history">${renderFullHistory(state)}</div>
        </div>

        <div class="sd-credit">Story Director — Purryverse</div>
    </div>`;
}

function makeDraft(cfg) {
    return { ...cfg, tags: [...cfg.tags] };
}

function wireLiveCapture(draft) {
    const fieldHandler = (e) => {
        const t = e.target;
        if (!t || !t.id) return;
        switch (t.id) {
            case "sd-enabled": draft.enabled = t.checked; break;
            case "sd-api-profile": draft.apiProfileId = t.value; break;
            case "sd-api-max-director": draft.apiMaxTokensDirector = clampNum(t.value, 500, 50, 4000); break;
            case "sd-api-max-diary": draft.apiMaxTokensDiary = clampNum(t.value, 1800, 100, 4000); break;
            case "sd-sound-enabled": draft.soundEnabled = t.checked; break;
            case "sd-sound-style": draft.soundStyle = t.value; break;
            case "sd-frequency-mode": draft.frequencyMode = t.value; break;
            case "sd-random-chance": draft.randomChance = clampNum(t.value, 20, 0, 100); break;
            case "sd-interval-n": draft.intervalN = clampNum(t.value, 6, 1, 200); break;
            case "sd-event-intensity": draft.eventIntensity = t.value; break;
            case "sd-presentation": draft.presentation = t.value; break;
            case "sd-max-threads": draft.maxActiveThreads = clampNum(t.value, 3, 1, 10); break;
            case "sd-dormant-memory": draft.dormantMemory = clampNum(t.value, 6, 1, 30); break;
            case "sd-preview-enabled": {
                draft.promptPreviewEnabled = t.checked;
                document.getElementById("sd-preview-tools")?.classList.toggle("sd-hidden", !t.checked);
                document.getElementById("sd-preview-output")?.classList.toggle("sd-hidden", !t.checked);
                break;
            }
            case "sd-diary-enabled": draft.diaryEnabled = t.checked; break;
            case "sd-diary-advance-chance": draft.diaryAdvanceChance = clampNum(t.value, 50, 0, 100); break;
            case "sd-diary-stickers-enabled": draft.diaryStickersEnabled = t.checked; break;
            case "sd-diary-banner-enabled": draft.diaryBannerEnabled = t.checked; break;
            case "sd-calendar-start": draft.calendarStartDate = t.value; break;
        }
    };
    const tagClickHandler = (e) => {
        if (e.target.classList.contains("sd-tag")) {
            e.target.classList.toggle("active");
            draft.tags = Array.from(document.querySelectorAll(".sd-tag.active")).map((el) => el.dataset.tag);
        }
    };
    document.addEventListener("input", fieldHandler, true);
    document.addEventListener("change", fieldHandler, true);
    document.addEventListener("click", tagClickHandler, true);
    return () => {
        document.removeEventListener("input", fieldHandler, true);
        document.removeEventListener("change", fieldHandler, true);
        document.removeEventListener("click", tagClickHandler, true);
    };
}

function wireQuickActions(cfg, draft, state) {
    const handler = (e) => {
        const target = e.target.closest ? e.target.closest("#sd-force-btn, #sd-sound-test-btn, #sd-api-test-btn, #sd-clear-log-btn, #sd-preview-director-btn") : null;
        if (!target) return;

        if (target.id === "sd-force-btn") {
            state.forceNextCheck = true;
            saveChatState();
            notify("ตั้งค่าแล้ว: Director จะตัดสินใจทันทีหลังข้อความถัดไปของตัวละคร");
        } else if (target.id === "sd-sound-test-btn") {
            playEventSound(draft.soundStyle);
        } else if (target.id === "sd-api-test-btn") {
            if (!draft.apiProfileId) { notify("กรุณาเลือกโปรไฟล์ API ก่อน", true); return; }
            if (cfg.apiProfileId !== draft.apiProfileId) { cfg.apiProfileId = draft.apiProfileId; saveSettingsDebounced(); }
            notify("กำลังทดสอบการเชื่อมต่อ...");
            requestSeparateGeneration(cfg, "Reply with exactly one word: OK", 10).then((result) => {
                if (result) notify(`เชื่อมต่อสำเร็จ — คำตอบที่ได้: "${truncateText(result.trim(), 60)}"`);
                else notify("การเชื่อมต่อล้มเหลว ดู console (F12)", true);
            });
        } else if (target.id === "sd-clear-log-btn") {
            state.eventLog = [];
            saveChatState();
            const panel = document.getElementById("sd-full-history");
            if (panel) panel.innerHTML = renderFullHistory(state);
            notify("ล้างประวัติทั้งหมดแล้ว");
        } else if (target.id === "sd-preview-director-btn") {
            const text = buildDirectorPrompt(draft, state);
            const outEl = document.getElementById("sd-preview-output");
            if (outEl) outEl.value = text;
        }
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
}

function wireDiaryNav(state) {
    const handler = (e) => {
        const row = e.target.closest ? e.target.closest(".sd-diary-list-row") : null;
        const backBtn = e.target.closest ? e.target.closest("#sd-diary-back-btn") : null;
        if (row) {
            const entry = state.diaryLog.find((en) => en.id === row.dataset.entryId);
            if (!entry) return;
            entry.read = true;
            saveChatState();
            document.getElementById("sd-diary-badge")?.remove();
            const card = document.getElementById("sd-diary-reader-card");
            if (card) card.innerHTML = renderDiaryReader(entry);
            document.getElementById("sd-diary-list-view")?.classList.add("sd-hidden");
            document.getElementById("sd-diary-reader-view")?.classList.remove("sd-hidden");
        } else if (backBtn) {
            document.getElementById("sd-diary-reader-view")?.classList.add("sd-hidden");
            document.getElementById("sd-diary-list-view")?.classList.remove("sd-hidden");
            const listEl = document.getElementById("sd-diary-list");
            if (listEl) listEl.innerHTML = renderDiaryList(state);
        }
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
}

const EXPORT_VERSION = 1;
function exportConfigToFile(cfg) {
    const envelope = {
        __storyDirectorExport: true,
        version: EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        config: {
            enabled: cfg.enabled, tags: cfg.tags, maxActiveThreads: cfg.maxActiveThreads,
            frequencyMode: cfg.frequencyMode, intervalN: cfg.intervalN, randomChance: cfg.randomChance,
            eventIntensity: cfg.eventIntensity, presentation: cfg.presentation, dormantMemory: cfg.dormantMemory,
            soundEnabled: cfg.soundEnabled, soundStyle: cfg.soundStyle,
            diaryEnabled: cfg.diaryEnabled, diaryAdvanceChance: cfg.diaryAdvanceChance,
            diaryStickersEnabled: cfg.diaryStickersEnabled, diaryBannerEnabled: cfg.diaryBannerEnabled,
            calendarStartDate: cfg.calendarStartDate,
            apiMaxTokensDirector: cfg.apiMaxTokensDirector, apiMaxTokensDiary: cfg.apiMaxTokensDiary,
        },
    };
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `story-director-config-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function importConfigFromFile(draft, raw) {
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.__storyDirectorExport || !parsed.config) throw new Error("invalid file");
    const c = parsed.config;
    const fresh = DEFAULT_CHAT_SETTINGS();
    for (const key of Object.keys(fresh)) {
        if (key === "apiProfileId" || key === "promptPreviewEnabled") continue;
        if (c[key] !== undefined) draft[key] = c[key];
    }
    if (!Array.isArray(draft.tags)) draft.tags = [];
}

function applyConfigToDom(cfg) {
    const setChecked = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    const setValue = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    setChecked("sd-enabled", cfg.enabled);
    setValue("sd-frequency-mode", cfg.frequencyMode);
    setValue("sd-random-chance", cfg.randomChance);
    setValue("sd-interval-n", cfg.intervalN);
    setValue("sd-event-intensity", cfg.eventIntensity);
    setValue("sd-presentation", cfg.presentation);
    setValue("sd-max-threads", cfg.maxActiveThreads);
    setValue("sd-dormant-memory", cfg.dormantMemory);
    setChecked("sd-sound-enabled", cfg.soundEnabled);
    setValue("sd-sound-style", cfg.soundStyle);
    setChecked("sd-diary-enabled", cfg.diaryEnabled);
    setValue("sd-diary-advance-chance", cfg.diaryAdvanceChance);
    setChecked("sd-diary-stickers-enabled", cfg.diaryStickersEnabled);
    setChecked("sd-diary-banner-enabled", cfg.diaryBannerEnabled);
    setValue("sd-calendar-start", cfg.calendarStartDate);
    setValue("sd-api-max-director", cfg.apiMaxTokensDirector);
    setValue("sd-api-max-diary", cfg.apiMaxTokensDiary);
    document.querySelectorAll(".sd-tag").forEach((el) => el.classList.toggle("active", cfg.tags.includes(el.dataset.tag)));
}

function wireImportExport(draft) {
    const handler = (e) => {
        const target = e.target.closest ? e.target.closest("#sd-export-btn, #sd-import-btn") : null;
        if (!target) return;
        if (target.id === "sd-export-btn") exportConfigToFile(draft);
        else if (target.id === "sd-import-btn") document.getElementById("sd-import-file")?.click();
    };
    const fileHandler = async (e) => {
        if (e.target.id !== "sd-import-file") return;
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            importConfigFromFile(draft, text);
            applyConfigToDom(draft);
            notify('นำเข้าการตั้งค่าแล้ว กด "บันทึก" เพื่อยืนยัน');
        } catch (err) {
            console.warn("[Story Director] Import failed:", err);
            notify("นำเข้าไฟล์ไม่สำเร็จ ตรวจสอบว่าเป็นไฟล์ .json จาก Story Director", true);
        } finally {
            e.target.value = "";
        }
    };
    document.addEventListener("click", handler, true);
    document.addEventListener("change", fileHandler, true);
    return () => {
        document.removeEventListener("click", handler, true);
        document.removeEventListener("change", fileHandler, true);
    };
}

function markDiaryRead(state) {
    const hadUnread = state.diaryLog.some((e) => !e.read);
    if (!hadUnread) return;
    state.diaryLog.forEach((e) => { e.read = true; });
    saveChatState();
    document.getElementById("sd-diary-badge")?.remove();
    const listEl = document.getElementById("sd-diary-list");
    if (listEl) listEl.innerHTML = renderDiaryList(state);
}

function activateTab(tabName) {
    const tabbar = document.getElementById("sd-tabbar");
    if (!tabbar) return;
    const buttons = Array.from(tabbar.querySelectorAll(".sd-tab-btn"));
    const index = SD_TAB_ORDER.indexOf(tabName);
    if (index === -1) return;
    buttons.forEach((btn) => {
        const active = btn.dataset.tab === tabName;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    const pill = document.getElementById("sd-tab-pill");
    if (pill) pill.style.transform = `translateX(${index * 100}%)`;
    document.querySelectorAll(".sd-tab-panel").forEach((panel) => {
        panel.classList.toggle("sd-hidden", panel.dataset.tabPanel !== tabName);
    });
}

function wireNav(state) {
    const handleClick = (e) => {
        const btn = e.target.closest ? e.target.closest(".sd-tab-btn") : null;
        if (!btn) return;
        activateTab(btn.dataset.tab);
        if (btn.dataset.tab === "diary") markDiaryRead(state);
    };
    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
}

async function openSettingsPopup(initialTab) {
    const tabToOpen = typeof initialTab === "string" ? initialTab : null;
    const cfg = getChatSettings();
    const state = getChatState();
    const html = buildPopupHtml(cfg, state);

    const draft = makeDraft(cfg);
    const unwireFields = wireLiveCapture(draft);
    const unwireIo = wireImportExport(draft);
    const unwireActions = wireQuickActions(cfg, draft, state);
    const unwireDiaryNav = wireDiaryNav(state);
    const unwireTabs = wireNav(state);

    if (tabToOpen && tabToOpen !== SD_TAB_ORDER[0]) {
        activateTab(tabToOpen);
        if (tabToOpen === "diary") markDiaryRead(state);
    }

    try {
        const result = await callGenericPopup(html, POPUP_TYPE.CONFIRM, "", { wide: true, okButton: "บันทึก", cancelButton: "ปิด" });
        if (result) {
            Object.assign(cfg, draft);
            saveSettingsDebounced();
        }
    } finally {
        unwireFields();
        unwireIo();
        unwireActions();
        unwireDiaryNav();
        unwireTabs();
    }
}

let addWandMenuButtonAttempts = 0;
function addWandMenuButton() {
    const menu = document.getElementById("extensionsMenu");
    if (!menu) {
        addWandMenuButtonAttempts += 1;
        if (addWandMenuButtonAttempts > 40) {
            console.error("[Story Director] #extensionsMenu never appeared after 20s.");
            return;
        }
        setTimeout(addWandMenuButton, 500);
        return;
    }
    if (document.getElementById("sd-wand-button")) return;
    const item = document.createElement("div");
    item.id = "sd-wand-button";
    item.classList.add("list-group-item", "flex-container", "flexGap5", "interactable");
    item.tabIndex = 0;
    item.innerHTML = `<i class="fa-fw fa-solid fa-paw"></i><span>Story Director</span>`;
    item.addEventListener("click", () => openSettingsPopup());
    menu.insertBefore(item, menu.firstChild);
}

function addWandMenuErrorButton(missing) {
    const menu = document.getElementById("extensionsMenu");
    if (!menu) { setTimeout(() => addWandMenuErrorButton(missing), 500); return; }
    if (document.getElementById("sd-wand-button")) return;
    const item = document.createElement("div");
    item.id = "sd-wand-button";
    item.classList.add("list-group-item", "flex-container", "flexGap5", "interactable");
    item.tabIndex = 0;
    item.innerHTML = `<i class="fa-fw fa-solid fa-triangle-exclamation" style="color:#e06666;"></i><span>Story Director (โหลดไม่สำเร็จ)</span>`;
    item.addEventListener("click", () => {
        alert("Story Director โหลดไม่สำเร็จ เพราะไฟล์นี้ไม่พบ: " + missing.join(", ") +
            "\n\nตำแหน่งที่ถูกต้อง:\n.../SillyTavern/public/scripts/extensions/third-party/story-director/index.js\n\nแก้แล้วรีสตาร์ต SillyTavern แล้ว hard refresh");
    });
    menu.insertBefore(item, menu.firstChild);
}

// Init

jQuery(async () => {
    const missing = await loadCoreModules();
    if (missing.length > 0) {
        console.error("[Story Director] Could not initialize — missing: " + missing.join(", "));
        addWandMenuErrorButton(missing);
        return;
    }

    ensureSettings();
    addWandMenuButton();
    await loadOptionalModules();
    loadConnectionManagerModule();
    refreshWorldInfoCache();

    const refreshEvents = ["MESSAGE_SENT", "CHAT_CHANGED"];
    for (const name of refreshEvents) {
        if (event_types[name]) eventSource.on(event_types[name], () => refreshWorldInfoCache());
    }

    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onCharacterMessageReceived);
    } else {
        console.warn("[Story Director] MESSAGE_RECEIVED not found; extension cannot function.");
    }

    console.log("[Story Director] loaded.");
});
