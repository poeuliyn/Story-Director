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

const THEME_TAGS = ["Comedy", "Sci-Fi", "Fantasy", "Romance", "Drama", "Horror", "Thriller", "Mystery", "Action", "Slice of Life", "Supernatural", "Sports", "School/Coming-of-age", "Adventure", "Historical", "Detective", "Isekai"];

// Vibe tags — a lightweight, separate-from-genre "mood" label the Director
// assigns to each newly opened thread, used only to detect and break up
// stagnation (see buildStagnationNote). Not shown to the model as a genre
// restriction, just a way to notice "the last 3 threads were all romance".
const VIBE_TAGS = ["โรแมนติก", "ขัดแย้ง/ตึงเครียด", "อบอุ่น/สงบ", "ตลก/เบาสมอง", "ลึกลับ/ปริศนา", "ผจญภัย/แอ็กชัน", "เศร้า/สะเทือนใจ"];

const DIRECTOR_PERSONA_NOTES = {
    balanced: "สมดุล ไม่เอนเอียงไปทางใดทางหนึ่งเป็นพิเศษ ตัดสินใจตามจังหวะเรื่องล้วนๆ โดยไม่มีสีสันเฉพาะตัว",
    dramatic: "เน้นดราม่า อารมณ์เข้มข้น ความขัดแย้งภายในใจและระหว่างตัวละคร เลือกสิ่งที่เขย่าอารมณ์ผู้เล่นมากที่สุดในบรรดาตัวเลือกที่เป็นไปได้",
    comedic: "เน้นมุมตลกขบขันหรือความกวนๆ แบบเบาสมอง สถานการณ์ที่ทำให้ฉากมีชีวิตชีวาแบบสนุกสนาน ไม่จำเป็นต้องหนักหน่วงหรือจริงจังทุกครั้ง",
    slow_burn: "ค่อยเป็นค่อยไป เน้นรายละเอียดเล็กๆ และการสะสมความรู้สึกทีละนิด หลีกเลี่ยงการดันเธรดให้คืบเร็วเกินไปหรือปิดจบเร็วเกินไป",
    twist: "มองหาโอกาสพลิกความคาดหมายของผู้เล่นอยู่เสมอ ถ้าเธรดไหนดูจะไปในทางที่คาดเดาได้ง่าย ให้ลองเปลี่ยนทิศทางที่ไม่มีใครคาดคิดแทน โดยยังต้องสมเหตุสมผลกับบริบทที่ผ่านมา",
    wholesome: "เน้นความอบอุ่นและความรู้สึกเชิงบวก เลือกเหตุการณ์ที่สร้างความผูกพัน ความอุ่นใจ หรือรอยยิ้ม หลีกเลี่ยงความขัดแย้งรุนแรงหรือเหตุการณ์ที่ทำให้รู้สึกไม่ปลอดภัย",
    high_stakes: "เน้นความเสี่ยงสูงและผลกระทบที่หนักหน่วง เลือกเหตุการณ์ที่มีอะไรบางอย่างตกอยู่ในอันตรายจริงๆ (ไม่ว่าจะทางร่างกาย ความสัมพันธ์ หรือสถานะของตัวละคร) ให้ความรู้สึกว่าผลลัพธ์ของแต่ละการตัดสินใจสำคัญและย้อนกลับได้ยาก",
    enigmatic: "เน้นทิ้งปริศนาและเบาะแสที่ยังไม่มีคำตอบไว้ให้ค้างคาใจ ไม่รีบเฉลยหรือคลี่คลายอะไรง่ายๆ เลือกเหตุการณ์ที่ชวนสงสัยมากกว่าที่จะให้คำตอบชัดเจนทันที",
};

function resolveDirectorPersonaKey(cfg) {
    if (cfg.directorPersona === "random") {
        const keys = Object.keys(DIRECTOR_PERSONA_NOTES);
        return keys[Math.floor(Math.random() * keys.length)];
    }
    return DIRECTOR_PERSONA_NOTES[cfg.directorPersona] ? cfg.directorPersona : "balanced";
}
function buildPersonaNote(cfg) {
    return DIRECTOR_PERSONA_NOTES[resolveDirectorPersonaKey(cfg)] || DIRECTOR_PERSONA_NOTES.balanced;
}

const NPC_FREQUENCY_NOTES = {
    occasional: "ไม่จำเป็นต้องมี NPC ทุกครั้ง ให้มีเป็นบางโอกาสที่เข้ากับบริบทจริงๆ เท่านั้น",
    frequent: "พยายามดึง NPC เข้ามาเกี่ยวข้องในเหตุการณ์บ่อยๆ เมื่อมีโอกาสเหมาะสม เพื่อให้โลกในเรื่องรู้สึกมีชีวิต แต่ไม่ต้องฝืนถ้าบริบทไม่เข้ากันจริงๆ",
    almost_always: "เกือบทุกเหตุการณ์ควรมี NPC เข้ามาเกี่ยวข้องด้วยไม่ทางใดก็ทางหนึ่ง เว้นแต่ฉากตอนนี้จะเป็นช่วงส่วนตัวระหว่างตัวละครหลักล้วนๆ จริงๆ",
};

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
    threadCooldownN: 10,

    eventPool: [],                // [{ id, title, detail }] — user-authored thread seeds

    directorPersona: "balanced",  // 'balanced' | 'dramatic' | 'comedic' | 'slow_burn' | 'twist' | 'wholesome' | 'high_stakes' | 'enigmatic' | 'random'
    antiStagnationEnabled: true,

    npcEventsEnabled: true,
    npcFrequency: "frequent",     // 'occasional' | 'frequent' | 'almost_always'
    npcRoster: [],                 // [{ id, name, role }] — user-authored NPC suggestions for Director

    secretsEnabled: true,
    secretsPool: [],               // [{ id, characterName, text }] — text "" means Director invents the content itself

    callbackEnabled: true,
    callbackMinAge: 20,            // messages a thread/diary entry must be older than to count as "callback material"

    storyArcsEnabled: true,
    arcMinLength: 8,
    arcMaxLength: 15,

    recapEnabled: true,
    recapGapHours: 24,             // real-world hours away before an auto "previously on" recap is injected

    timeSkipEnabled: true,

    followUpEnabled: true,
    followUpChance: 50,           // percent
    followUpDelayMin: 2,
    followUpDelayMax: 5,
    followUpMaxChain: 2,

    soundEnabled: true,
    soundStyle: "notif1",

    diaryEnabled: true,
    diaryAdvanceChance: 50,
    diaryStickersEnabled: true,
    diaryBannerEnabled: true,
    diaryWeatherIconEnabled: true,
    diaryDisabledCharacters: [],
    diaryTheme: "classic",
    customStickers: [],
    customSounds: [],          // [{ id, label, dataUrl }] — user-uploaded notification sounds

    bondTrackingEnabled: true,

    calendarStartDate: "",
    specialDates: [],

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
    if (!Array.isArray(cfg.diaryDisabledCharacters)) cfg.diaryDisabledCharacters = [];
    if (!Array.isArray(cfg.specialDates)) cfg.specialDates = [];
    if (!Array.isArray(cfg.customStickers)) cfg.customStickers = [];
    if (!Array.isArray(cfg.customSounds)) cfg.customSounds = [];
    if (!Array.isArray(cfg.eventPool)) cfg.eventPool = [];
    if (!Array.isArray(cfg.npcRoster)) cfg.npcRoster = [];
    if (!Array.isArray(cfg.secretsPool)) cfg.secretsPool = [];
    return cfg;
}

// Per-chat state: threads, diary log, calendar. Stored on chatMetadata.

const MAX_EVENT_LOG = 200;
const MAX_DORMANT_THREADS = 20;
const MAX_DIARY_LOG = 300;
const MAX_BOND_HISTORY = 200;
const MAX_SCHEDULED_LETTERS = 100;
const MAX_NPC_REGISTRY = 40;
const MAX_SECRETS = 40;
const MAX_SECRET_CLUES = 30;
const MAX_ARC_HISTORY = 20;

// Keeps diaryLog from growing forever in very long-running chats. Trims oldest
// non-favorite entries first; favorites are left alone even past the cap.
function trimDiaryLog(state) {
    if (!Array.isArray(state.diaryLog) || state.diaryLog.length <= MAX_DIARY_LOG) return;
    let overflow = state.diaryLog.length - MAX_DIARY_LOG;
    for (let i = 0; i < state.diaryLog.length && overflow > 0; i++) {
        if (!state.diaryLog[i].favorite) {
            state.diaryLog.splice(i, 1);
            i--;
            overflow--;
        }
    }
}

// Keeps state.secrets from growing forever — trims oldest already-revealed
// secrets first; anything still active (unrevealed) is left alone.
function trimSecrets(state) {
    if (!Array.isArray(state.secrets) || state.secrets.length <= MAX_SECRETS) return;
    let overflow = state.secrets.length - MAX_SECRETS;
    for (let i = 0; i < state.secrets.length && overflow > 0; i++) {
        if (state.secrets[i].status === "revealed") {
            state.secrets.splice(i, 1);
            i--;
            overflow--;
        }
    }
}

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
            globalMsgIndex: 0,
            diaryFilterCharacter: null,
            diaryFilterDate: null,
            diaryFilterFavoriteOnly: false,
            diarySearchQuery: "",
            calendarViewYear: null,
            calendarViewMonth: null,
            bondValues: {},
            bondHistory: [],
            scheduledLetters: [],
            npcRegistry: [],
            npcRelationships: {},
            secrets: [],
            currentArc: null,
            arcHistory: [],
            lastRealMessageAtIso: null,
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
    if (typeof state.globalMsgIndex !== "number") state.globalMsgIndex = 0;
    if (state.diaryFilterCharacter === undefined) state.diaryFilterCharacter = null;
    if (state.diaryFilterDate === undefined) state.diaryFilterDate = null;
    if (typeof state.diaryFilterFavoriteOnly !== "boolean") state.diaryFilterFavoriteOnly = false;
    if (typeof state.diarySearchQuery !== "string") state.diarySearchQuery = "";
    if (state.calendarViewYear === undefined) state.calendarViewYear = null;
    if (state.calendarViewMonth === undefined) state.calendarViewMonth = null;
    if (!state.bondValues || typeof state.bondValues !== "object") state.bondValues = {};
    if (!Array.isArray(state.bondHistory)) state.bondHistory = [];
    if (!Array.isArray(state.scheduledLetters)) state.scheduledLetters = [];
    if (!Array.isArray(state.npcRegistry)) state.npcRegistry = [];
    if (!state.npcRelationships || typeof state.npcRelationships !== "object") state.npcRelationships = {};
    if (!Array.isArray(state.secrets)) state.secrets = [];
    if (state.currentArc !== null && typeof state.currentArc !== "object") state.currentArc = null;
    if (!Array.isArray(state.arcHistory)) state.arcHistory = [];
    if (state.lastRealMessageAtIso !== null && typeof state.lastRealMessageAtIso !== "string") state.lastRealMessageAtIso = null;
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

// Fisher-Yates-ish partial sample — used to keep the "callback" candidate
// list in the Director prompt small even when there's a lot of old material.
function pickRandomSample(arr, count) {
    const copy = arr.slice();
    const out = [];
    while (copy.length && out.length < count) {
        const i = Math.floor(Math.random() * copy.length);
        out.push(copy.splice(i, 1)[0]);
    }
    return out;
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

function getGroupMemberNames() {
    try {
        const context = getContext();
        const group = getGroupObject(context);
        if (!group) return null;
        const members = getGroupMemberCharacters(context, group);
        const names = members.map((c) => c.name).filter(Boolean);
        return names.length ? names : null;
    } catch (e) {
        return null;
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

const TIME_UNIT_LABEL_TH = { hour: "ชั่วโมง", day: "วัน", week: "สัปดาห์" };

function buildRecapBlock(state) {
    if (!state.activeThreads.length) return "";
    const lines = state.activeThreads.map((t) => `- "${t.title}": ${t.beats[t.beats.length - 1]?.summary || t.originSummary}`).join("\n");
    return ` Here is where things currently stand across the story's open threads — weave in whatever would plausibly have happened during the skipped time, naturally, not as a listed recap:\n${lines}`;
}

function buildTimeSkipInjectionText(cfg, state, result) {
    const unitLabel = TIME_UNIT_LABEL_TH[result.unit] || TIME_UNIT_LABEL_TH.day;
    return `Scene direction: time skips forward roughly ${result.amount} ${result.unit}(s) from this point. ${result.detail ? `Context for the jump: ${result.detail}. ` : ""}Narrate the passage of time naturally, then continue the scene in the new moment.${buildRecapBlock(state)} ${getStyleNote(cfg)} ${PACING_NOTE} ${ANTI_LEAK_NOTE}${buildGroundingBlock()}`;
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

function advanceStoryCalendarByAmount(cfg, state, amount, unit) {
    const cal = ensureCalendar(cfg, state);
    const days = unit === "week" ? amount * 7 : unit === "day" ? amount : 0;
    cal.daysSinceAnchor += Math.max(0, Math.round(days));
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

// Bond — a lightweight 0-100 "closeness with the player" value per character,
// nudged by the Director's bondDelta field alongside each decision. Not a
// pairwise character-to-character relationship (the extension doesn't track
// who-feels-what-about-whom between NPCs), just how each character's bond
// with the player has moved over time.
function getBondValue(state, characterName) {
    const key = characterName || getCharacterName();
    const v = state.bondValues[key];
    return typeof v === "number" ? v : 50;
}
function applyBondDelta(state, characterName, delta) {
    if (!delta) return;
    const key = characterName || getCharacterName();
    const next = Math.min(100, Math.max(0, getBondValue(state, key) + delta));
    state.bondValues[key] = next;
    state.bondHistory.push({ characterName: key, value: next, dateIso: new Date().toISOString() });
    if (state.bondHistory.length > MAX_BOND_HISTORY) state.bondHistory.splice(0, state.bondHistory.length - MAX_BOND_HISTORY);
}

// NPC registry — every name the Director has ever attached to an event
// (whether pulled from the user's roster or invented on the spot) gets kept
// here, distinct from the user-authored roster in cfg. This is what actually
// populates the NPC relationship map, since invented NPCs matter too.
function registerNpc(state, name) {
    if (!name || typeof name !== "string") return;
    const trimmed = name.trim();
    if (!trimmed) return;
    if (!Array.isArray(state.npcRegistry)) state.npcRegistry = [];
    if (!state.npcRegistry.some((n) => n.name === trimmed)) {
        state.npcRegistry.push({ name: trimmed, firstSeenIndex: state.globalMsgIndex || 0 });
        if (state.npcRegistry.length > MAX_NPC_REGISTRY) state.npcRegistry.splice(0, state.npcRegistry.length - MAX_NPC_REGISTRY);
    }
}
// Pairwise NPC-to-NPC relationship — separate from Bond (which is
// character-to-player only). Keyed by the two names sorted alphabetically.
function getNpcRelationshipValue(state, a, b) {
    if (!a || !b) return 50;
    const key = [a, b].sort().join("|");
    const rec = state.npcRelationships[key];
    return rec && typeof rec.value === "number" ? rec.value : 50;
}
function applyNpcRelationshipDelta(state, a, b, delta) {
    if (!a || !b || a === b || !delta) return;
    const key = [a, b].sort().join("|");
    if (!state.npcRelationships[key]) state.npcRelationships[key] = { value: 50, history: [] };
    const rec = state.npcRelationships[key];
    rec.value = Math.min(100, Math.max(0, rec.value + delta));
    rec.history.push({ value: rec.value, dateIso: new Date().toISOString() });
    if (rec.history.length > MAX_BOND_HISTORY) rec.history.splice(0, rec.history.length - MAX_BOND_HISTORY);
}

// Anti-stagnation — looks at the vibe tag of the most recently opened
// threads (active + dormant) and nudges the Director away from repeating
// the same one too many times in a row when opening the next new thread.
function buildStagnationNote(cfg, state) {
    if (!cfg.antiStagnationEnabled) return "";
    const combined = [...state.activeThreads, ...state.dormantThreads]
        .filter((t) => t.vibe)
        .sort((a, b) => (b.openedAtIndex || 0) - (a.openedAtIndex || 0))
        .slice(0, 5);
    if (combined.length < 3) return "";
    const counts = {};
    combined.forEach((t) => { counts[t.vibe] = (counts[t.vibe] || 0) + 1; });
    const [topVibe, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (topCount < 3) return "";
    return `\n\nสังเกต: เธรด ${topCount} จาก ${combined.length} เธรดล่าสุดใช้อารมณ์/ธีมแบบ "${topVibe}" ซ้ำกัน ถ้าตอนนี้จะเปิดเธรดใหม่ (action "open_new") ให้พยายามเลือก vibe อื่นที่ไม่ใช่ "${topVibe}" เพื่อไม่ให้เรื่องจำเจ เว้นแต่จังหวะเรื่องตอนนี้จะเข้ากับ "${topVibe}" มากจริงๆ เท่านั้น`;
}

// NPC roster block — lists user-authored suggestions plus anyone already
// seen in the story, and tells the Director how eagerly to reach for one.
function buildNpcRosterBlock(cfg, state) {
    if (!cfg.npcEventsEnabled) return "";
    const rosterLines = (cfg.npcRoster || []).map((n) => `- ${n.name}${n.role ? ` (${n.role})` : ""}`);
    const rosterNames = new Set((cfg.npcRoster || []).map((n) => n.name));
    const seenLines = (state.npcRegistry || [])
        .filter((n) => !rosterNames.has(n.name))
        .map((n) => `- ${n.name} (เคยปรากฏในเรื่องแล้ว)`);
    const allLines = [...rosterLines, ...seenLines];
    const freqNote = NPC_FREQUENCY_NOTES[cfg.npcFrequency] || NPC_FREQUENCY_NOTES.frequent;
    return `\n\nตัวละครสมทบ (NPC) ที่มีในเรื่อง:\n${allLines.length ? allLines.join("\n") : "(ยังไม่มีใครถูกตั้งชื่อไว้)"}\n${freqNote} ถ้าเหตุการณ์นี้มี NPC เกี่ยวข้อง ให้เลือกจากรายชื่อข้างต้นก่อนเป็นอันดับแรกถ้าเข้ากับบริบท ถ้าไม่มีใครเหมาะเลยจะแต่ง NPC ใหม่ขึ้นมาก็ได้ ใส่ชื่อ (ใหม่หรือเดิม) ลงในฟิลด์ "npcName" ถ้าเหตุการณ์นี้ไม่มี NPC เกี่ยวข้องเลยให้ใส่ null ถ้าเหตุการณ์นี้เกี่ยวพันกับ NPC อีกคนพร้อมกันจนกระทบความสัมพันธ์ระหว่างสองคนนั้นเอง (ไม่ใช่กับผู้เล่น) ให้ใส่ชื่อคนที่สองในฟิลด์ "npcRelationshipPartner" พร้อม "npcRelationshipDelta" ไม่งั้นใส่ null ทั้งคู่`;
}

// Future letters — user writes a note to a character now, picks an in-story
// delivery date, and it gets pushed into the prompt (so the character reads
// and reacts to it) the first time the in-story calendar reaches that date.
// Delivery is deterministic (date-based), unlike special dates which are
// just a hint the Director may or may not use.
function getDueLetters(cfg, state) {
    if (!Array.isArray(state.scheduledLetters) || !state.scheduledLetters.length) return [];
    const now = new Date(getInStoryDate(cfg, state));
    return state.scheduledLetters.filter((l) => {
        if (l.delivered) return false;
        const target = new Date(l.deliveryDateIso);
        return !isNaN(target.getTime()) && target <= now;
    });
}
function buildLetterInjectionText(letters) {
    const parts = letters.map((l) => `จดหมายจากผู้เล่นถึง ${l.toCharacter}:\n"${l.body}"`).join("\n\n");
    const names = Array.from(new Set(letters.map((l) => l.toCharacter))).join(", ");
    return `[จดหมายมาถึงพอดีในวันนี้]\n${parts}\n\nให้ ${names} เปิดอ่านจดหมายฉบับนี้และแสดงปฏิกิริยา/ตอบสนองต่อเนื้อหาข้างต้นอย่างเป็นธรรมชาติในฉากนี้`;
}
function renderScheduledLettersRows(state) {
    if (!state.scheduledLetters.length) return `<div class="sd-help" style="margin:2px 0;">(ยังไม่มีจดหมายที่ตั้งเวลาไว้)</div>`;
    return state.scheduledLetters.slice().sort((a, b) => new Date(a.deliveryDateIso) - new Date(b.deliveryDateIso)).map((l) => `<div class="sd-row" data-letter-id="${escapeHtml(l.id)}" style="justify-content:space-between; align-items:flex-start;">
        <div style="flex:1 1 auto;">
            <b>${escapeHtml(l.toCharacter)}</b> — ${escapeHtml(formatThaiDate(l.deliveryDateIso))} ${l.delivered ? '<span class="sd-help" style="display:inline;">(ส่งถึงแล้ว)</span>' : ""}
            <div class="sd-help" style="margin:2px 0 0;">${escapeHtml(truncateText(l.body, 90))}</div>
        </div>
        ${l.delivered ? "" : `<button type="button" class="sd-letter-remove-btn" data-letter-id="${escapeHtml(l.id)}" title="ยกเลิก"><i class="fa-fw fa-solid fa-xmark"></i></button>`}
    </div>`).join("");
}

// Director — decides open/advance/resolve after every {char} message.

function buildSpecialDatesBlock(cfg, state) {
    if (!Array.isArray(cfg.specialDates) || !cfg.specialDates.length) return "";
    const nowIso = getInStoryDate(cfg, state);
    const now = new Date(nowIso);
    const lines = cfg.specialDates.map((d) => {
        const target = new Date(d.date);
        if (isNaN(target.getTime())) return null;
        const diffDays = Math.round((target - now) / 86400000);
        const when = diffDays === 0 ? "คือวันนี้" : diffDays > 0 ? `อีก ${diffDays} วัน` : `ผ่านมาแล้ว ${Math.abs(diffDays)} วัน`;
        return `- "${d.label}" (${formatThaiDate(d.date)}, ${when})`;
    }).filter(Boolean);
    if (!lines.length) return "";
    return `\n\nวันสำคัญที่ผู้เล่นตั้งไว้ (อ้างอิงได้ถ้าเข้ากับจังหวะเรื่อง ไม่บังคับต้องใช้):\n${lines.join("\n")}`;
}

function buildDormantBlock(cfg, state) {
    const cutoff = (state.globalMsgIndex || 0) - Math.max(1, cfg.threadCooldownN || 10);
    const recentList = [];
    const olderList = [];
    state.dormantThreads.slice(-Math.max(1, cfg.dormantMemory || 6)).forEach((t) => {
        const line = `- "${t.title}" (ปิดไปแล้ว: ${t.beats[t.beats.length - 1]?.summary || t.originSummary})`;
        if (typeof t.closedAtIndex === "number" && t.closedAtIndex > cutoff) recentList.push(line);
        else olderList.push(line);
    });
    let text = "";
    if (recentList.length) text += `เพิ่งปิดไปไม่นาน (ห้ามเปิดเธรดใหม่ที่มีธีม/ประเด็นใกล้เคียงกับสิ่งเหล่านี้):\n${recentList.join("\n")}`;
    if (olderList.length) text += `${text ? "\n\n" : ""}ปิดไปนานแล้ว (พอเป็นความทรงจำ ไม่จำเป็นต้องเลี่ยงเข้มงวดเท่าอันบน แต่ยังไม่ควรหยิบมาเปิดซ้ำแบบเป๊ะๆ):\n${olderList.join("\n")}`;
    return text || "(ไม่มี)";
}

function buildCharacterChoiceBlock() {
    const names = getGroupMemberNames();
    if (!names || names.length < 2) return "";
    return `\n\nนี่คือแชทกลุ่ม มีตัวละคร: ${names.join(", ")}\nสำหรับเธรดที่เปิดใหม่หรือดันคืบ ให้ระบุในฟิลด์ "characterName" ว่าเรื่องนี้เน้นไปที่ตัวละครคนไหนเป็นหลัก (เลือกจากชื่อด้านบนเท่านั้น)`;
}

function buildLinkedNote(activeThreads, t) {
    if (!Array.isArray(t.linkedThreadIds) || !t.linkedThreadIds.length) return "";
    const names = t.linkedThreadIds.map((id) => activeThreads.find((x) => x.id === id)?.title).filter(Boolean);
    return names.length ? ` (เชื่อมโยงกับ: ${names.join(", ")})` : "";
}

function buildEventPoolBlock(cfg) {
    if (!Array.isArray(cfg.eventPool) || !cfg.eventPool.length) return "";
    const lines = cfg.eventPool.map((p) => `- [id: ${p.id}] "${p.title}" — ${p.detail}`).join("\n");
    return `\n\nคลังเหตุการณ์ที่ผู้เล่นเตรียมไว้ล่วงหน้า (สำคัญ: ถ้า action คือ "open_new" ให้พิจารณาเลือกจากคลังนี้ก่อนเป็นอันดับแรกเสมอ ตราบใดที่ยังมีตัวเลือกเหลืออยู่ — เลือกอันที่เข้ากับจังหวะเรื่องตอนนี้ที่สุด แล้วใส่ id ของอันนั้นใน field "poolEventId" ค่อยคิดเรื่องใหม่เองก็ต่อเมื่อไม่มีอันไหนเข้ากับบริบทจริงๆ เท่านั้น แล้วใส่ poolEventId เป็น null):\n${lines}`;
}

// Secrets — pre-authored (or Director-invented) hidden facts about a
// character/NPC, doled out as small clues over many beats until the
// Director judges the story is ready to reveal them fully.
function buildSecretsBlock(cfg, state) {
    if (!cfg.secretsEnabled) return "";
    const active = (state.secrets || []).filter((s) => s.status === "active");
    const activeLines = active.map((s) => `- [id: ${s.id}] ${s.characterName} — เนื้อหาจริง: "${s.text}" (ปล่อยเบาะแสไปแล้ว ${s.cluesGiven.length} ครั้ง)`);
    const poolLines = (cfg.secretsPool || []).map((p) => `- [id: ${p.id}] ${p.characterName}${p.text ? `: "${p.text}"` : " (ผู้เล่นยังไม่ได้เขียนเนื้อหาไว้ — ถ้าเลือกใช้ ให้คุณแต่งเนื้อหาความลับขึ้นเองใส่ใน \"secretGeneratedText\")"}`);
    if (!activeLines.length && !poolLines.length) return "";
    return `\n\nความลับของตัวละคร (Secrets):
กำลังดำเนินอยู่ (ยังไม่เฉลย — ห้ามให้ตัวละครพูดเนื้อหาจริงออกมาตรงๆ):
${activeLines.length ? activeLines.join("\n") : "(ไม่มี)"}
เตรียมไว้แต่ยังไม่เริ่ม:
${poolLines.length ? poolLines.join("\n") : "(ไม่มี)"}
กติกา: ถ้าเหตุการณ์ตานี้เหมาะจะปล่อยเบาะแสหรือเฉลยความลับที่ "กำลังดำเนินอยู่" อันใดอันหนึ่ง ให้ใส่ id ใน "secretId" พร้อมเบาะแสสั้นๆ ที่แค่ชวนสงสัยใน "secretClueSummary" (ห้ามเฉลยเนื้อหาทั้งหมดในเบาะแส) และตั้ง "secretReveal": true เฉพาะตอนสะสมเบาะแสมาพอสมควรแล้วและจังหวะเรื่องสุกงอมจริงๆ เท่านั้น (ไม่ควรรีบเฉลยเร็วเกินไป) ถ้าจะเริ่มความลับใหม่จากรายการ "เตรียมไว้" ตานี้ ให้ใส่ id ใน "secretPoolId" ถ้าตานี้ไม่เกี่ยวกับความลับเลย ใส่ null ทั้งหมด`;
}

// Callback — surfaces small, half-forgotten details from long-closed
// threads or old diary entries so the Director can casually resurface them.
function buildCallbackBlock(cfg, state) {
    if (!cfg.callbackEnabled) return "";
    const cutoff = (state.globalMsgIndex || 0) - Math.max(5, cfg.callbackMinAge || 20);
    const threadCandidates = (state.dormantThreads || [])
        .filter((t) => typeof t.closedAtIndex === "number" && t.closedAtIndex < cutoff)
        .map((t) => `- [id: thread:${t.id}] เธรดเก่า "${t.title}" — ${truncateText(t.beats[t.beats.length - 1]?.summary || t.originSummary, 140)}`);
    const diaryCandidates = (state.diaryLog || [])
        .filter((e) => typeof e.atGlobalIndex === "number" && e.atGlobalIndex < cutoff)
        .map((e) => `- [id: diary:${e.id}] ไดอารี่เก่าของ ${e.characterName} — ${truncateText(String(e.body || "").replace(/[=~_`]/g, ""), 140)}`);
    const pool = [...threadCandidates, ...diaryCandidates];
    if (!pool.length) return "";
    const sample = pool.length > 6 ? pickRandomSample(pool, 6) : pool;
    return `\n\nรายละเอียดเก่าที่พอจะหยิบมา "callback" ได้ (ผู้เล่นอาจลืมไปแล้ว เช่น ของที่เคยพูดถึงผ่านๆ หรือคำสัญญาเก่า):\n${sample.join("\n")}\nถ้าเหตุการณ์ตานี้เหมาะจะหยิบรายละเอียดเก่าอันใดอันหนึ่งกลับมาโผล่แบบไม่ทันตั้งตัว (ไม่บังคับ ใช้เฉพาะตอนเข้ากับจังหวะจริงๆ) ให้ใส่ id ของอันนั้นใน "callbackId" แล้วสอดแทรกไว้ใน "detail" ไม่งั้นใส่ callbackId เป็น null`;
}

// Story Arcs — a season-length plan (several beats, a name, a planned
// climax) so events feel like they belong to something larger than a
// one-off thread.
function buildArcBlock(cfg, state) {
    if (!cfg.storyArcsEnabled) return "";
    const arc = state.currentArc;
    if (arc && arc.status === "active") {
        return `\n\nอาร์คเรื่องปัจจุบัน: "${arc.title}" (ผ่านมาแล้ว ${arc.beatsCount || 0}/${arc.targetLength} เหตุการณ์)\nจุดไคลแมกซ์ที่วางแผนไว้: ${arc.climaxNote || "(ยังไม่ระบุรายละเอียด)"}\nพยายามให้เหตุการณ์ที่เลือกตานี้เป็นส่วนหนึ่งของอาร์คนี้ (ไม่จำเป็นต้องเป็นเธรดเดียวกันทุกครั้ง แค่ให้เข้ากับทิศทางของอาร์ค) ยิ่งใกล้ครบจำนวนเป้าหมายยิ่งควรดันเรื่องเข้าใกล้จุดไคลแมกซ์ที่วางไว้ ถ้าตานี้คือจุดจบของอาร์ค (ถึงจุดไคลแมกซ์แล้วจริงๆ) ให้ตั้ง "arcComplete": true ไม่งั้นใส่ false`;
    }
    return `\n\nยังไม่มีอาร์คเรื่องที่กำลังดำเนินอยู่ ถ้าตานี้เป็นจังหวะที่เหมาะจะเริ่มอาร์คใหม่ (เช่น เพิ่งปิดอาร์คก่อนหน้าไป หรือยังไม่เคยมีอาร์คเลย) ให้วางแผนอาร์คใหญ่คร่าวๆ ล่วงหน้า: ตั้งชื่ออาร์คใน "arcTitle", จำนวนเหตุการณ์เป้าหมายระหว่าง ${cfg.arcMinLength}-${cfg.arcMaxLength} ใน "arcTargetLength", และแนวทางจุดไคลแมกซ์ที่วางแผนไว้ใน "arcClimaxNote" ไม่บังคับต้องเริ่มทันทีตานี้ ถ้ายังไม่ถึงจังหวะให้ใส่ null ทั้งสามฟิลด์`;
}

function buildDirectorPrompt(cfg, state, forcedThread) {
    const activeThreads = state.activeThreads;
    const threadBlock = activeThreads.length
        ? activeThreads.map((t, i) => `${i + 1}. [${t.status}]${t.pinned ? " [ปักหมุด]" : ""}${t.characterName ? ` [${t.characterName}]` : ""} "${t.title}"${buildLinkedNote(activeThreads, t)} (ความเข้มข้นสะสม: ${t.emotionalCharge}/100)\n   ล่าสุด: ${t.beats[t.beats.length - 1]?.summary || t.originSummary}`).join("\n")
        : "(ยังไม่มีเธรดที่ค้างอยู่)";

    const dormantBlock = buildDormantBlock(cfg, state);

    const tagList = cfg.tags.length ? cfg.tags.join(", ") : "อิสระตามโทนเรื่องปัจจุบัน";
    const transcript = getRecentChatTranscript(12);

    const forcedIndex = forcedThread ? activeThreads.findIndex((t) => t.id === forcedThread.id) + 1 : 0;
    const forcedNote = forcedThread
        ? `\n\nสำคัญที่สุด: เธรด "${forcedThread.title}" (ลำดับที่ ${forcedIndex} ในลิสต์ด้านบน) ถึงคิว follow-up ที่ตั้งไว้แล้ว ตานี้ต้องต่อเธรดนี้เท่านั้น action ต้องเป็น "advance" และ threadIndex ต้องเป็น ${forcedIndex} เสมอ ห้ามเลือกเธรดอื่นหรือ action อื่นในตานี้`
        : "";

    const timeSkipActionLine = cfg.timeSkipEnabled ? ` | "time_skip"` : "";
    const timeSkipGuidance = cfg.timeSkipEnabled && !forcedThread
        ? `\n- ใช้ action "time_skip" เมื่อฉากปัจจุบันจบลงเป็นธรรมชาติแล้ว และการข้ามเวลาไปข้างหน้าจะทำให้เรื่องน่าติดตามกว่าการดันต่อทันที (ไม่ควรใช้บ่อย นานๆ ครั้งพอ) ถ้าเลือก action นี้ ให้ใส่ timeSkipAmount กับ timeSkipUnit ด้วย ส่วน threadIndex/title/characterName ใส่ null`
        : "";
    const timeSkipFields = cfg.timeSkipEnabled
        ? `,\n  "timeSkipAmount": <ตัวเลขจำนวน ${`{hour|day|week}`} ที่จะข้าม ใส่เฉพาะตอน action เป็น "time_skip" ไม่งั้นใส่ null>,\n  "timeSkipUnit": "hour" | "day" | "week" | null`
        : "";
    const bondFields = cfg.bondTrackingEnabled ? `,\n  "bondDelta": <ตัวเลข -10 ถึง 10 บอกว่าเหตุการณ์นี้ทำให้ความผูกพันระหว่างตัวละครที่เกี่ยวข้องกับผู้เล่นดีขึ้นหรือแย่ลงแค่ไหน ใส่ 0 ถ้าไม่กระทบ ไม่ต้องใส่ตอน action เป็น "time_skip" หรือ "none">` : "";
    const vibeField = cfg.antiStagnationEnabled ? `,\n  "vibe": "<เลือกจาก: ${VIBE_TAGS.join(" | ")} — เฉพาะตอน action เป็น "open_new", ไม่งั้นใส่ null>"` : "";
    const npcFields = cfg.npcEventsEnabled ? `,\n  "npcName": "<ชื่อ NPC ที่เกี่ยวข้องกับเหตุการณ์นี้ หรือ null ถ้าไม่มี NPC เกี่ยวข้อง>",\n  "npcRelationshipPartner": "<ชื่อ NPC อีกคน ถ้าเหตุการณ์นี้กระทบความสัมพันธ์ระหว่าง NPC สองคนนี้เอง ไม่งั้น null>",\n  "npcRelationshipDelta": <ตัวเลข -10 ถึง 10 ใช้คู่กับ npcRelationshipPartner เท่านั้น ไม่งั้น null>` : "";
    const secretsFields = cfg.secretsEnabled ? `,\n  "secretPoolId": "<id จากรายการ \"เตรียมไว้แต่ยังไม่เริ่ม\" ถ้าจะเริ่มความลับใหม่ตานี้ ไม่งั้น null>",\n  "secretGeneratedText": "<ถ้า secretPoolId ที่เลือกยังไม่มีเนื้อหา ให้แต่งเนื้อหาความลับขึ้นเองใส่ตรงนี้ ไม่งั้น null>",\n  "secretId": "<id ของความลับที่ \"กำลังดำเนินอยู่\" ถ้าตานี้จะปล่อยเบาะแสหรือเฉลย ไม่งั้น null>",\n  "secretClueSummary": "<เบาะแสสั้นๆ ที่ปล่อยตานี้ ใส่เฉพาะตอนมี secretId ไม่งั้น null>",\n  "secretReveal": <true ถ้าตานี้คือจุดเฉลยความลับทั้งหมด ไม่งั้น false>` : "";
    const callbackFields = cfg.callbackEnabled ? `,\n  "callbackId": "<id ของรายละเอียดเก่าที่หยิบมาใช้ตานี้ ถ้ามี ไม่งั้น null>"` : "";
    const arcFields = cfg.storyArcsEnabled ? `,\n  "arcTitle": "<ชื่ออาร์คใหม่ เฉพาะตอนยังไม่มีอาร์คที่ดำเนินอยู่และจะเริ่มตานี้ ไม่งั้น null>",\n  "arcTargetLength": <จำนวนเหตุการณ์เป้าหมาย ${cfg.arcMinLength}-${cfg.arcMaxLength} เฉพาะตอนตั้งอาร์คใหม่ ไม่งั้น null>,\n  "arcClimaxNote": "<แนวทางจุดไคลแมกซ์ที่วางแผนไว้คร่าวๆ เฉพาะตอนตั้งอาร์คใหม่ ไม่งั้น null>",\n  "arcComplete": <true ถ้าตานี้คือจุดจบของอาร์คปัจจุบัน (เฉพาะตอนมีอาร์คที่ดำเนินอยู่แล้ว) ไม่งั้น false>` : "";

    return `คุณคือ "Story Director" ของแชท roleplay เรื่องหนึ่ง หน้าที่ของคุณคือดูแลไม่ให้เรื่องนิ่งจนน่าเบื่อ โดยตัดสินใจแต่ละครั้งว่าจะทำอะไรกับ "เธรด" (ปมเรื่อง/ความสัมพันธ์ที่ยังค้างอยู่) ต่อไปนี้

โทนการตัดสินใจของคุณรอบนี้: ${buildPersonaNote(cfg)}

เธรดที่กำลังดำเนินอยู่:
${threadBlock}

เธรดที่ปิดไปแล้ว:
${dormantBlock}

ธีมที่อนุญาต: ${tagList}${buildCharacterChoiceBlock()}${buildSpecialDatesBlock(cfg, state)}${buildEventPoolBlock(cfg)}${buildNpcRosterBlock(cfg, state)}${buildStagnationNote(cfg, state)}${buildSecretsBlock(cfg, state)}${buildCallbackBlock(cfg, state)}${buildArcBlock(cfg, state)}

บทสนทนาล่าสุด:
${transcript || "(ไม่มี)"}

กติกาการตัดสินใจ:
- ถ้ามีเธรดค้างอยู่แล้ว ให้เอนเอียงไปทาง "ดันเธรดเดิม" มากกว่าเปิดใหม่ (สูงสุด ${cfg.maxActiveThreads} เธรดพร้อมกัน)
- เธรดที่ emotionalCharge ใกล้ 100 ควรถูกดันไปที่ peak แล้วปิด ไม่ปล่อยค้างเรื่อยๆ
- ถ้าไม่มีเธรดค้างเลย หรือทุกเธรดเพิ่งขยับไปเมื่อกี้ ให้เปิดเธรดใหม่ 1 อัน
- ห้ามเปิดเธรดที่ซ้ำ/คล้ายกับเธรดที่ปิดไปแล้วด้านบน โดยเฉพาะกลุ่ม "เพิ่งปิดไปไม่นาน"
- เธรดที่มีเครื่องหมาย [ปักหมุด] ผู้เล่นต้องการให้เน้นเป็นพิเศษ ให้เอนเอียงไปทางดันเธรดนั้นก่อนเธรดอื่นที่ไม่ได้ปักหมุด เว้นแต่จังหวะบทสนทนาล่าสุดจะไม่เหมาะสมกับเธรดนั้นจริงๆ
- เธรดที่มี "(เชื่อมโยงกับ: ...)" ต่อท้าย ถือว่าเกี่ยวพันกับเธรดที่ระบุไว้ พิจารณาความเชื่อมโยงนี้ประกอบตอนตัดสินใจว่าเหตุการณ์ในเธรดหนึ่งอาจกระทบอีกเธรดได้
- action "none" ใช้เมื่อบทสนทนาล่าสุดกำลังมีจังหวะดีอยู่แล้ว ไม่จำเป็นต้องแทรกอะไรตานี้
- ประเมิน timeElapsedHint ตามบริบทฉากปัจจุบันตามจริง อย่าข้ามเวลาพร่ำเพรื่อ${timeSkipGuidance}${forcedNote}

ตอบกลับเป็น JSON เท่านั้น ไม่มีข้อความอื่นก่อน/หลัง ตามรูปแบบนี้:
{
  "action": "open_new" | "advance" | "peak_and_close" | "none"${timeSkipActionLine},
  "threadIndex": <เลขลำดับเธรดจากลิสต์ด้านบน ถ้า action คือ advance/peak_and_close, ไม่งั้นใส่ null>,
  "title": "<ชื่อเธรดสั้นๆ ถ้าเปิดใหม่, ไม่งั้น null>",
  "poolEventId": "<id จากคลังเหตุการณ์ด้านบนถ้าเลือกใช้ตอนเปิดเธรดใหม่, ไม่งั้น null>",
  "characterName": "<ชื่อตัวละครที่เธรดนี้เน้น ถ้าเป็นแชทกลุ่มให้เลือกจากรายชื่อที่ให้ไว้ ถ้าไม่ใช่แชทกลุ่มใส่ null>",
  "detail": "<2-4 ประโยค บอกว่าเกิดอะไรขึ้นในฉากนี้ ให้ narrator เอาไปเขียนต่อ>",
  "emotionalDelta": <ตัวเลข -20 ถึง 40 ที่จะบวกเข้า emotionalCharge ของเธรดนี้>,
  "timeElapsedHint": "same_day" | "next_day" | "few_days" | "week_plus"${timeSkipFields}${bondFields}${vibeField}${npcFields}${secretsFields}${callbackFields}${arcFields}
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

async function runDirectorDecision(cfg, state, forcedThread) {
    const prompt = buildDirectorPrompt(cfg, state, forcedThread);
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

function resolveCharacterName(decision) {
    const names = getGroupMemberNames();
    if (!names) return getCharacterName();
    if (decision && decision.characterName && names.includes(decision.characterName)) return decision.characterName;
    return names[0];
}

function consumePoolEvent(cfg, poolEventId) {
    if (!poolEventId || !Array.isArray(cfg.eventPool)) return null;
    const entry = cfg.eventPool.find((p) => p.id === poolEventId);
    if (!entry) return null;
    cfg.eventPool = cfg.eventPool.filter((p) => p.id !== poolEventId);
    saveSettingsDebounced();
    return entry;
}

// Secrets — moving a user-authored (or blank, Director-invented) entry from
// the settings pool into live per-chat state, then tracking clues/reveal.
function consumeSecretPoolEntry(cfg, poolId) {
    if (!poolId || !Array.isArray(cfg.secretsPool)) return null;
    const entry = cfg.secretsPool.find((p) => p.id === poolId);
    if (!entry) return null;
    cfg.secretsPool = cfg.secretsPool.filter((p) => p.id !== poolId);
    saveSettingsDebounced();
    return entry;
}
function activateSecretFromPool(cfg, state, decision) {
    if (!decision.secretPoolId) return;
    const entry = consumeSecretPoolEntry(cfg, decision.secretPoolId);
    if (!entry) return;
    const text = (entry.text && entry.text.trim()) || (decision.secretGeneratedText && decision.secretGeneratedText.trim()) || "(ยังไม่ระบุเนื้อหา)";
    if (!Array.isArray(state.secrets)) state.secrets = [];
    state.secrets.push({
        id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
        characterName: entry.characterName || getCharacterName(),
        text,
        status: "active",
        cluesGiven: [],
        activatedAtIndex: state.globalMsgIndex || 0,
        revealedAtIndex: null,
    });
}
function applySecretProgress(state, decision) {
    if (!decision.secretId) return;
    const secret = (state.secrets || []).find((s) => s.id === decision.secretId && s.status === "active");
    if (!secret) return;
    if (decision.secretClueSummary) {
        secret.cluesGiven.push({ summary: decision.secretClueSummary, atIndex: state.globalMsgIndex || 0, dateIso: new Date().toISOString() });
        if (secret.cluesGiven.length > MAX_SECRET_CLUES) secret.cluesGiven.splice(0, secret.cluesGiven.length - MAX_SECRET_CLUES);
    }
    if (decision.secretReveal) {
        secret.status = "revealed";
        secret.revealedAtIndex = state.globalMsgIndex || 0;
    }
}
function forceRevealSecret(state, secretId) {
    const secret = (state.secrets || []).find((s) => s.id === secretId);
    if (!secret || secret.status === "revealed") return null;
    secret.status = "revealed";
    secret.revealedAtIndex = state.globalMsgIndex || 0;
    logEvent(state, `เฉลยความลับของ ${secret.characterName} ด้วยตนเอง`, "secret_reveal");
    saveChatState();
    return secret;
}

// Story Arcs — a season-length plan the Director sets up and tracks
// progress toward across many separate decisions.
function applyArcProgress(cfg, state, decision) {
    if (!state.currentArc) {
        if (decision.arcTitle) {
            const targetLength = clampNum(decision.arcTargetLength, 10, Math.max(1, cfg.arcMinLength || 8), Math.max(cfg.arcMinLength || 8, cfg.arcMaxLength || 15));
            state.currentArc = {
                id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
                title: decision.arcTitle,
                targetLength,
                climaxNote: decision.arcClimaxNote || "",
                beatsCount: 1,
                startedAtIndex: state.globalMsgIndex || 0,
                status: "active",
            };
        }
        return;
    }
    state.currentArc.beatsCount = (state.currentArc.beatsCount || 0) + 1;
    if (decision.arcComplete) {
        const finished = { ...state.currentArc, status: "completed", completedAtIndex: state.globalMsgIndex || 0 };
        if (!Array.isArray(state.arcHistory)) state.arcHistory = [];
        state.arcHistory.push(finished);
        if (state.arcHistory.length > MAX_ARC_HISTORY) state.arcHistory.splice(0, state.arcHistory.length - MAX_ARC_HISTORY);
        state.currentArc = null;
    }
}

// Auto "previously on" — fires once, the first message back after a long
// real-world absence, regardless of the Director's normal frequency gate.
// No LLM call needed: just re-uses the existing open-threads recap text.
function checkAutoRecapDue(cfg, state) {
    if (!cfg.recapEnabled || !state.activeThreads.length || !state.lastRealMessageAtIso) return false;
    const gapMs = Date.now() - new Date(state.lastRealMessageAtIso).getTime();
    if (!isFinite(gapMs)) return false;
    return gapMs > Math.max(1, cfg.recapGapHours || 24) * 3600 * 1000;
}
function buildAutoRecapInjectionText(state) {
    return `Scene direction: a long real-world gap has passed since the last message (not necessarily in-story time). Before continuing, weave in a brief, natural "previously on" recap of where the open threads currently stand — either through a character casually referencing it, or a short narrator aside — so the player is reoriented. Keep it brief and natural, don't mechanically list every thread.${buildRecapBlock(state)} ${ANTI_LEAK_NOTE}`;
}

function applyDirectorDecision(cfg, state, decision) {
    if (decision.action === "none" || (!decision.detail && decision.action !== "time_skip")) return null;
    const nowIso = new Date().toISOString();

    if (decision.action === "time_skip") {
        const amount = Math.max(1, parseInt(decision.timeSkipAmount, 10) || 1);
        const unit = ["hour", "day", "week"].includes(decision.timeSkipUnit) ? decision.timeSkipUnit : "day";
        return { timeSkip: true, amount, unit, detail: decision.detail || "" };
    }

    // NPC bookkeeping applies to every non-time-skip action alike: register
    // whoever the Director named, and nudge their relationship with a
    // partner NPC if one was given.
    if (cfg.npcEventsEnabled && decision.npcName) {
        registerNpc(state, decision.npcName);
        if (decision.npcRelationshipPartner && decision.npcRelationshipPartner !== decision.npcName) {
            registerNpc(state, decision.npcRelationshipPartner);
            applyNpcRelationshipDelta(state, decision.npcName, decision.npcRelationshipPartner, parseInt(decision.npcRelationshipDelta, 10) || 0);
        }
    }
    const noteNpcOnThread = (thread) => {
        if (!cfg.npcEventsEnabled || !decision.npcName || !thread) return;
        if (!Array.isArray(thread.npcNames)) thread.npcNames = [];
        if (!thread.npcNames.includes(decision.npcName)) thread.npcNames.push(decision.npcName);
    };

    if (decision.action === "open_new") {
        if (state.activeThreads.length >= Math.max(1, cfg.maxActiveThreads)) {
            const thread = state.activeThreads[0];
            thread.beats.push({ summary: decision.detail, status: "advance", time: nowIso, diaryWritten: false });
            thread.emotionalCharge = Math.min(100, Math.max(0, thread.emotionalCharge + (decision.emotionalDelta || 10)));
            thread.status = "rising";
            noteNpcOnThread(thread);
            return { thread, detail: decision.detail, isNew: false };
        }

        const poolEntry = consumePoolEvent(cfg, decision.poolEventId);
        const title = poolEntry ? poolEntry.title : (decision.title || "เหตุการณ์ใหม่");
        const detail = poolEntry ? poolEntry.detail : decision.detail;

        const thread = {
            id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
            title,
            status: "seed",
            characterName: resolveCharacterName(decision),
            originSummary: detail,
            beats: [{ summary: detail, status: "seed", time: nowIso, diaryWritten: false }],
            emotionalCharge: Math.max(0, decision.emotionalDelta || 20),
            diaryEntryIds: [],
            linkedThreadIds: [],
            vibe: cfg.antiStagnationEnabled && VIBE_TAGS.includes(decision.vibe) ? decision.vibe : null,
            npcNames: [],
            openedAtIndex: state.globalMsgIndex || 0,
        };
        noteNpcOnThread(thread);
        state.activeThreads.push(thread);
        return { thread, detail, isNew: true };
    }

    const thread = state.activeThreads[(decision.threadIndex || 0) - 1];
    if (!thread) return null;

    thread.beats.push({ summary: decision.detail, status: decision.action, time: nowIso, diaryWritten: false });
    thread.emotionalCharge = Math.min(100, Math.max(0, thread.emotionalCharge + (decision.emotionalDelta || 10)));
    noteNpcOnThread(thread);

    if (decision.action === "peak_and_close") {
        thread.status = "resolved";
        thread.closedAtIndex = state.globalMsgIndex || 0;
        thread.followUpDueIndex = null;
        state.activeThreads = state.activeThreads.filter((t) => t.id !== thread.id);
        state.dormantThreads.push(thread);
        if (state.dormantThreads.length > MAX_DORMANT_THREADS) state.dormantThreads.splice(0, state.dormantThreads.length - MAX_DORMANT_THREADS);
    } else {
        thread.status = "rising";
    }

    return { thread, detail: decision.detail, isNew: false };
}

function getDueFollowUpThread(state) {
    return state.activeThreads.find((t) => typeof t.followUpDueIndex === "number" && t.followUpDueIndex <= (state.globalMsgIndex || 0)) || null;
}

function maybeScheduleFollowUp(cfg, state, thread) {
    if (!cfg.followUpEnabled || !thread) return;
    if (!state.activeThreads.some((t) => t.id === thread.id)) return; // thread already closed
    const depth = thread.followUpChainDepth || 0;
    if (depth >= Math.max(0, cfg.followUpMaxChain ?? 2)) return;
    if (Math.random() * 100 >= Math.min(100, Math.max(0, cfg.followUpChance ?? 50))) return;
    const min = Math.max(1, cfg.followUpDelayMin || 2);
    const max = Math.max(min, cfg.followUpDelayMax || 5);
    const delay = min + Math.floor(Math.random() * (max - min + 1));
    thread.followUpDueIndex = (state.globalMsgIndex || 0) + delay;
    thread.followUpChainDepth = depth + 1;
}

function toggleThreadLink(state, threadIdA, threadIdB) {
    const a = state.activeThreads.find((t) => t.id === threadIdA);
    const b = state.activeThreads.find((t) => t.id === threadIdB);
    if (!a || !b) return;
    if (!Array.isArray(a.linkedThreadIds)) a.linkedThreadIds = [];
    if (!Array.isArray(b.linkedThreadIds)) b.linkedThreadIds = [];
    const linked = a.linkedThreadIds.includes(threadIdB);
    if (linked) {
        a.linkedThreadIds = a.linkedThreadIds.filter((id) => id !== threadIdB);
        b.linkedThreadIds = b.linkedThreadIds.filter((id) => id !== threadIdA);
    } else {
        a.linkedThreadIds.push(threadIdB);
        b.linkedThreadIds.push(threadIdA);
    }
    saveChatState();
}

function toggleThreadPin(state, threadId) {
    const thread = state.activeThreads.find((t) => t.id === threadId);
    if (!thread) return null;
    thread.pinned = !thread.pinned;
    saveChatState();
    return thread;
}

function forceCloseThread(state, threadId) {
    const idx = state.activeThreads.findIndex((t) => t.id === threadId);
    if (idx === -1) return null;
    const thread = state.activeThreads[idx];
    const nowIso = new Date().toISOString();
    thread.beats.push({ summary: "(ผู้ใช้สั่งปิดเธรดนี้ด้วยตนเอง)", status: "peak_and_close", time: nowIso, diaryWritten: false });
    thread.status = "resolved";
    thread.pinned = false;
    thread.closedAtIndex = state.globalMsgIndex || 0;
    thread.followUpDueIndex = null;
    state.activeThreads.splice(idx, 1);
    state.dormantThreads.push(thread);
    if (state.dormantThreads.length > MAX_DORMANT_THREADS) state.dormantThreads.splice(0, state.dormantThreads.length - MAX_DORMANT_THREADS);
    logEvent(state, `ปิดเธรด "${thread.title}" ด้วยตนเอง`, "manual_close");
    saveChatState();
    return thread;
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
    const charName = threadResult.thread.characterName || getCharacterName();

    return `คุณคือ ${charName} กำลังเขียนไดอารี่ส่วนตัวที่ไม่มีใครอ่าน เกี่ยวกับเรื่องนี้: "${thread.title}"

ความเป็นมาของเรื่องนี้จนถึงตอนนี้: ${priorBeats}
สิ่งที่เพิ่งเกิดขึ้น: ${detail}

บทสนทนาล่าสุดเพื่อให้บริบทตรงกับความจริง:
${transcript || "(ไม่มี)"}

เขียนบันทึกไดอารี่จากมุมมองบุคคลที่หนึ่งของ ${charName} เอง โดย:
- เขียนแบบระบายความรู้สึกละเอียด ไม่ใช่สรุปเหตุการณ์สั้นๆ — ความยาว 4-8 ย่อหน้า
- โฟกัสที่ความรู้สึกภายใน ความขัดแย้งในใจ สิ่งที่พูดไม่ออกตอนอยู่ในฉากจริง ไม่ใช่แค่เล่าว่าเกิดอะไรขึ้น
- มีเครื่องหมายพิเศษ 4 แบบ ใส่ได้เมื่อเข้ากับอารมณ์จริงๆ ไม่บังคับต้องใช้ทุกแบบทุกครั้ง และไม่ควรถี่เกินไป:
  - ==ข้อความ== = ความจริงที่ตัวละครเพิ่งยอมรับกับตัวเอง (จุดพีคของย่อหน้านั้น) 1-3 จุดตลอดบันทึก
  - ~~ข้อความ~~ = ความคิดที่กลั้นไว้ ไม่เคยพูดออกมา
  - __ข้อความ__ = สิ่งที่ตัดสินใจไว้อย่างแน่วแน่
  - \`\`ข้อความ\`\` = คำที่พูดออกไปทั้งที่ใจไม่ตรงกับที่พูด
- ห้ามหลุดจากมุมมองตัวละคร ห้ามมีคำอธิบายนอกเรื่อง
${buildGroundingBlock()}

ตอบกลับเป็น JSON เท่านั้น:
{
  "mood": "<คำเดียวบอกอารมณ์หลัก เช่น หึงหวง, สับสน, อบอุ่น, โกรธ>",
  "weatherText": "<สภาพอากาศสั้นๆ เข้ากับอารมณ์ เช่น ฝนตกหนักและลมกระโชกแรง>",
  "temperature": <ตัวเลของศาเซลเซียส>,
  "body": "<เนื้อหาไดอารี่ทั้งหมด รวม ==highlight==, ~~strikethrough~~, __underline__, ``facade`` ในนั้น>"
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
    return String(rawBody || "").split(/\n{2,}/).filter((p) => p.trim()).map((p) => {
        let html = escapeHtml(p.trim());
        html = html.replace(/==(.+?)==/g, '<span class="sd-diary-highlight">$1</span>');
        html = html.replace(/~~(.+?)~~/g, '<span class="sd-diary-strike">$1</span>');
        html = html.replace(/__(.+?)__/g, '<span class="sd-diary-underline">$1</span>');
        html = html.replace(/``(.+?)``/g, '<span class="sd-diary-facade">$1</span>');
        return `<p class="sd-diary-p">${html}</p>`;
    }).join("");
}

async function writeDiaryForThread(cfg, state, threadResult) {
    const charName = threadResult.thread.characterName || getCharacterName();
    if (Array.isArray(cfg.diaryDisabledCharacters) && cfg.diaryDisabledCharacters.includes(charName)) return null;

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
        characterName: charName,
        read: false,
        atGlobalIndex: state.globalMsgIndex || 0,
    };

    state.diaryLog.push(entry);
    trimDiaryLog(state);
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
function pickMoodStickerUrl(cfg, moodText) {
    if (!moodText) return null;
    if (Array.isArray(cfg.customStickers)) {
        const custom = cfg.customStickers.find((s) => s.label && String(moodText).includes(s.label));
        if (custom) return custom.dataUrl;
    }
    const file = pickMoodStickerFile(moodText);
    return file ? resolveStickerUrl(file) : null;
}

const EXTENSION_BASE_URL = new URL(".", import.meta.url);
function resolveStickerUrl(file) { return new URL(`stickers/${file}`, EXTENSION_BASE_URL).href; }

const _soundAudioCache = {};
function playEventSound(styleKey, customSounds) {
    try {
        if (typeof styleKey === "string" && styleKey.startsWith("custom:") && Array.isArray(customSounds)) {
            const id = styleKey.slice(7);
            const custom = customSounds.find((s) => s.id === id);
            if (custom && custom.dataUrl) {
                const player = new Audio(custom.dataUrl);
                player.volume = 0.6;
                const p = player.play();
                if (p && typeof p.catch === "function") p.catch((e) => console.warn("[Story Director] Sound playback blocked:", e));
                return;
            }
        }
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
        if (typeof toastr !== "undefined") {
            const opts = { closeButton: true, timeOut: isError ? 8000 : 6000, extendedTimeOut: isError ? 4000 : 3000 };
            isError ? toastr.error(message, "", opts) : toastr.success(message, "", opts);
            return;
        }
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
        const stickerUrl = cfg.diaryStickersEnabled ? pickMoodStickerUrl(cfg, entry.mood) : null;
        const iconHtml = stickerUrl
            ? `<img class="sd-diary-banner-icon" src="${stickerUrl}" alt="">`
            : `<div class="sd-diary-banner-icon sd-diary-banner-icon-fallback">${DIARY_ICON_SVG}</div>`;
        const snippet = truncateText((entry.body || "").replace(/[=~_`\s]+/g, " ").trim(), 70);

        const banner = document.createElement("div");
        banner.className = `sd-diary-banner sd-diary-theme-${cfg.diaryTheme || "classic"}`;
        banner.innerHTML = `
            ${iconHtml}
            <div class="sd-diary-banner-text">
                <div class="sd-diary-banner-title">ไดอารี่เล่มใหม่ — ${escapeHtml(entry.characterName || getCharacterName())}</div>
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
const LETTER_PROMPT_KEY = "story_director_letter_injection";
const RECAP_PROMPT_KEY = "story_director_recap_injection";
function clearInjection() {
    try {
        const context = getContext();
        if (typeof context.setExtensionPrompt === "function") {
            context.setExtensionPrompt(EXTENSION_PROMPT_KEY, "", 1, 0);
            context.setExtensionPrompt(LETTER_PROMPT_KEY, "", 1, 0);
            context.setExtensionPrompt(RECAP_PROMPT_KEY, "", 1, 0);
        }
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

        // Auto recap — real-world-gap-triggered, not Director-gated, and needs
        // no LLM call. Must run before lastRealMessageAtIso gets overwritten below.
        const recapDue = checkAutoRecapDue(cfg, state);
        state.lastRealMessageAtIso = new Date().toISOString();
        if (recapDue) {
            if (typeof context.setExtensionPrompt === "function") context.setExtensionPrompt(RECAP_PROMPT_KEY, buildAutoRecapInjectionText(state), 1, 0);
            notify(`Story Director: แทรกสรุปความเดิมตอนที่แล้วให้แล้ว (ห่างหายไปนาน)`);
        }

        // Letters are calendar-triggered, not Director-gated — check regardless of
        // whether an API profile is configured, since no LLM call is needed here.
        const dueLetters = getDueLetters(cfg, state);
        if (dueLetters.length) {
            dueLetters.forEach((l) => { l.delivered = true; l.deliveredAtIso = new Date().toISOString(); });
            const letterKey = LETTER_PROMPT_KEY;
            if (typeof context.setExtensionPrompt === "function") context.setExtensionPrompt(letterKey, buildLetterInjectionText(dueLetters), 1, 0);
            if (cfg.soundEnabled) playEventSound(cfg.soundStyle, cfg.customSounds);
            notify(`จดหมายถึง ${dueLetters[0].toCharacter} มาถึงแล้ว`);
            saveChatState();
            refreshOpenPopupPanels(state, cfg);
        }

        if (!cfg.apiProfileId) { saveChatState(); return; }

        state.messagesSinceCheck = (state.messagesSinceCheck || 0) + 1;
        state.globalMsgIndex = (state.globalMsgIndex || 0) + 1;
        const dueFollowUp = getDueFollowUpThread(state);
        const due = state.forceNextCheck || !!dueFollowUp || checkTriggerDue(cfg, state);
        if (!due) { saveChatState(); return; }

        state.forceNextCheck = false;
        state.messagesSinceCheck = 0;
        saveChatState();

        const decision = await runDirectorDecision(cfg, state, dueFollowUp);
        if (!decision) return;

        if (dueFollowUp) {
            const idx = state.activeThreads.findIndex((t) => t.id === dueFollowUp.id);
            if (idx === -1) return; // thread closed/removed before its follow-up fired
            decision.action = "advance";
            decision.threadIndex = idx + 1;
            dueFollowUp.followUpDueIndex = null;
        } else if (decision.action === "none") {
            return;
        }

        const result = applyDirectorDecision(cfg, state, decision);
        if (!result) return;

        if (result.timeSkip) {
            advanceStoryCalendarByAmount(cfg, state, result.amount, result.unit);
            state.totalFired += 1;
            logEvent(state, result.detail || `ข้ามเวลาไป ${result.amount} ${TIME_UNIT_LABEL_TH[result.unit]}`, "time_skip");

            const skipInjectionText = buildTimeSkipInjectionText(cfg, state, result);
            if (typeof context.setExtensionPrompt === "function") context.setExtensionPrompt(EXTENSION_PROMPT_KEY, skipInjectionText, 1, 0);

            if (cfg.soundEnabled) playEventSound(cfg.soundStyle, cfg.customSounds);
            notify(`Story Director: ข้ามเวลาไป ${result.amount} ${TIME_UNIT_LABEL_TH[result.unit]}`);

            saveChatState();
            refreshOpenPopupPanels(state, cfg);
            return;
        }

        advanceStoryCalendar(cfg, state, decision.timeElapsedHint);
        state.totalFired += 1;
        logEvent(state, dueFollowUp ? `[follow-up] ${result.detail}` : result.detail, decision.action);
        maybeScheduleFollowUp(cfg, state, result.thread);
        if (cfg.bondTrackingEnabled) applyBondDelta(state, result.thread?.characterName, parseInt(decision.bondDelta, 10) || 0);
        if (cfg.secretsEnabled) {
            activateSecretFromPool(cfg, state, decision);
            applySecretProgress(state, decision);
            trimSecrets(state);
        }
        if (cfg.callbackEnabled && decision.callbackId) logEvent(state, `[callback] ${truncateText(String(decision.callbackId), 60)}`, "callback");
        if (cfg.storyArcsEnabled) applyArcProgress(cfg, state, decision);

        const injectionText = buildEventInjectionText(cfg, result.detail);
        if (typeof context.setExtensionPrompt === "function") context.setExtensionPrompt(EXTENSION_PROMPT_KEY, injectionText, 1, 0);

        if (cfg.soundEnabled) playEventSound(cfg.soundStyle, cfg.customSounds);
        notify(`Story Director: ${truncateText(result.detail, 70)}`);

        if (shouldWriteDiaryForBeat(cfg, result)) {
            const entry = await writeDiaryForThread(cfg, state, result);
            if (entry && cfg.diaryBannerEnabled) showDiaryNotificationBanner(cfg, entry);
        }

        saveChatState();
        refreshOpenPopupPanels(state, cfg);
    } catch (e) {
        console.warn("[Story Director] onCharacterMessageReceived failed:", e);
    }
}

function refreshOpenPopupPanels(state, cfg) {
    const threadPanel = document.getElementById("sd-thread-panel");
    if (threadPanel) threadPanel.innerHTML = renderThreadPanel(state, cfg);
    const historyPanel = document.getElementById("sd-full-history");
    if (historyPanel) historyPanel.innerHTML = renderFullHistory(state);
    const diaryListEl = document.getElementById("sd-diary-list");
    if (diaryListEl) diaryListEl.innerHTML = renderDiaryList(state);
    if (cfg) {
        const timelineEl = document.getElementById("sd-diary-mood-timeline");
        if (timelineEl) timelineEl.innerHTML = renderMoodTimeline(state);
        const bondEl = document.getElementById("sd-bond-timeline");
        if (bondEl) bondEl.innerHTML = renderBondTimeline(state, state.diaryFilterCharacter);
        const calEl = document.getElementById("sd-diary-calendar");
        if (calEl) calEl.innerHTML = renderDiaryCalendar(cfg, state);
    }
}

// Settings popup UI

function renderTagPicker(cfg) {
    return THEME_TAGS.map((tag) => `<span class="sd-tag ${cfg.tags.includes(tag) ? "active" : ""}" data-tag="${tag}">${tag}</span>`).join("");
}

function renderThreadLinkPanel(state, thread) {
    const others = state.activeThreads.filter((t) => t.id !== thread.id);
    if (!others.length) return `<div class="sd-help" style="margin:4px 0;">(ไม่มีเธรดอื่นให้เชื่อม)</div>`;
    return others.map((o) => `<label class="sd-thread-link-row">
        <input type="checkbox" class="sd-thread-link-checkbox" data-thread-id="${escapeHtml(thread.id)}" data-other-id="${escapeHtml(o.id)}" ${Array.isArray(thread.linkedThreadIds) && thread.linkedThreadIds.includes(o.id) ? "checked" : ""}/>
        ${escapeHtml(o.title)}
    </label>`).join("");
}

function renderBondMap(state) {
    const names = getGroupMemberNames();
    if (!names || names.length < 2) {
        return `<div class="sd-help" style="margin:4px 0;">(แผนที่นี้ใช้ได้เฉพาะแชทกลุ่มที่มีตัวละครตั้งแต่ 2 คนขึ้นไป)</div>`;
    }
    const cx = 160, cy = 100, r = Math.min(80, 30 + names.length * 6);
    const nodesHtml = names.map((name, i) => {
        const angle = (2 * Math.PI * i) / names.length - Math.PI / 2;
        const x = cx + r * Math.cos(angle), y = cy + r * Math.sin(angle);
        const value = getBondValue(state, name);
        const radius = 9 + (value / 100) * 12;
        const color = value >= 70 ? "#d9739a" : value >= 40 ? "#d98e46" : "#7f8a99";
        const label = truncateText(name, 12);
        return `<g class="sd-thread-map-node" data-char-name="${escapeHtml(name)}">
            <title>${escapeHtml(name)}: ${value}/100</title>
            <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(1)}" fill="${color}" />
            <text x="${x.toFixed(1)}" y="${(y + radius + 12).toFixed(1)}" text-anchor="middle">${escapeHtml(label)}</text>
        </g>`;
    }).join("");
    return `<svg class="sd-thread-map" viewBox="0 0 320 210" xmlns="http://www.w3.org/2000/svg">${nodesHtml}</svg>
        <div class="sd-help" style="margin:2px 0 10px;">ขนาด/สีของจุดคือค่าความผูกพันของตัวละครนั้นกับผู้เล่น (ระบบยังไม่ได้ติดตามความสัมพันธ์ระหว่างตัวละครด้วยกันเองโดยตรง จึงยังไม่ใช่เส้นเชื่อมระหว่างตัวละคร)</div>`;
}

const THREAD_MAP_STATUS_COLOR = {
    seed: "var(--SmartThemeBotFontColor, #8a97a8)",
    rising: "var(--SmartThemeQuoteColor, #d98e46)",
};
function renderThreadMap(state) {
    const nodes = state.activeThreads;
    if (nodes.length < 2) {
        return `<div class="sd-help" style="margin:4px 0 10px;">(ต้องมีเธรดที่กำลังดำเนินอยู่อย่างน้อย 2 เธรด ถึงจะเห็นแผนที่การเชื่อมโยง)</div>`;
    }
    const cx = 160, cy = 108, r = Math.min(85, 30 + nodes.length * 6);
    const positions = {};
    nodes.forEach((t, i) => {
        const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
        positions[t.id] = { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
    });

    const seenLinks = new Set();
    let linksHtml = "";
    nodes.forEach((t) => {
        if (!Array.isArray(t.linkedThreadIds)) return;
        t.linkedThreadIds.forEach((otherId) => {
            if (!positions[otherId]) return;
            const key = [t.id, otherId].sort().join("|");
            if (seenLinks.has(key)) return;
            seenLinks.add(key);
            const a = positions[t.id], b = positions[otherId];
            linksHtml += `<line class="sd-thread-map-link" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" />`;
        });
    });

    const nodesHtml = nodes.map((t) => {
        const p = positions[t.id];
        const radius = 9 + (clampNum(t.emotionalCharge, 0, 0, 100) / 100) * 10;
        const color = THREAD_MAP_STATUS_COLOR[t.status] || THREAD_MAP_STATUS_COLOR.seed;
        const label = truncateText(t.title, 14);
        return `<g class="sd-thread-map-node ${t.pinned ? "sd-thread-map-node-pinned" : ""}" data-thread-id="${escapeHtml(t.id)}">
            <title>${escapeHtml(t.title)} [${escapeHtml(t.status)}]</title>
            <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${radius.toFixed(1)}" fill="${color}" />
            <text x="${p.x.toFixed(1)}" y="${(p.y + radius + 12).toFixed(1)}" text-anchor="middle">${escapeHtml(label)}</text>
        </g>`;
    }).join("");

    return `<svg class="sd-thread-map" viewBox="0 0 320 220" xmlns="http://www.w3.org/2000/svg">${linksHtml}${nodesHtml}</svg>
        <div class="sd-help" style="margin:2px 0 10px;">แตะจุดเพื่อเลื่อนไปดูเธรดนั้นด้านล่าง วงกลมใหญ่ = อารมณ์เข้มข้น เส้นเชื่อม = เธรดที่โยงกัน</div>`;
}

function renderNpcMap(cfg, state) {
    const npcs = Array.isArray(state.npcRegistry) ? state.npcRegistry : [];
    if (npcs.length < 2) {
        return `<div class="sd-help" style="margin:4px 0 10px;">(ต้องมี NPC ที่เคยปรากฏในเรื่องแล้วอย่างน้อย 2 คน ถึงจะเห็นแผนที่ความสัมพันธ์)</div>`;
    }
    const cx = 160, cy = 108, r = Math.min(85, 30 + npcs.length * 6);
    const positions = {};
    npcs.forEach((n, i) => {
        const angle = (2 * Math.PI * i) / npcs.length - Math.PI / 2;
        positions[n.name] = { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
    });

    let linksHtml = "";
    Object.keys(state.npcRelationships || {}).forEach((key) => {
        const [a, b] = key.split("|");
        if (!positions[a] || !positions[b]) return;
        const value = getNpcRelationshipValue(state, a, b);
        const cls = value >= 65 ? "sd-npc-map-link-positive" : value <= 35 ? "sd-npc-map-link-negative" : "sd-thread-map-link";
        const pa = positions[a], pb = positions[b];
        linksHtml += `<line class="${cls}" x1="${pa.x.toFixed(1)}" y1="${pa.y.toFixed(1)}" x2="${pb.x.toFixed(1)}" y2="${pb.y.toFixed(1)}" />`;
    });

    const nodesHtml = npcs.map((n) => {
        const p = positions[n.name];
        const label = truncateText(n.name, 14);
        return `<g class="sd-thread-map-node">
            <title>${escapeHtml(n.name)}</title>
            <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="9" fill="var(--SmartThemeBotFontColor, #8a97a8)" />
            <text x="${p.x.toFixed(1)}" y="${(p.y + 21).toFixed(1)}" text-anchor="middle">${escapeHtml(label)}</text>
        </g>`;
    }).join("");

    return `<svg class="sd-thread-map" viewBox="0 0 320 220" xmlns="http://www.w3.org/2000/svg">${linksHtml}${nodesHtml}</svg>
        <div class="sd-help" style="margin:2px 0 10px;">เส้นสีเขียว = ความสัมพันธ์ดี, สีแดง = ตึงเครียด, สีเทา = กลางๆ หรือยังไม่เคยเกิดเหตุการณ์ร่วมกันเลย (นับเฉพาะ NPC ที่ Director เคยพูดถึงในเหตุการณ์ ไม่ใช่ความผูกพันกับผู้เล่น)</div>`;
}

function renderArcPanel(state, cfg) {
    const arc = state.currentArc;
    if (!arc || arc.status !== "active") {
        return `<div class="sd-help" style="margin:4px 0;">(ยังไม่มีอาร์คเรื่องที่กำลังดำเนินอยู่ — Director จะเริ่มวางแผนเองเมื่อถึงจังหวะที่เหมาะสม)</div>`;
    }
    const pct = Math.min(100, Math.round(((arc.beatsCount || 0) / Math.max(1, arc.targetLength)) * 100));
    return `<div class="sd-thread-row">
        <div class="sd-thread-header">
            <div class="sd-thread-title">${escapeHtml(arc.title)} <span class="sd-thread-status">(${arc.beatsCount || 0}/${arc.targetLength} เหตุการณ์)</span></div>
        </div>
        <div class="sd-thread-bar-wrap"><div class="sd-thread-bar-fill" style="width:${pct}%"></div></div>
        <div class="sd-thread-last">จุดไคลแมกซ์ที่วางแผนไว้: ${escapeHtml(arc.climaxNote || "(ยังไม่ระบุรายละเอียด)")}</div>
    </div>`;
}

function renderSecretsPanel(state) {
    const active = (state.secrets || []).filter((s) => s.status === "active");
    if (!active.length) {
        return `<div class="sd-help" style="margin:4px 0;">(ยังไม่มีความลับที่กำลังดำเนินอยู่)</div>`;
    }
    return active.map((s) => `<div class="sd-thread-row" data-secret-id="${escapeHtml(s.id)}">
        <div class="sd-thread-header">
            <div class="sd-thread-title">${escapeHtml(s.characterName)} <span class="sd-thread-status">(ปล่อยเบาะแสไปแล้ว ${s.cluesGiven.length} ครั้ง)</span></div>
            <div class="sd-thread-actions">
                <button type="button" class="sd-secret-reveal-btn" data-secret-id="${escapeHtml(s.id)}" title="เฉลยความลับนี้ทันที"><i class="fa-fw fa-solid fa-eye"></i></button>
            </div>
        </div>
        ${s.cluesGiven.length ? `<div class="sd-thread-last">เบาะแสล่าสุด: ${escapeHtml(truncateText(s.cluesGiven[s.cluesGiven.length - 1].summary, 90))}</div>` : ""}
    </div>`).join("");
}

function renderThreadPanel(state, cfg) {
    const activeCfg = cfg || getChatSettings();
    const groupNamesForBadge = getGroupMemberNames();
    const showCharBadge = !!(groupNamesForBadge && groupNamesForBadge.length > 1);
    const showLinkBtn = state.activeThreads.length > 1;
    const activeHtml = state.activeThreads.length
        ? state.activeThreads.map((t) => `
            <div class="sd-thread-row ${t.pinned ? "sd-thread-pinned" : ""}" data-thread-id="${escapeHtml(t.id)}">
                <div class="sd-thread-header">
                    <div class="sd-thread-title">${escapeHtml(t.title)} <span class="sd-thread-status">[${escapeHtml(t.status)}]</span>${showCharBadge && t.characterName ? ` <span class="sd-thread-char-badge">${escapeHtml(t.characterName)}</span>` : ""}${Array.isArray(t.linkedThreadIds) && t.linkedThreadIds.length ? ` <span class="sd-thread-link-badge" title="เชื่อมกับ ${t.linkedThreadIds.length} เธรด"><i class="fa-fw fa-solid fa-link"></i> ${t.linkedThreadIds.length}</span>` : ""}${typeof t.followUpDueIndex === "number" ? ` <span class="sd-thread-followup-badge" title="มี follow-up รอคิวอยู่"><i class="fa-fw fa-solid fa-clock"></i></span>` : ""}</div>
                    <div class="sd-thread-actions">
                        ${showLinkBtn ? `<button type="button" class="sd-thread-link-btn" data-thread-id="${escapeHtml(t.id)}" title="เชื่อมโยงกับเธรดอื่น"><i class="fa-fw fa-solid fa-link"></i></button>` : ""}
                        <button type="button" class="sd-thread-pin-btn ${t.pinned ? "active" : ""}" data-thread-id="${escapeHtml(t.id)}" title="ปักหมุดให้ Director เน้นเธรดนี้ก่อน">
                            <i class="fa-fw fa-solid fa-thumbtack"></i>
                        </button>
                        <button type="button" class="sd-thread-close-btn" data-thread-id="${escapeHtml(t.id)}" title="ปิดเธรดนี้ทันที">
                            <i class="fa-fw fa-solid fa-flag-checkered"></i>
                        </button>
                    </div>
                </div>
                <div class="sd-thread-bar-wrap"><div class="sd-thread-bar-fill" style="width:${t.emotionalCharge}%"></div></div>
                <div class="sd-thread-last">${escapeHtml(truncateText(t.beats[t.beats.length - 1]?.summary || t.originSummary, 90))}</div>
                ${showLinkBtn ? `<div class="sd-thread-link-panel sd-hidden" id="sd-thread-link-panel-${escapeHtml(t.id)}">${renderThreadLinkPanel(state, t)}</div>` : ""}
            </div>`).join("")
        : `<div class="sd-help">(ยังไม่มีเธรดที่ค้างอยู่ในตอนนี้)</div>`;

    const dormantHtml = state.dormantThreads.length
        ? state.dormantThreads.slice().reverse().map((t) => `<div class="sd-dormant-row">— ${escapeHtml(t.title)}</div>`).join("")
        : `<div class="sd-help">(ยังไม่มีเธรดที่ปิดไปแล้ว)</div>`;

    return `${activeCfg.storyArcsEnabled ? `<div class="sd-subsection" style="margin-top:0;">
            <h4 style="margin-top:0;">อาร์คเรื่องปัจจุบัน</h4>
            <div id="sd-arc-panel">${renderArcPanel(state, activeCfg)}</div>
        </div>` : ""}
        <div class="sd-thread-map-wrap">${renderThreadMap(state)}</div>
        <div class="sd-thread-active">${activeHtml}</div>
        <div class="sd-subsection" style="margin-top:8px;"><h4>เธรดที่ปิดไปแล้วล่าสุด</h4>${dormantHtml}</div>
        ${activeCfg.secretsEnabled ? `<div class="sd-subsection" style="margin-top:8px;">
            <h4>ความลับที่กำลังดำเนินอยู่</h4>
            <div id="sd-secrets-panel">${renderSecretsPanel(state)}</div>
        </div>` : ""}
        ${activeCfg.bondTrackingEnabled ? `<div class="sd-subsection" style="margin-top:8px;">
            <h4>ความผูกพันของตัวละคร</h4>
            <div id="sd-bond-map-wrap">${renderBondMap(state)}</div>
        </div>` : ""}
        ${activeCfg.npcEventsEnabled ? `<div class="sd-subsection" style="margin-top:8px;">
            <h4>ความสัมพันธ์ระหว่าง NPC</h4>
            <div id="sd-npc-map-wrap">${renderNpcMap(activeCfg, state)}</div>
        </div>` : ""}`;
}

const ACTION_LABELS = { open_new: "เปิดเธรดใหม่", advance: "ดันเธรดคืบ", peak_and_close: "ถึงจุดพีค/ปิด", manual_close: "ปิดเธรดด้วยตนเอง", time_skip: "ข้ามเวลา" };
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

function getCharacterFilteredEntries(state) {
    if (!state.diaryFilterCharacter) return state.diaryLog;
    return state.diaryLog.filter((e) => e.characterName === state.diaryFilterCharacter);
}

function getFilteredDiaryEntries(state) {
    let list = getCharacterFilteredEntries(state);
    if (state.diaryFilterDate) list = list.filter((e) => (e.dateIso || "").slice(0, 10) === state.diaryFilterDate);
    if (state.diaryFilterFavoriteOnly) list = list.filter((e) => e.favorite);
    if (state.diarySearchQuery) {
        const q = state.diarySearchQuery.trim().toLowerCase();
        if (q) list = list.filter((e) => (e.body || "").toLowerCase().includes(q));
    }
    return list;
}

function toggleDiaryFavorite(state, entryId) {
    const entry = state.diaryLog.find((e) => e.id === entryId);
    if (!entry) return null;
    entry.favorite = !entry.favorite;
    saveChatState();
    return entry;
}

function getDiaryDisplayOrder(state) {
    return getFilteredDiaryEntries(state).slice().reverse();
}

// Cheap memoization: recompute only when the diaryLog array (or its length) changes,
// so switching filters/tabs repeatedly doesn't re-walk the whole log every render.
let _diaryCharNamesCache = { logRef: null, length: -1, names: [] };
function getDiaryCharacterNames(state) {
    const log = state.diaryLog;
    if (_diaryCharNamesCache.logRef === log && _diaryCharNamesCache.length === log.length) {
        return _diaryCharNamesCache.names;
    }
    const set = new Set();
    log.forEach((e) => { if (e.characterName) set.add(e.characterName); });
    const names = Array.from(set);
    _diaryCharNamesCache = { logRef: log, length: log.length, names };
    return names;
}

function renderDiaryCharacterFilter(state) {
    const chars = getDiaryCharacterNames(state);
    if (chars.length < 2) return "";
    const options = [`<option value="">— ทุกตัวละคร —</option>`]
        .concat(chars.map((c) => `<option value="${escapeHtml(c)}" ${state.diaryFilterCharacter === c ? "selected" : ""}>${escapeHtml(c)}</option>`)).join("");
    return `<select id="sd-diary-char-filter">${options}</select>`;
}

function renderMoodTimeline(state) {
    const entries = getFilteredDiaryEntries(state).slice().sort((a, b) => new Date(a.dateIso) - new Date(b.dateIso));
    if (!entries.length) return `<div class="sd-help" style="margin:0;">(ยังไม่มีข้อมูลอารมณ์)</div>`;
    const dots = entries.map((e) => `<span class="sd-mood-dot" data-entry-id="${e.id}" title="${escapeHtml(formatThaiDate(e.dateIso))} — ${escapeHtml(e.mood || "ไม่ระบุ")}" style="background:${e.moodColor || "#8a97a8"}"></span>`).join("");
    return `<div class="sd-mood-timeline">${dots}</div>`;
}

function renderBondTimeline(state, characterName) {
    const key = characterName || getCharacterName();
    const points = state.bondHistory.filter((h) => h.characterName === key).slice(-30);
    const current = getBondValue(state, key);
    if (points.length < 2) {
        return `<div class="sd-help" style="margin:2px 0;">ค่าความผูกพันของ ${escapeHtml(key)} ตอนนี้: ${current}/100 (ยังมีข้อมูลไม่พอสำหรับกราฟ)</div>`;
    }
    const w = 300, h = 70, pad = 6;
    const stepX = (w - pad * 2) / (points.length - 1);
    const toY = (v) => h - pad - (v / 100) * (h - pad * 2);
    const path = points.map((p, i) => `${(pad + i * stepX).toFixed(1)},${toY(p.value).toFixed(1)}`).join(" ");
    const dots = points.map((p, i) => `<circle cx="${(pad + i * stepX).toFixed(1)}" cy="${toY(p.value).toFixed(1)}" r="2.5"><title>${escapeHtml(formatThaiDate(p.dateIso))}: ${p.value}/100</title></circle>`).join("");
    return `<div class="sd-help" style="margin:2px 0;">ค่าความผูกพันของ ${escapeHtml(key)} ตอนนี้: ${current}/100</div>
        <svg class="sd-bond-chart" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
            <polyline points="${path}" fill="none" stroke="var(--SmartThemeQuoteColor, #d98e46)" stroke-width="2" />
            ${dots}
        </svg>`;
}

function getCalendarViewDate(cfg, state) {
    if (typeof state.calendarViewYear === "number" && typeof state.calendarViewMonth === "number") {
        return new Date(state.calendarViewYear, state.calendarViewMonth, 1);
    }
    const d = new Date(getInStoryDate(cfg, state));
    return new Date(d.getFullYear(), d.getMonth(), 1);
}

const THAI_WEEKDAY_SHORT = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
function renderDiaryCalendar(cfg, state) {
    const viewDate = getCalendarViewDate(cfg, state);
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const firstDow = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const entryDatesMap = {};
    getCharacterFilteredEntries(state).forEach((e) => {
        const d = new Date(e.dateIso);
        if (d.getFullYear() === year && d.getMonth() === month) entryDatesMap[d.getDate()] = (entryDatesMap[d.getDate()] || 0) + 1;
    });

    let cells = THAI_WEEKDAY_SHORT.map((w) => `<div class="sd-cal-cell sd-cal-weekday">${w}</div>`).join("");
    for (let i = 0; i < firstDow; i++) cells += `<div class="sd-cal-cell sd-cal-empty"></div>`;
    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const hasEntry = !!entryDatesMap[day];
        const isSelected = state.diaryFilterDate === dateStr;
        cells += `<div class="sd-cal-cell ${hasEntry ? "sd-cal-has-entry" : ""} ${isSelected ? "sd-cal-selected" : ""}" data-cal-date="${dateStr}">${day}${hasEntry ? '<span class="sd-cal-dot"></span>' : ""}</div>`;
    }

    return `<div class="sd-calendar-header">
            <button type="button" class="sd-cal-nav" id="sd-cal-prev" title="เดือนก่อนหน้า"><i class="fa-fw fa-solid fa-chevron-left"></i></button>
            <span class="sd-calendar-title">${THAI_MONTHS[month]} ${year}</span>
            <button type="button" class="sd-cal-nav" id="sd-cal-next" title="เดือนถัดไป"><i class="fa-fw fa-solid fa-chevron-right"></i></button>
        </div>
        <div class="sd-calendar-grid">${cells}</div>`;
}

function refreshDiaryDynamicPanels(cfg, state) {
    const listEl = document.getElementById("sd-diary-list");
    if (listEl) listEl.innerHTML = renderDiaryList(state);
    const timelineEl = document.getElementById("sd-diary-mood-timeline");
    if (timelineEl) timelineEl.innerHTML = renderMoodTimeline(state);
    const bondEl = document.getElementById("sd-bond-timeline");
    if (bondEl) bondEl.innerHTML = renderBondTimeline(state, state.diaryFilterCharacter);
    const calEl = document.getElementById("sd-diary-calendar");
    if (calEl) calEl.innerHTML = renderDiaryCalendar(cfg, state);
}

function renderDiaryCharacterToggles(cfg) {
    const names = getGroupMemberNames();
    if (!names || names.length < 2) return "";
    const rows = names.map((n) => `<label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" class="sd-diary-char-toggle" data-char-name="${escapeHtml(n)}" ${cfg.diaryDisabledCharacters.includes(n) ? "" : "checked"}/> ${escapeHtml(n)}</label>`).join("");
    return `<div class="sd-subsection" style="margin-top:8px;">
        <h4 style="margin-top:0;">เขียนไดอารี่ให้ตัวละครไหนบ้าง</h4>
        <div class="sd-help">ปิดได้เป็นรายตัว ระบบจะไม่เรียก API เขียนไดอารี่ให้ตัวละครที่ปิดไว้ (ประหยัด token)</div>
        <div style="display:flex; flex-wrap:wrap; gap:10px;">${rows}</div>
    </div>`;
}

function renderEventPoolRows(pool) {
    if (!pool.length) return `<div class="sd-help" style="margin:2px 0;">(ยังไม่มีเหตุการณ์ในคลัง)</div>`;
    return pool.map((p) => `<div class="sd-row" data-pool-id="${escapeHtml(p.id)}" style="justify-content:space-between; align-items:flex-start;">
        <div style="flex:1 1 auto;"><b>${escapeHtml(p.title)}</b><div class="sd-help" style="margin:2px 0 0;">${escapeHtml(truncateText(p.detail, 90))}</div></div>
        <button type="button" class="sd-pool-remove-btn" data-pool-id="${escapeHtml(p.id)}" title="ลบ"><i class="fa-fw fa-solid fa-xmark"></i></button>
    </div>`).join("");
}

function renderNpcRosterRows(roster) {
    if (!roster.length) return `<div class="sd-help" style="margin:2px 0;">(ยังไม่มี NPC ในทำเนียบ — ไม่บังคับต้องเพิ่ม Director แต่ NPC ใหม่ได้เองเมื่อเข้ากับบริบท)</div>`;
    return roster.map((n) => `<div class="sd-row" data-npc-id="${escapeHtml(n.id)}" style="justify-content:space-between; align-items:flex-start;">
        <div style="flex:1 1 auto;"><b>${escapeHtml(n.name)}</b>${n.role ? ` <span class="sd-help" style="display:inline;">— ${escapeHtml(n.role)}</span>` : ""}</div>
        <button type="button" class="sd-npc-remove-btn" data-npc-id="${escapeHtml(n.id)}" title="ลบ"><i class="fa-fw fa-solid fa-xmark"></i></button>
    </div>`).join("");
}

function renderSecretsPoolRows(pool) {
    if (!pool.length) return `<div class="sd-help" style="margin:2px 0;">(ยังไม่มีความลับในรายการ)</div>`;
    return pool.map((p) => `<div class="sd-row" data-secret-pool-id="${escapeHtml(p.id)}" style="justify-content:space-between; align-items:flex-start;">
        <div style="flex:1 1 auto;"><b>${escapeHtml(p.characterName)}</b><div class="sd-help" style="margin:2px 0 0;">${p.text ? escapeHtml(truncateText(p.text, 90)) : "(ให้ Director แต่งเนื้อหาเองตอนเริ่มใช้)"}</div></div>
        <button type="button" class="sd-secret-pool-remove-btn" data-secret-pool-id="${escapeHtml(p.id)}" title="ลบ"><i class="fa-fw fa-solid fa-xmark"></i></button>
    </div>`).join("");
}

function renderSpecialDatesRows(dates) {
    if (!dates.length) return `<div class="sd-help" style="margin:2px 0;">(ยังไม่มีวันสำคัญ)</div>`;
    return dates.slice().sort((a, b) => new Date(a.date) - new Date(b.date)).map((d) => `<div class="sd-row" data-special-id="${escapeHtml(d.id)}" style="justify-content:space-between; align-items:center;">
        <span>${escapeHtml(d.label)} — ${escapeHtml(formatThaiDate(d.date))}</span>
        <button type="button" class="sd-special-date-remove-btn" data-special-id="${escapeHtml(d.id)}" title="ลบ"><i class="fa-fw fa-solid fa-xmark"></i></button>
    </div>`).join("");
}

const MAX_CUSTOM_STICKERS = 8;
const MAX_CUSTOM_STICKER_BYTES = 150 * 1024;
function renderCustomStickerRows(stickers) {
    if (!stickers.length) return `<div class="sd-help" style="margin:2px 0;">(ยังไม่มีสติกเกอร์ที่อัปโหลดเอง)</div>`;
    return `<div class="sd-custom-sticker-list">${stickers.map((s) => `<div class="sd-custom-sticker-row" data-sticker-id="${escapeHtml(s.id)}">
        <img src="${s.dataUrl}" alt="" />
        <span>${escapeHtml(s.label)}</span>
        <button type="button" class="sd-custom-sticker-remove-btn" data-sticker-id="${escapeHtml(s.id)}" title="ลบ"><i class="fa-fw fa-solid fa-xmark"></i></button>
    </div>`).join("")}</div>`;
}

const MAX_CUSTOM_SOUNDS = 5;
const MAX_CUSTOM_SOUND_BYTES = 300 * 1024;
function renderCustomSoundRows(sounds) {
    if (!sounds.length) return `<div class="sd-help" style="margin:2px 0;">(ยังไม่มีเสียงที่อัปโหลดเอง)</div>`;
    return sounds.map((s) => `<div class="sd-row" data-sound-id="${escapeHtml(s.id)}" style="justify-content:space-between; align-items:center;">
        <span><i class="fa-fw fa-solid fa-music"></i> ${escapeHtml(s.label)}</span>
        <span>
            <button type="button" class="sd-custom-sound-play-btn" data-sound-id="${escapeHtml(s.id)}" title="ลองฟัง"><i class="fa-fw fa-solid fa-play"></i></button>
            <button type="button" class="sd-custom-sound-remove-btn" data-sound-id="${escapeHtml(s.id)}" title="ลบ"><i class="fa-fw fa-solid fa-xmark"></i></button>
        </span>
    </div>`).join("");
}
function renderSoundStyleOptions(cfg) {
    const builtIn = Object.entries(SOUND_STYLES).map(([k, s]) => `<option value="${k}" ${cfg.soundStyle === k ? "selected" : ""}>${escapeHtml(s.label)}</option>`).join("");
    const custom = (cfg.customSounds || []).map((s) => `<option value="custom:${escapeHtml(s.id)}" ${cfg.soundStyle === `custom:${s.id}` ? "selected" : ""}>${escapeHtml(s.label)} (อัปโหลดเอง)</option>`).join("");
    return builtIn + custom;
}
// Renders the diary list in pages instead of dumping every matching entry into the DOM
// at once — matters once a long-running chat has hundreds of entries.
const DIARY_LIST_PAGE_SIZE = 40;
let diaryListRenderLimit = DIARY_LIST_PAGE_SIZE;
function resetDiaryListLimit() { diaryListRenderLimit = DIARY_LIST_PAGE_SIZE; }

function renderDiaryList(state) {
    const allEntries = getFilteredDiaryEntries(state).slice().reverse();
    if (allEntries.length === 0) return `<div class="sd-help">(ไม่มีไดอารี่ที่ตรงกับตัวกรอง)</div>`;
    const entries = allEntries.slice(0, diaryListRenderLimit);
    const showWeather = getChatSettings().diaryWeatherIconEnabled;
    const rows = entries.map((entry) => {
        const dot = entry.read ? "" : `<span class="sd-diary-unread-dot"></span>`;
        const weatherIcon = showWeather ? pickWeatherIcon(entry.weatherText) : null;
        const snippet = truncateText((entry.body || "").replace(/==/g, "").replace(/~~/g, "").replace(/__/g, "").replace(/``/g, ""), 56);
        return `<div class="sd-diary-list-row ${entry.favorite ? "sd-diary-list-row-fav" : ""}" data-entry-id="${entry.id}">
            <div class="sd-diary-list-date">${dot}${weatherIcon ? `<i class="fa-fw fa-solid ${weatherIcon.icon}" style="color:${weatherIcon.color};"></i> ` : ""}${escapeHtml(formatThaiDate(entry.dateIso))}${entry.favorite ? ' <i class="fa-fw fa-solid fa-bookmark sd-diary-fav-mark"></i>' : ""}</div>
            <div class="sd-diary-list-snippet">${escapeHtml(snippet)}</div>
        </div>`;
    }).join("");
    const remaining = allEntries.length - entries.length;
    const loadMoreHtml = remaining > 0
        ? `<button type="button" class="menu_button sd-diary-load-more-btn" id="sd-diary-load-more-btn">โหลดเพิ่มเติม (เหลืออีก ${remaining})</button>`
        : "";
    return rows + loadMoreHtml;
}

const WEATHER_ICONS = [
    { icon: "fa-sun", color: "#e8a33d", keywords: ["แดด", "แดดจ้า", "แจ่มใส", "ท้องฟ้าโปร่ง", "ร้อน"] },
    { icon: "fa-cloud-sun", color: "#c9a24b", keywords: ["แดดอ่อน", "มีเมฆบ้าง", "ครึ้มเล็กน้อย"] },
    { icon: "fa-cloud", color: "#9aa5b1", keywords: ["เมฆ", "ครึ้ม", "มืดครึ้ม", "หม่น"] },
    { icon: "fa-cloud-rain", color: "#6a92c9", keywords: ["ฝน", "ฝนตก", "ฝนปรอย", "ชื้น"] },
    { icon: "fa-cloud-bolt", color: "#8a6ac9", keywords: ["ฟ้าร้อง", "ฟ้าผ่า", "พายุฝนฟ้าคะนอง", "สายฟ้า"] },
    { icon: "fa-wind", color: "#7fb0a6", keywords: ["ลมแรง", "ลม", "พายุ"] },
    { icon: "fa-snowflake", color: "#7ec8e3", keywords: ["หิมะ", "หนาวจัด", "น้ำแข็ง"] },
    { icon: "fa-smog", color: "#a3a3a3", keywords: ["หมอก", "มัว", "ฝุ่น"] },
    { icon: "fa-moon", color: "#6c7a9c", keywords: ["กลางคืน", "ค่ำคืน", "ดึก"] },
];
function pickWeatherIcon(weatherText) {
    if (!weatherText) return null;
    for (const entry of WEATHER_ICONS) if (entry.keywords.some((kw) => String(weatherText).includes(kw))) return entry;
    return null;
}

function renderDiaryReader(entry) {
    const weatherLine = [entry.weatherText, entry.temperature != null ? `${entry.temperature}°C` : ""].filter(Boolean).join(" / ");
    const weatherIcon = getChatSettings().diaryWeatherIconEnabled ? pickWeatherIcon(entry.weatherText) : null;
    return `
        <div class="sd-diary-card ${entry.favorite ? "sd-diary-card-fav" : ""}">
            ${entry.favorite ? '<div class="sd-diary-corner-fold" title="หน้าโปรด"></div>' : ""}
            <div class="sd-diary-date">${escapeHtml(formatThaiDate(entry.dateIso))}</div>
            ${weatherLine ? `<div class="sd-diary-weather">${weatherIcon ? `<i class="fa-fw fa-solid ${weatherIcon.icon}" style="color:${weatherIcon.color};"></i> ` : ""}${escapeHtml(weatherLine)}</div>` : ""}
            <hr class="sd-diary-rule" />
            <div class="sd-diary-body">${renderDiaryBody(entry.body)}</div>
        </div>`;
}

const SD_TAB_ORDER = ["general", "settings", "threads", "diary", "history"];
const SD_TAB_LABELS = { general: "ทั่วไป", settings: "ตั้งค่า", threads: "เธรด", diary: "ไดอารี่", history: "ประวัติ" };
const SD_TAB_ICONS = { general: "fa-house", settings: "fa-gear", threads: "fa-diagram-project", diary: "fa-book-open", history: "fa-clock-rotate-left" };

function buildPopupHtml(cfg, state) {
    const profiles = getSavedConnectionProfiles();
    const profileOptions = [`<option value="">— เลือกโปรไฟล์ —</option>`]
        .concat(profiles.map((p) => `<option value="${escapeHtml(p.id)}" ${cfg.apiProfileId === p.id ? "selected" : ""}>${escapeHtml(p.name || p.id)}</option>`)).join("");

    const unreadCount = state.diaryLog.filter((e) => !e.read).length;

    const tabButtons = SD_TAB_ORDER.map((tab, i) => `
        <button type="button" class="sd-tab-btn ${i === 0 ? "active" : ""}" data-tab="${tab}" role="tab" aria-selected="${i === 0 ? "true" : "false"}">
            <i class="fa-fw fa-solid ${SD_TAB_ICONS[tab]}"></i>
            <span>${SD_TAB_LABELS[tab]}</span>
            ${tab === "diary" && unreadCount > 0 ? `<span class="sd-tab-badge" id="sd-diary-badge">${unreadCount}</span>` : ""}
        </button>`).join("");

    return `
    <div class="sd-popup">
        <div class="sd-row" style="justify-content:flex-end; margin:0 0 4px;">
            <button type="button" class="sd-guide-trigger-btn" id="sd-guide-btn" title="เปิดคู่มือเริ่มต้นใช้งาน"><i class="fa-fw fa-solid fa-circle-question"></i> คู่มือเริ่มต้น</button>
        </div>
        <div class="sd-tabbar" id="sd-tabbar" role="tablist">
            <div class="sd-tab-pill" id="sd-tab-pill"></div>
            ${tabButtons}
        </div>

        <div class="sd-tab-panel" data-tab-panel="general">
            <div class="sd-row"><label><input type="checkbox" id="sd-enabled" ${cfg.enabled ? "checked" : ""}/> เปิดใช้งานกับแชทนี้</label></div>
            <div class="sd-help">เมื่อปิดใช้งาน ระบบทั้งหมดของแชทนี้จะหยุดทำงานชั่วคราว โดยการตั้งค่าที่บันทึกไว้จะยังอยู่ครบถ้วน และสามารถเปิดกลับมาใช้งานได้ทุกเมื่อ</div>

            <div class="sd-subsection">
                <h4>API สำหรับ Director (จำเป็น)</h4>
                <div class="sd-help">เลือกช่องทางเชื่อมต่อ (Connection Profile) ที่ตั้งค่าไว้แล้วในเมนู API ของ SillyTavern เพื่อให้ Story Director ใช้งาน จำเป็นต้องเลือกก่อนจึงจะเริ่มทำงานได้ เลือกโปรไฟล์จากรายการ แล้วกดปุ่ม <b>ทดสอบ</b> เพื่อตรวจสอบว่าเชื่อมต่อได้จริง</div>
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
                <select id="sd-sound-style">${renderSoundStyleOptions(cfg)}</select>
                <button type="button" class="menu_button" id="sd-sound-test-btn">ลองฟังเสียง</button>
            </div>
            <div class="sd-help">เมื่อเปิดใช้งาน จะมีเสียงสั้นๆ ดังขึ้นทุกครั้งที่มีเหตุการณ์ใหม่เกิดขึ้นในเรื่อง เลือกเสียงที่ต้องการจากรายการ และกดปุ่ม <b>ลองฟังเสียง</b> เพื่อฟังตัวอย่างได้ทันทีโดยไม่ต้องกดบันทึกก่อน</div>

            <div class="sd-subsection" style="margin-top:8px;">
                <h4 style="margin-top:0;">อัปโหลดเสียงแจ้งเตือนของคุณเอง</h4>
                <div class="sd-help">อัปโหลดไฟล์เสียงสั้นๆ ของตัวเอง (แนะนำไม่เกิน 3-4 วินาที) ไฟล์เล็กกว่า 300KB เพิ่มได้สูงสุด ${MAX_CUSTOM_SOUNDS} เสียง เพิ่มแล้วจะไปโผล่ในช่อง <b>เลือกเสียง</b> ด้านบนให้เลือกได้เลย</div>
                <div id="sd-custom-sounds-list">${renderCustomSoundRows(cfg.customSounds)}</div>
                <div class="sd-row">
                    <input type="text" id="sd-custom-sound-label" placeholder="ชื่อเสียง เช่น กระดิ่งของฉัน" style="flex:1 1 140px;"/>
                    <button type="button" class="menu_button" id="sd-custom-sound-pick-btn"><i class="fa-fw fa-solid fa-music"></i> เลือกไฟล์เสียง</button>
                    <input type="file" id="sd-custom-sound-file" accept="audio/*" style="display:none" />
                </div>
                <div id="sd-custom-sound-preview" class="sd-sticker-preview sd-hidden">
                    <span id="sd-custom-sound-preview-name" class="sd-sticker-preview-name"></span>
                    <button type="button" class="menu_button" id="sd-custom-sound-preview-play-btn"><i class="fa-fw fa-solid fa-play"></i></button>
                    <button type="button" class="menu_button" id="sd-custom-sound-add-btn">เพิ่ม</button>
                    <button type="button" class="sd-custom-sticker-cancel-btn" id="sd-custom-sound-cancel-btn" title="ยกเลิก"><i class="fa-fw fa-solid fa-xmark"></i></button>
                </div>
            </div>

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

        <div class="sd-tab-panel sd-hidden" data-tab-panel="settings">
            <div class="sd-row"><label>ธีมที่อนุญาต</label></div>
            <div class="sd-tags">${renderTagPicker(cfg)}</div>
            <div class="sd-help">เลือกธีมที่ต้องการให้เนื้อเรื่องดำเนินไปในแนวทางนั้นๆ เลือกได้มากกว่าหนึ่งธีม หากไม่เลือกเลย เนื้อเรื่องจะดำเนินไปอย่างอิสระตามบรรยากาศของแชทในขณะนั้น</div>

            <div class="sd-subsection">
                <h4 style="margin-top:0;">บุคลิก Director</h4>
                <div class="sd-help">กำหนดโทนที่ Director ใช้ตัดสินใจแต่ละครั้ง เลือก <b>สุ่มทุกครั้ง</b> เพื่อให้บุคลิกสลับไปมาเองในแต่ละการตัดสินใจ ช่วยให้เรื่องไม่นิ่งไปทางเดียวตลอด</div>
                <div class="sd-row">
                    <select id="sd-director-persona">
                        <option value="balanced" ${cfg.directorPersona === "balanced" ? "selected" : ""}>สมดุล</option>
                        <option value="dramatic" ${cfg.directorPersona === "dramatic" ? "selected" : ""}>ดราม่าเข้ม</option>
                        <option value="comedic" ${cfg.directorPersona === "comedic" ? "selected" : ""}>ตลก/เบาสมอง</option>
                        <option value="slow_burn" ${cfg.directorPersona === "slow_burn" ? "selected" : ""}>Slow burn</option>
                        <option value="twist" ${cfg.directorPersona === "twist" ? "selected" : ""}>สายทวิสต์</option>
                        <option value="wholesome" ${cfg.directorPersona === "wholesome" ? "selected" : ""}>อบอุ่น/Feel-good</option>
                        <option value="high_stakes" ${cfg.directorPersona === "high_stakes" ? "selected" : ""}>เข้มข้น/เสี่ยงสูง</option>
                        <option value="enigmatic" ${cfg.directorPersona === "enigmatic" ? "selected" : ""}>ลึกลับ/เก็บปม</option>
                        <option value="random" ${cfg.directorPersona === "random" ? "selected" : ""}>สุ่มทุกครั้ง</option>
                    </select>
                </div>
                <div class="sd-row"><label><input type="checkbox" id="sd-anti-stagnation-enabled" ${cfg.antiStagnationEnabled ? "checked" : ""}/> ตัวช่วยกันเธรดจำเจ</label></div>
                <div class="sd-help">เมื่อเปิดใช้งาน ระบบจะสังเกตว่าเธรดใหม่ๆ ที่เปิดล่าสุดใช้อารมณ์/ธีมเดิมซ้ำกันบ่อยเกินไปไหม (เช่นโรแมนติกติดกัน 3 เธรด) แล้วเตือน Director ให้ลองเปลี่ยนไปทางอื่นตอนเปิดเธรดใหม่ครั้งถัดไป</div>
            </div>

            <div class="sd-row">
                <label>ความถี่ที่ Director จะพิจารณา</label>
                <select id="sd-frequency-mode">
                    <option value="random" ${cfg.frequencyMode === "random" ? "selected" : ""}>สุ่ม % ทุกข้อความ</option>
                    <option value="interval" ${cfg.frequencyMode === "interval" ? "selected" : ""}>ทุก N ข้อความ</option>
                </select>
            </div>
            <div class="sd-row"><label>โอกาส (%)</label><input type="number" id="sd-random-chance" min="0" max="100" value="${cfg.randomChance}"/>
                <label>N ข้อความ</label><input type="number" id="sd-interval-n" min="1" max="200" value="${cfg.intervalN}"/></div>
            <div class="sd-help">กำหนดว่าจะพิจารณาสร้างเหตุการณ์บ่อยแค่ไหน เลือก <b>สุ่ม % ทุกข้อความ</b> แล้วใส่ตัวเลขในช่องโอกาส เช่นใส่ 20 หมายถึงมีโอกาส 20% ในทุกข้อความของตัวละคร หรือเลือก <b>ทุก N ข้อความ</b> แล้วใส่จำนวนข้อความในช่อง N ข้อความ เช่นใส่ 6 หมายถึงพิจารณาทุกๆ 6 ข้อความ</div>

            <div class="sd-row"><label>ความรุนแรงของเหตุการณ์</label>
                <select id="sd-event-intensity">
                    <option value="mild" ${cfg.eventIntensity === "mild" ? "selected" : ""}>เบา</option>
                    <option value="medium" ${cfg.eventIntensity === "medium" ? "selected" : ""}>ปานกลาง</option>
                    <option value="disruptive" ${cfg.eventIntensity === "disruptive" ? "selected" : ""}>รุนแรง/พลิกสถานการณ์</option>
                </select>
            </div>
            <div class="sd-help">กำหนดว่าเหตุการณ์ที่เกิดขึ้นจะส่งผลต่อเรื่องมากแค่ไหน เลือก <b>เบา</b> สำหรับการเปลี่ยนแปลงเล็กน้อยที่ไม่รบกวนฉากปัจจุบัน <b>ปานกลาง</b> สำหรับเหตุการณ์ที่มีผลชัดเจนต่อเนื้อเรื่อง หรือ <b>รุนแรง/พลิกสถานการณ์</b> สำหรับการเปลี่ยนแปลงใหญ่ที่ตัวละครไม่สามารถมองข้ามได้</div>

            <div class="sd-row"><label>รูปแบบการนำเสนอ</label>
                <select id="sd-presentation">
                    <option value="subtle" ${cfg.presentation === "subtle" ? "selected" : ""}>แนบเนียน</option>
                    <option value="narrator" ${cfg.presentation === "narrator" ? "selected" : ""}>ผู้บรรยาย/GM แทรก</option>
                    <option value="both" ${cfg.presentation === "both" ? "selected" : ""}>ให้โมเดลเลือกเอง</option>
                </select>
            </div>
            <div class="sd-help">กำหนดว่าเหตุการณ์จะถูกนำเสนออย่างไรในข้อความ เลือก <b>แนบเนียน</b> เพื่อให้กลมกลืนไปกับบทบรรยายตามปกติ <b>ผู้บรรยาย/GM แทรก</b> เพื่อให้แยกออกมาชัดเจนว่าเป็นข้อความแทรก หรือ <b>ให้โมเดลเลือกเอง</b> เพื่อให้โมเดลเลือกรูปแบบที่เหมาะกับแต่ละฉากด้วยตัวเอง</div>

            <div class="sd-row"><label>เธรดพร้อมกันสูงสุด</label><input type="number" id="sd-max-threads" min="1" max="10" value="${cfg.maxActiveThreads}"/>
                <label>จำจำนวนเธรดที่ปิดแล้ว</label><input type="number" id="sd-dormant-memory" min="1" max="30" value="${cfg.dormantMemory}"/></div>
            <div class="sd-row"><label>Cooldown กันธีมซ้ำ (ข้อความ)</label><input type="number" id="sd-thread-cooldown" min="1" max="100" value="${cfg.threadCooldownN}"/></div>
            <div class="sd-help"><b>เธรดพร้อมกันสูงสุด</b> คือจำนวนปมเรื่องที่อนุญาตให้ดำเนินไปพร้อมกันได้ในคราวเดียว ใส่ตัวเลขมากขึ้นหากต้องการให้เรื่องมีหลายเส้นเรื่องซ้อนกัน <b>จำจำนวนเธรดที่ปิดแล้ว</b> คือจำนวนปมเรื่องที่ปิดไปแล้วที่ระบบจะจดจำไว้ เพื่อไม่ให้หยิบเรื่องเดิมที่จบไปแล้วกลับมาใช้ซ้ำ <b>Cooldown กันธีมซ้ำ</b> คือจำนวนข้อความหลังปิดเธรดหนึ่งๆ ที่ห้าม Director เปิดเธรดใหม่ที่มีธีมใกล้เคียงกัน</div>

            <div class="sd-row"><label><input type="checkbox" id="sd-time-skip-enabled" ${cfg.timeSkipEnabled ? "checked" : ""}/> ให้ Director ข้ามเวลาได้ (Time Skip)</label></div>
            <div class="sd-help">เมื่อเปิดใช้งาน Director จะเลือกข้ามเวลาไปข้างหน้าเป็น ชม./วัน/สัปดาห์ ได้เองเมื่อเห็นว่าฉากปัจจุบันจบลงเป็นธรรมชาติแล้ว แยกจากการดันเธรดปกติ ตอนข้ามเวลาจะมีสรุปสถานะเธรดที่ค้างอยู่ให้ AI นำไปเล่าประกอบฉากด้วย</div>

            <div class="sd-subsection" style="margin-top:8px;">
                <div class="sd-row" style="align-items:center; gap:8px; margin-bottom:4px;">
                    <input type="checkbox" id="sd-recap-enabled" ${cfg.recapEnabled ? "checked" : ""}/>
                    <h4 style="margin:0;"><b>ความเดิมตอนที่แล้ว</b> อัตโนมัติ</h4>
                </div>
                <div class="sd-help">เมื่อกลับมาเล่นต่อหลังห่างหายไปเป็นเวลานาน (นับจากเวลาจริง ไม่ใช่เวลาภายในเรื่อง) ระบบจะแทรกบทสรุปสั้นๆ ของเรื่องราวที่ค้างอยู่ให้โดยอัตโนมัติ ผ่านคำพูดของตัวละครหรือคำบรรยายของผู้เล่าเรื่อง เพื่อช่วยให้กลับเข้าสู่เนื้อเรื่องได้ง่ายขึ้น</div>
                <div class="sd-row"><label>ห่างไปกี่ชั่วโมงถึงนับว่านาน</label><input type="number" id="sd-recap-gap-hours" min="1" max="720" value="${cfg.recapGapHours}"/></div>
            </div>

            <div class="sd-subsection" style="margin-top:8px;">
                <div class="sd-row" style="align-items:center; gap:8px; margin-bottom:4px;">
                    <input type="checkbox" id="sd-followup-enabled" ${cfg.followUpEnabled ? "checked" : ""}/>
                    <h4 style="margin:0;">Follow-up ต่อเนื่อง</h4>
                </div>
                <div class="sd-help">เธรดที่เพิ่งเปิด/ดันคืบ มีโอกาสผูกคิวให้ Director ต้องกลับมาต่อเธรดเดิมโดยอัตโนมัติในอีกไม่กี่ข้อความ (บังคับ 100% ตอนถึงคิว ไม่ปล่อยให้สุ่มเธรดอื่น)</div>
                <div class="sd-row"><label>โอกาสผูกคิว (%)</label><input type="number" id="sd-followup-chance" min="0" max="100" value="${cfg.followUpChance}"/></div>
                <div class="sd-row"><label>ห่างอย่างน้อย (ข้อความ)</label><input type="number" id="sd-followup-delay-min" min="1" max="50" value="${cfg.followUpDelayMin}"/>
                    <label>ห่างอย่างมาก (ข้อความ)</label><input type="number" id="sd-followup-delay-max" min="1" max="50" value="${cfg.followUpDelayMax}"/></div>
                <div class="sd-row"><label>ต่อคิวติดกันได้สูงสุด</label><input type="number" id="sd-followup-max-chain" min="0" max="10" value="${cfg.followUpMaxChain}"/></div>
                <div class="sd-help">เมื่อเธรดใดเธรดหนึ่งถูกผูกคิว Director จะต้องกลับมาต่อเธรดนั้นภายในช่วงข้อความที่กำหนด ระหว่าง <b>ห่างอย่างน้อย</b> ถึง <b>ห่างอย่างมาก</b> ส่วน <b>โอกาสผูกคิว</b> คือโอกาส (%) ที่จะเกิดการผูกคิวขึ้นทุกครั้งที่เธรดถูกดันคืบ และ <b>ต่อคิวติดกันได้สูงสุด</b> จำกัดจำนวนครั้งที่เธรดเดียวกันจะถูกผูกคิวต่อเนื่องกันไปเรื่อยๆ (ใส่ 0 เพื่อปิดการผูกคิวทั้งหมด)</div>
            </div>

            <div class="sd-subsection" style="margin-top:8px;">
                <div class="sd-row" style="align-items:center; gap:8px; margin-bottom:4px;">
                    <input type="checkbox" id="sd-npc-events-enabled" ${cfg.npcEventsEnabled ? "checked" : ""}/>
                    <h4 style="margin:0;">เหตุการณ์ที่มี NPC เกี่ยวข้อง</h4>
                </div>
                <div class="sd-help">เมื่อเปิดใช้งาน Director จะพิจารณาดึงตัวละครสมทบ (NPC) เข้ามาเกี่ยวข้องกับเหตุการณ์ต่างๆ เพื่อให้โลกในเรื่องรู้สึกมีชีวิตขึ้น ไม่จำเป็นต้องมีทุกครั้ง เพิ่มชื่อ NPC ที่อยากให้ใช้ไว้ในทำเนียบด้านล่างได้ (ไม่บังคับ — Director แต่ง NPC ใหม่เองได้เมื่อเข้ากับบริบท) ดูแผนที่ความสัมพันธ์ระหว่าง NPC ด้วยกันได้ที่แท็บ <b>เธรด</b></div>
                <div class="sd-row"><label>ความถี่ที่อยากให้มี NPC</label>
                    <select id="sd-npc-frequency">
                        <option value="occasional" ${cfg.npcFrequency === "occasional" ? "selected" : ""}>นานๆ ครั้ง</option>
                        <option value="frequent" ${cfg.npcFrequency === "frequent" ? "selected" : ""}>บ่อยๆ</option>
                        <option value="almost_always" ${cfg.npcFrequency === "almost_always" ? "selected" : ""}>เกือบทุกครั้ง</option>
                    </select>
                </div>
                <div id="sd-npc-roster-list">${renderNpcRosterRows(cfg.npcRoster)}</div>
                <div class="sd-row">
                    <input type="text" id="sd-npc-name" placeholder="ชื่อ NPC เช่น ครูแอนนา" style="flex:1 1 140px;"/>
                    <input type="text" id="sd-npc-role" placeholder="บทบาท/หมายเหตุ (ไม่บังคับ)" style="flex:1 1 140px;"/>
                    <button type="button" class="menu_button" id="sd-npc-add-btn">เพิ่มเข้าทำเนียบ</button>
                </div>
            </div>

            <div class="sd-subsection" style="margin-top:8px;">
                <div class="sd-row" style="align-items:center; gap:8px; margin-bottom:4px;">
                    <input type="checkbox" id="sd-secrets-enabled" ${cfg.secretsEnabled ? "checked" : ""}/>
                    <h4 style="margin:0;">ความลับของตัวละคร (Secrets)</h4>
                </div>
                <div class="sd-help">กำหนดความลับของตัวละครหรือ NPC ไว้ล่วงหน้า โดยเขียนเนื้อหาเองหรือปล่อยว่างไว้ให้ Director คิดขึ้นเองก็ได้ Director จะค่อยๆ เผยเบาะแสเล็กๆ น้อยๆ ผ่านเหตุการณ์และไดอารี่ไปทีละนิด ก่อนจะเลือกจังหวะที่เหมาะสมเพื่อเฉลยความลับทั้งหมด ดูสถานะความลับที่กำลังดำเนินอยู่ได้ที่แท็บ <b>เธรด</b></div>
                <div id="sd-secrets-pool-list">${renderSecretsPoolRows(cfg.secretsPool)}</div>
                <div class="sd-row">
                    <input type="text" id="sd-secret-character" placeholder="ชื่อตัวละคร/NPC เจ้าของความลับ" style="flex:1 1 160px;"/>
                </div>
                <div class="sd-row">
                    <textarea id="sd-secret-text" class="sd-pool-textarea" rows="2" placeholder="เนื้อหาความลับ (เว้นว่างไว้ให้ Director แต่งเองตอนเริ่มใช้ก็ได้)"></textarea>
                </div>
                <div class="sd-row"><button type="button" class="menu_button" id="sd-secret-add-btn">เพิ่มเข้ารายการ</button></div>
            </div>

            <div class="sd-subsection" style="margin-top:8px;">
                <div class="sd-row" style="align-items:center; gap:8px; margin-bottom:4px;">
                    <input type="checkbox" id="sd-callback-enabled" ${cfg.callbackEnabled ? "checked" : ""}/>
                    <h4 style="margin:0;">Callback อดีต</h4>
                </div>
                <div class="sd-help">นำรายละเอียดเล็กๆ น้อยๆ จากเหตุการณ์หรือไดอารี่ในอดีตที่ผ่านมานานแล้ว ซึ่งผู้เล่นอาจลืมไปแล้ว กลับมากล่าวถึงอีกครั้งเป็นครั้งคราว เพื่อให้เนื้อเรื่องดูมีความต่อเนื่องและสมจริงมากขึ้น</div>
                <div class="sd-row"><label>นับเป็น <b>อดีต</b> เมื่อผ่านไปแล้วอย่างน้อย (ข้อความ)</label><input type="number" id="sd-callback-min-age" min="5" max="500" value="${cfg.callbackMinAge}"/></div>
            </div>

            <div class="sd-subsection" style="margin-top:8px;">
                <div class="sd-row" style="align-items:center; gap:8px; margin-bottom:4px;">
                    <input type="checkbox" id="sd-story-arcs-enabled" ${cfg.storyArcsEnabled ? "checked" : ""}/>
                    <h4 style="margin:0;">โครงเรื่องระยะยาวแบบซีซั่น (Story Arcs)</h4>
                </div>
                <div class="sd-help">วางแผนโครงเรื่องระยะยาวที่ประกอบด้วยหลายเหตุการณ์ต่อเนื่องกัน มีชื่อเรื่องและจุดไคลแมกซ์ของตัวเอง ทำให้เนื้อเรื่องรู้สึกเหมือนซีรีส์ที่มีซีซั่น แทนที่จะเป็นเหตุการณ์แยกกันแบบสุ่ม ดูความคืบหน้าของเรื่องราวปัจจุบันได้ที่แท็บ <b>เธรด</b></div>
                <div class="sd-row"><label>ความยาวอาร์คต่ำสุด (เหตุการณ์)</label><input type="number" id="sd-arc-min-length" min="2" max="50" value="${cfg.arcMinLength}"/>
                    <label>สูงสุด</label><input type="number" id="sd-arc-max-length" min="2" max="50" value="${cfg.arcMaxLength}"/></div>
            </div>

            <div class="sd-subsection" style="margin-top:8px;">
                <h4 style="margin-top:0;">คลังเหตุการณ์ล่วงหน้า</h4>
                <div class="sd-help">เขียนปมเรื่องที่อยากให้เกิดไว้ล่วงหน้า Director จะเลือกจากคลังนี้ก่อนเป็นอันดับแรกเวลาจะเปิดเธรดใหม่ตราบใดที่ยังมีเหลือ ถ้าคลังว่างหรือไม่มีอันไหนเข้ากับจังหวะเรื่อง จะให้ AI คิดเองตามปกติ ใช้แล้วจะถูกตัดออกจากคลังอัตโนมัติ</div>
                <div id="sd-event-pool-list">${renderEventPoolRows(cfg.eventPool)}</div>
                <div class="sd-row">
                    <input type="text" id="sd-pool-title" placeholder="ชื่อเหตุการณ์ เช่น เจอจดหมายเก่า" style="flex:1 1 160px;"/>
                </div>
                <div class="sd-row">
                    <textarea id="sd-pool-detail" class="sd-pool-textarea" rows="2" placeholder="รายละเอียดสั้นๆ ให้ narrator เอาไปเขียนต่อ"></textarea>
                </div>
                <div class="sd-row"><button type="button" class="menu_button" id="sd-pool-add-btn">เพิ่มเข้าคลัง</button></div>
            </div>

            <div class="sd-row"><label><input type="checkbox" id="sd-preview-enabled" ${cfg.promptPreviewEnabled ? "checked" : ""}/> เปิด Prompt Preview</label></div>
            <div class="sd-help">เปิดใช้งานเพื่อดูตัวอย่างข้อความที่จะส่งให้ Director พิจารณา โดยไม่เสียค่าใช้จ่ายหรือเรียก API จริง เหมาะสำหรับตรวจสอบก่อนใช้งานจริง</div>
            <div class="sd-row ${cfg.promptPreviewEnabled ? "" : "sd-hidden"}" id="sd-preview-tools">
                <button type="button" class="menu_button" id="sd-preview-director-btn">พรีวิวพรอมต์ Director</button>
            </div>
            <textarea id="sd-preview-output" class="sd-pool-textarea ${cfg.promptPreviewEnabled ? "" : "sd-hidden"}" readonly rows="6"></textarea>
        </div>

        <div class="sd-tab-panel sd-hidden" data-tab-panel="threads">
            <h4 style="margin-top:0;">สถานะเธรดตอนนี้</h4>
            <div class="sd-help">แสดงรายการปมเรื่องที่กำลังดำเนินอยู่ในแชทนี้ และปมเรื่องที่ปิดไปแล้วล่าสุด อัปเดตอัตโนมัติเมื่อมีความคืบหน้าใหม่</div>
            <div id="sd-thread-panel">${renderThreadPanel(state, cfg)}</div>
        </div>

        <div class="sd-tab-panel sd-hidden" data-tab-panel="diary">
            <div class="sd-row"><label><input type="checkbox" id="sd-diary-enabled" ${cfg.diaryEnabled ? "checked" : ""}/> เปิดใช้สมุดไดอารี่</label></div>
            <div class="sd-help">เมื่อเปิดใช้งาน ตัวละครจะเขียนบันทึกไดอารี่ส่วนตัวเป็นระยะๆ ตามความคืบหน้าของเนื้อเรื่อง สามารถอ่านได้จากรายการด้านล่าง</div>

            <div class="sd-row"><label>โอกาสเขียนไดอารี่ตอนเธรดแค่ขยับ (%)</label><input type="number" id="sd-diary-advance-chance" min="0" max="100" value="${cfg.diaryAdvanceChance}"/></div>
            <div class="sd-help">กำหนดโอกาส (%) ที่จะมีการเขียนไดอารี่ในกรณีที่เนื้อเรื่องเพียงแค่คืบหน้าไปทีละขั้นตามปกติ ใส่ตัวเลข 0-100 เช่นใส่ 50 หมายถึงมีโอกาสครึ่งหนึ่ง ทั้งนี้เหตุการณ์สำคัญ เช่นการเริ่มหรือจบปมเรื่องหนึ่งๆ จะมีการเขียนไดอารี่เสมอโดยไม่ขึ้นกับค่านี้</div>

            <div class="sd-row"><label><input type="checkbox" id="sd-diary-stickers-enabled" ${cfg.diaryStickersEnabled ? "checked" : ""}/> แสดงสติกเกอร์อารมณ์บนหน้าไดอารี่</label></div>
            <div class="sd-help">เมื่อเปิดใช้งาน จะมีสติกเกอร์แสดงอารมณ์ปรากฏอยู่บนหน้าไดอารี่และการแจ้งเตือน</div>

            <div class="sd-row"><label><input type="checkbox" id="sd-diary-weather-icon-enabled" ${cfg.diaryWeatherIconEnabled ? "checked" : ""}/> แสดงไอคอนสภาพอากาศบนหน้าไดอารี่</label></div>
            <div class="sd-help">อ่านจากข้อความสภาพอากาศที่ตัวละครเขียนไว้ในแต่ละหน้า แล้วเลือกไอคอนที่ใกล้เคียงที่สุดให้อัตโนมัติ</div>

            <div class="sd-row"><label><input type="checkbox" id="sd-bond-enabled" ${cfg.bondTrackingEnabled ? "checked" : ""}/> ติดตามค่าความผูกพัน (Bond)</label></div>
            <div class="sd-help">ให้ Director ประเมินหลังทุกเหตุการณ์ว่ากระทบความผูกพันระหว่างตัวละครกับผู้เล่นแค่ไหน (0-100 เริ่มที่ 50) ดูกราฟย้อนหลังได้ด้านล่าง และดูภาพรวมของทุกตัวละครได้ในแท็บเธรด</div>

            <div class="sd-row"><label><input type="checkbox" id="sd-diary-banner-enabled" ${cfg.diaryBannerEnabled ? "checked" : ""}/> แจ้งเตือนแบบ popup เมื่อมีไดอารี่หน้าใหม่</label></div>
            <div class="sd-help">เมื่อเปิดใช้งาน จะมีข้อความแจ้งเตือนเล็กๆ ปรากฏที่มุมหน้าจอทุกครั้งที่มีไดอารี่ฉบับใหม่</div>

            <div class="sd-row"><label>ธีมสีหน้าไดอารี่</label>
                <select id="sd-diary-theme">
                    <option value="classic" ${cfg.diaryTheme === "classic" ? "selected" : ""}>คลาสสิก (น้ำเงิน/ทอง)</option>
                    <option value="sweet" ${cfg.diaryTheme === "sweet" ? "selected" : ""}>หวาน (ชมพู)</option>
                    <option value="mono" ${cfg.diaryTheme === "mono" ? "selected" : ""}>เท่ (ดำ/เทา)</option>
                    <option value="sunny" ${cfg.diaryTheme === "sunny" ? "selected" : ""}>สดใส (ส้ม/เหลือง)</option>
                    <option value="calm" ${cfg.diaryTheme === "calm" ? "selected" : ""}>สงบ (เขียว)</option>
                </select>
            </div>
            <div class="sd-help">เลือกโทนสีของหน้าไดอารี่และป้ายแจ้งเตือน มีผลทันทีเมื่อเปลี่ยน ไม่ต้องกดบันทึกก่อนดูตัวอย่างในหน้านี้</div>

            <div class="sd-row"><label>วันเริ่มต้นปฏิทินในเรื่อง</label><input type="date" id="sd-calendar-start" value="${escapeHtml(cfg.calendarStartDate)}"/></div>
            <div class="sd-help">กำหนดวันที่เริ่มต้นของปฏิทินในเรื่อง เลือกวันที่ที่ต้องการ หรือเว้นว่างไว้เพื่อใช้วันที่ปัจจุบันเป็นจุดเริ่มต้นโดยอัตโนมัติ</div>

            ${renderDiaryCharacterToggles(cfg)}

            <div class="sd-subsection" style="margin-top:8px;">
                <h4 style="margin-top:0;">วันสำคัญในเรื่อง</h4>
                <div class="sd-help">วันที่ Director อาจหยิบมาอ้างอิงเมื่อปฏิทินในเรื่องเดินมาใกล้ถึง (ไม่บังคับต้องใช้)</div>
                <div id="sd-special-dates-list">${renderSpecialDatesRows(cfg.specialDates)}</div>
                <div class="sd-row">
                    <input type="text" id="sd-special-date-label" placeholder="ชื่อวัน เช่น วันเกิดของอาเรีย" style="flex:1 1 160px;"/>
                    <input type="date" id="sd-special-date-value"/>
                    <button type="button" class="menu_button" id="sd-special-date-add-btn">เพิ่ม</button>
                </div>
            </div>

            <div class="sd-subsection" style="margin-top:8px;">
                <h4 style="margin-top:0;">จดหมายถึงอนาคต</h4>
                <div class="sd-help">เขียนจดหมายถึงตัวละครไว้ล่วงหน้า เลือกวันที่ในปฏิทินของเรื่องที่อยากให้จดหมายมาถึง พอปฏิทินในเรื่องเดินมาถึงวันนั้น ระบบจะแทรกจดหมายเข้าไปให้ตัวละครอ่านและตอบสนองในฉากถัดไปโดยอัตโนมัติ (ไม่ต้องรอ Director ตัดสินใจ)</div>
                <div id="sd-letters-list">${renderScheduledLettersRows(state)}</div>
                <div class="sd-row">
                    ${(() => {
                        const names = getGroupMemberNames();
                        return names && names.length > 1
                            ? `<select id="sd-letter-to">${names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("")}</select>`
                            : `<input type="hidden" id="sd-letter-to" value="${escapeHtml(getCharacterName())}"/>`;
                    })()}
                    <input type="date" id="sd-letter-date"/>
                    <button type="button" class="menu_button" id="sd-letter-add-btn">ส่งจดหมาย</button>
                </div>
                <textarea id="sd-letter-body" placeholder="เนื้อความจดหมาย..." rows="3" style="width:100%; margin-top:4px;"></textarea>
            </div>

            <div class="sd-subsection" style="margin-top:8px;">
                <h4 style="margin-top:0;">สติกเกอร์อารมณ์ของคุณเอง</h4>
                <div class="sd-help">อัปโหลดรูปสติกเกอร์เอง ตั้งคำสำคัญของอารมณ์ (เช่น <b>ลุ้น</b>) ถ้าอารมณ์ที่ไดอารี่เขียนมีคำนั้นอยู่ จะใช้สติกเกอร์นี้แทนชุดเดิม จำกัดไม่เกิน ${MAX_CUSTOM_STICKERS} รูป ไฟล์ไม่เกิน 150KB ต่อรูป</div>
                <div id="sd-custom-stickers-list">${renderCustomStickerRows(cfg.customStickers)}</div>
                <div class="sd-row">
                    <input type="text" id="sd-custom-sticker-label" placeholder="คำสำคัญของอารมณ์" style="flex:1 1 140px;"/>
                    <button type="button" class="menu_button" id="sd-custom-sticker-pick-btn"><i class="fa-fw fa-solid fa-image"></i> เลือกรูปจากแกลเลอรี่</button>
                    <input type="file" id="sd-custom-sticker-file" accept="image/*" style="display:none" />
                </div>
                <div id="sd-custom-sticker-preview" class="sd-sticker-preview sd-hidden">
                    <img id="sd-custom-sticker-preview-img" src="" alt="" />
                    <span id="sd-custom-sticker-preview-name" class="sd-sticker-preview-name"></span>
                    <button type="button" class="menu_button" id="sd-custom-sticker-add-btn">เพิ่ม</button>
                    <button type="button" class="sd-custom-sticker-cancel-btn" id="sd-custom-sticker-cancel-btn" title="ยกเลิก"><i class="fa-fw fa-solid fa-xmark"></i></button>
                </div>
            </div>

            <div class="sd-subsection sd-diary-theme-${cfg.diaryTheme}" id="sd-diary-shell" style="margin-top:8px;">
                <div id="sd-diary-list-view">
                    <div class="sd-row" style="justify-content:space-between; align-items:center; flex-wrap:wrap;">
                        <h4 style="margin:0;">สมุดไดอารี่ — ${escapeHtml(getCharacterName())}</h4>
                        <div class="sd-io-row" style="display:flex; flex-wrap:wrap; gap:4px;">
                            ${renderDiaryCharacterFilter(state)}
                            <button type="button" class="menu_button ${state.diaryFilterFavoriteOnly ? "active" : ""}" id="sd-diary-fav-filter-btn" title="แสดงเฉพาะหน้าโปรด"><i class="fa-fw fa-solid fa-bookmark"></i></button>
                            <button type="button" class="menu_button" id="sd-diary-export-md-btn" title="ส่งออกทั้งหมดเป็นไฟล์ .md">.md</button>
                            <button type="button" class="menu_button" id="sd-diary-export-txt-btn" title="ส่งออกทั้งหมดเป็นไฟล์ .txt">.txt</button>
                            <button type="button" class="menu_button" id="sd-diary-import-btn" title="นำเข้าไดอารี่จากไฟล์ .md/.txt ที่ export มาจากระบบนี้"><i class="fa-fw fa-solid fa-file-import"></i></button>
                            <input type="file" id="sd-diary-import-file" accept=".md,.txt,text/markdown,text/plain" style="display:none" />
                        </div>
                    </div>
                    <div class="sd-row">
                        <input type="text" id="sd-diary-search-input" placeholder="ค้นหาข้อความในไดอารี่..." value="${escapeHtml(state.diarySearchQuery || "")}" style="flex:1 1 auto;"/>
                        ${state.diarySearchQuery ? `<button type="button" class="menu_button" id="sd-diary-search-clear-btn" title="ล้างคำค้นหา"><i class="fa-fw fa-solid fa-xmark"></i></button>` : ""}
                    </div>
                    <div id="sd-diary-mood-timeline">${renderMoodTimeline(state)}</div>
                    <div id="sd-diary-calendar" class="sd-calendar">${renderDiaryCalendar(cfg, state)}</div>
                    ${cfg.bondTrackingEnabled ? `<div class="sd-subsection" style="margin-top:6px;">
                        <h4 style="margin-top:0;">กราฟความผูกพัน</h4>
                        <div id="sd-bond-timeline">${renderBondTimeline(state, state.diaryFilterCharacter)}</div>
                    </div>` : ""}
                    <div id="sd-diary-list" class="sd-diary-list">${renderDiaryList(state)}</div>
                </div>
                <div id="sd-diary-reader-view" class="sd-hidden">
                    <div class="sd-diary-page-header">
                        <button type="button" id="sd-diary-back-btn" class="sd-diary-back">‹</button>
                        <div class="sd-diary-page-title" id="sd-diary-page-title">ไดอารี่ของ ${escapeHtml(getCharacterName())}</div>
                        <button type="button" id="sd-diary-fav-btn" class="sd-diary-fav-btn" title="ปักหน้านี้เป็นหน้าโปรด"><i class="fa-fw fa-solid fa-bookmark"></i></button>
                    </div>
                    <div class="sd-diary-swipe-area" id="sd-diary-swipe-area">
                        <button type="button" class="sd-diary-page-nav" id="sd-diary-prev-btn" title="หน้าก่อนหน้า"><i class="fa-fw fa-solid fa-chevron-left"></i></button>
                        <div id="sd-diary-reader-card"></div>
                        <button type="button" class="sd-diary-page-nav" id="sd-diary-next-btn" title="หน้าถัดไป"><i class="fa-fw fa-solid fa-chevron-right"></i></button>
                    </div>
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

            <div class="sd-subsection" style="margin-top:8px;">
                <h4 style="margin-top:0;">สำรอง/กู้คืนข้อมูลเนื้อเรื่อง</h4>
                <div class="sd-help">สำรองเธรด ไดอารี่ และปฏิทินในเรื่องทั้งหมดของแชทนี้เป็นไฟล์ .json แยกต่างหากจากไฟล์ตั้งค่า ใช้กู้คืนได้หากข้อมูลหาย หรือย้ายไปแชทอื่น การกู้คืนจะแทนที่ข้อมูลปัจจุบันทั้งหมด</div>
                <div class="sd-row sd-io-row">
                    <button type="button" class="menu_button" id="sd-state-export-btn">สำรองข้อมูลเนื้อเรื่อง</button>
                    <button type="button" class="menu_button" id="sd-state-import-btn">กู้คืนข้อมูลเนื้อเรื่อง</button>
                    <input type="file" id="sd-state-import-file" accept="application/json,.json" style="display:none" />
                </div>
            </div>

            <div id="sd-full-history" class="sd-full-history">${renderFullHistory(state)}</div>
        </div>

        <div class="sd-credit">Story Director — Purryverse</div>
    </div>`;
}

function makeDraft(cfg) {
    return {
        ...cfg,
        tags: [...cfg.tags],
        diaryDisabledCharacters: [...cfg.diaryDisabledCharacters],
        specialDates: cfg.specialDates.map((d) => ({ ...d })),
        customStickers: cfg.customStickers.map((s) => ({ ...s })),
        customSounds: cfg.customSounds.map((s) => ({ ...s })),
        eventPool: cfg.eventPool.map((p) => ({ ...p })),
        npcRoster: cfg.npcRoster.map((n) => ({ ...n })),
        secretsPool: cfg.secretsPool.map((s) => ({ ...s })),
    };
}

function wireLiveCapture(draft) {
    const fieldHandler = (e) => {
        const t = e.target;
        if (!t) return;
        if (t.classList && t.classList.contains("sd-diary-char-toggle")) {
            const name = t.dataset.charName;
            if (t.checked) draft.diaryDisabledCharacters = draft.diaryDisabledCharacters.filter((n) => n !== name);
            else if (!draft.diaryDisabledCharacters.includes(name)) draft.diaryDisabledCharacters.push(name);
            return;
        }
        if (!t.id) return;
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
            case "sd-thread-cooldown": draft.threadCooldownN = clampNum(t.value, 10, 1, 100); break;
            case "sd-time-skip-enabled": draft.timeSkipEnabled = t.checked; break;
            case "sd-followup-enabled": draft.followUpEnabled = t.checked; break;
            case "sd-followup-chance": draft.followUpChance = clampNum(t.value, 50, 0, 100); break;
            case "sd-followup-delay-min": draft.followUpDelayMin = clampNum(t.value, 2, 1, 50); break;
            case "sd-followup-delay-max": draft.followUpDelayMax = clampNum(t.value, 5, 1, 50); break;
            case "sd-followup-max-chain": draft.followUpMaxChain = clampNum(t.value, 2, 0, 10); break;
            case "sd-director-persona": draft.directorPersona = t.value; break;
            case "sd-anti-stagnation-enabled": draft.antiStagnationEnabled = t.checked; break;
            case "sd-npc-events-enabled": draft.npcEventsEnabled = t.checked; break;
            case "sd-npc-frequency": draft.npcFrequency = t.value; break;
            case "sd-secrets-enabled": draft.secretsEnabled = t.checked; break;
            case "sd-callback-enabled": draft.callbackEnabled = t.checked; break;
            case "sd-callback-min-age": draft.callbackMinAge = clampNum(t.value, 20, 5, 500); break;
            case "sd-story-arcs-enabled": draft.storyArcsEnabled = t.checked; break;
            case "sd-arc-min-length": draft.arcMinLength = clampNum(t.value, 8, 2, 50); break;
            case "sd-arc-max-length": draft.arcMaxLength = clampNum(t.value, 15, 2, 50); break;
            case "sd-recap-enabled": draft.recapEnabled = t.checked; break;
            case "sd-recap-gap-hours": draft.recapGapHours = clampNum(t.value, 24, 1, 720); break;
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
            case "sd-diary-weather-icon-enabled": draft.diaryWeatherIconEnabled = t.checked; break;
            case "sd-bond-enabled": draft.bondTrackingEnabled = t.checked; break;
            case "sd-calendar-start": draft.calendarStartDate = t.value; break;
            case "sd-diary-theme": {
                draft.diaryTheme = t.value;
                const shell = document.getElementById("sd-diary-shell");
                if (shell) shell.className = shell.className.replace(/\bsd-diary-theme-\S+/g, "").trim() + " sd-diary-theme-" + t.value;
                break;
            }
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

// -----------------------------------------------------------------------
// In-app beginner's guide — a draggable/resizable floating panel so the
// person can read it without leaving the extension or opening a separate
// file. Content mirrors GUIDE.md but is embedded here so it works offline
// with no extra fetch.
// -----------------------------------------------------------------------
function buildGuideBodyHtml() {
    return `
        <h2>ขั้นที่ 1: สิ่งที่ต้องทำก่อน (บังคับ)</h2>
        <ol>
            <li>ติดตั้งส่วนขยายให้เรียบร้อยตามหัวข้อ "วิธีติดตั้ง" ใน README.md</li>
            <li>เปิดเมนู Story Director จากไอคอนรูปอุ้งเท้าในเมนูส่วนขยาย</li>
            <li>แท็บ <b>ทั่วไป</b> → หัวข้อ "API สำหรับ Director" → เลือก Connection Profile ในช่อง "โปรไฟล์ API" → กด <b>ทดสอบ</b></li>
            <li>กด <b>บันทึก</b></li>
        </ol>
        <blockquote>อยากให้ Director ตัดสินใจทันที กดปุ่ม "เร่งให้ Director ตัดสินใจในข้อความถัดไป" ในแท็บทั่วไปได้</blockquote>

        <h2>ขั้นที่ 2: อะไรเปิดอยู่แล้วโดยไม่ต้องทำอะไรเพิ่ม</h2>
        <table>
            <tr><th>ฟีเจอร์</th><th>ทำอะไร</th></tr>
            <tr><td>ตัวช่วยกันเธรดจำเจ</td><td>เตือน Director ถ้าธีมเธรดซ้ำกันบ่อยเกินไป</td></tr>
            <tr><td>Time Skip</td><td>Director ข้ามเวลาได้เองเมื่อฉากจบลงเป็นธรรมชาติ</td></tr>
            <tr><td>ความเดิมตอนที่แล้วอัตโนมัติ</td><td>สรุปเธรดค้างให้เมื่อห่างหายไปนาน (เกิน 24 ชม.)</td></tr>
            <tr><td>Follow-up ต่อเนื่อง</td><td>เธรดที่เพิ่งดันคืบมีโอกาสถูกผูกคิวให้กลับมาต่อ</td></tr>
            <tr><td>เหตุการณ์ที่มี NPC เกี่ยวข้อง</td><td>Director ดึงตัวละครสมทบเข้ามาในเหตุการณ์</td></tr>
            <tr><td>ความลับของตัวละคร (Secrets)</td><td>เปิดไว้ แต่ยังไม่มีความลับจริงจนกว่าจะเพิ่มเอง</td></tr>
            <tr><td>Callback อดีต</td><td>หยิบรายละเอียดเก่ากลับมาเล่าใหม่เป็นครั้งคราว</td></tr>
            <tr><td>Story Arcs</td><td>Director วางแผนโครงเรื่องระยะยาวเอง</td></tr>
            <tr><td>สมุดไดอารี่</td><td>ตัวละครเขียนไดอารี่ตามความคืบหน้า</td></tr>
            <tr><td>ระบบความผูกพัน (Bond)</td><td>ประเมินค่าความผูกพันหลังทุกเหตุการณ์</td></tr>
            <tr><td>เสียงแจ้งเตือน</td><td>มีเสียงตอนมีเหตุการณ์ใหม่</td></tr>
        </table>

        <h2>ขั้นที่ 3: ปรับแต่งเบื้องต้นที่แนะนำ</h2>
        <p>อยู่ในแท็บ <b>ตั้งค่า</b> ทั้งหมด:</p>
        <ol>
            <li><b>ธีมที่อนุญาต</b> — เลือกแนวที่อยากให้เนื้อเรื่องไปทาง</li>
            <li><b>บุคลิก Director</b> — เลือกโทนการตัดสินใจ</li>
            <li><b>ความถี่ที่ Director จะพิจารณา</b> — ค่าเริ่มต้นสุ่ม 20% ทุกข้อความ</li>
            <li><b>ความรุนแรงของเหตุการณ์</b> และ <b>รูปแบบการนำเสนอ</b> — ปรับตามสไตล์ที่ชอบ</li>
        </ol>

        <h2>ขั้นที่ 4: ถ้ารู้สึกว่าเยอะเกินไป</h2>
        <p>ลองปิดกลุ่ม "เนื้อเรื่องขั้นสูง" เหล่านี้ก่อน แล้วค่อยเปิดกลับมาทีละอย่าง:</p>
        <ol>
            <li>ความลับของตัวละคร (Secrets)</li>
            <li>Callback อดีต</li>
            <li>โครงเรื่องระยะยาวแบบซีซั่น (Story Arcs)</li>
            <li>เหตุการณ์ที่มี NPC เกี่ยวข้อง</li>
        </ol>

        <h2>แผนที่ฟีเจอร์ — อยู่แท็บไหนบ้าง</h2>
        <ul>
            <li><b>ทั่วไป</b> — เปิด/ปิดระบบ, API, ปุ่มเร่ง Director, เสียง, นำเข้า/ส่งออก</li>
            <li><b>ตั้งค่า</b> — ธีม, บุคลิก, ความถี่/ความรุนแรง/การนำเสนอ, Time Skip, Follow-up, NPC, Secrets, Callback, Story Arcs, คลังเหตุการณ์, Prompt Preview</li>
            <li><b>เธรด</b> — อาร์คปัจจุบัน, แผนที่เธรด, เธรดที่ดำเนิน/ปิดแล้ว, ความลับที่ดำเนินอยู่, แผนที่ความผูกพัน/NPC</li>
            <li><b>ไดอารี่</b> — เปิด/ปิดไดอารี่, สติกเกอร์, ไอคอนสภาพอากาศ, ปฏิทิน, กราฟความผูกพัน, จดหมาย, วันสำคัญ, ธีมสี</li>
            <li><b>ประวัติ</b> — สถิติ+รายการเหตุการณ์, สำรอง/กู้คืนข้อมูล</li>
        </ul>

        <h2>แก้ปัญหาเบื้องต้น</h2>
        <ul>
            <li><b>Director ไม่ทำงานเลย</b> → เช็ค "เปิดใช้งานกับแชทนี้", เลือกโปรไฟล์ API, กด "ทดสอบ" ผ่าน, กด "บันทึก" แล้ว</li>
            <li><b>อยากให้เกิดเหตุการณ์เดี๋ยวนี้</b> → กด "เร่งให้ Director ตัดสินใจในข้อความถัดไป"</li>
            <li><b>ไดอารี่ไม่ถูกเขียน</b> → เช็ค "เปิดใช้สมุดไดอารี่" และตัวละครไม่ได้ถูกปิดไว้เป็นรายตัว</li>
            <li><b>เสียงไม่ดัง</b> → เช็คติ๊กเปิดเสียง และลองกด "ลองฟังเสียง"</li>
            <li><b>Secrets/Arc/Callback ยังไม่เกิด</b> → ขึ้นกับจังหวะที่ Director เห็นว่าเหมาะสม ไม่ได้เกิดทันที</li>
            <li><b>อยากดูข้อความที่ส่งให้ Director</b> → เปิด "Prompt Preview" ในแท็บตั้งค่า</li>
        </ul>
        <p style="opacity:0.7; font-size:0.9em;">รายละเอียดเพิ่มเติมของแต่ละฟีเจอร์ ดูได้ใน README.md</p>
    `;
}

function ensureGuideOverlay() {
    let overlay = document.getElementById("sd-guide-overlay");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "sd-guide-overlay";
    overlay.className = "sd-guide-overlay sd-hidden";
    overlay.innerHTML = `
        <div class="sd-guide-header" id="sd-guide-header">
            <span class="sd-guide-title">📘 คู่มือเริ่มต้นใช้งาน</span>
            <div class="sd-guide-header-actions">
                <button type="button" id="sd-guide-min-btn" title="ย่อ/ขยาย"><i class="fa-fw fa-solid fa-window-minimize"></i></button>
                <button type="button" id="sd-guide-close-btn" title="ปิด"><i class="fa-fw fa-solid fa-xmark"></i></button>
            </div>
        </div>
        <div class="sd-guide-body" id="sd-guide-body">${buildGuideBodyHtml()}</div>
        <div class="sd-guide-resize-handle" id="sd-guide-resize-handle"></div>`;
    document.body.appendChild(overlay);

    const header = overlay.querySelector("#sd-guide-header");
    const minBtn = overlay.querySelector("#sd-guide-min-btn");
    const closeBtn = overlay.querySelector("#sd-guide-close-btn");
    const resizeHandle = overlay.querySelector("#sd-guide-resize-handle");

    // Drag by the header, pointer events cover mouse + touch in one code path.
    let dragging = false, dragStartX = 0, dragStartY = 0, dragOrigLeft = 0, dragOrigTop = 0;
    header.addEventListener("pointerdown", (e) => {
        if (e.target.closest("button")) return;
        dragging = true;
        const rect = overlay.getBoundingClientRect();
        dragStartX = e.clientX; dragStartY = e.clientY;
        dragOrigLeft = rect.left; dragOrigTop = rect.top;
        overlay.style.left = `${rect.left}px`;
        overlay.style.top = `${rect.top}px`;
        overlay.style.right = "auto";
        overlay.style.bottom = "auto";
        try { header.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    });
    header.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const dx = e.clientX - dragStartX, dy = e.clientY - dragStartY;
        const maxLeft = window.innerWidth - 60, maxTop = window.innerHeight - 40;
        overlay.style.left = `${Math.max(-100, Math.min(maxLeft, dragOrigLeft + dx))}px`;
        overlay.style.top = `${Math.max(0, Math.min(maxTop, dragOrigTop + dy))}px`;
    });
    const endDrag = () => { dragging = false; };
    header.addEventListener("pointerup", endDrag);
    header.addEventListener("pointercancel", endDrag);

    // Resize from the bottom-right corner handle, same pointer-event approach.
    let resizing = false, resizeStartX = 0, resizeStartY = 0, resizeStartW = 0, resizeStartH = 0;
    resizeHandle.addEventListener("pointerdown", (e) => {
        resizing = true;
        const rect = overlay.getBoundingClientRect();
        resizeStartX = e.clientX; resizeStartY = e.clientY;
        resizeStartW = rect.width; resizeStartH = rect.height;
        try { resizeHandle.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
        e.stopPropagation();
    });
    resizeHandle.addEventListener("pointermove", (e) => {
        if (!resizing) return;
        const newW = Math.max(260, Math.min(window.innerWidth - 16, resizeStartW + (e.clientX - resizeStartX)));
        const newH = Math.max(160, Math.min(window.innerHeight - 16, resizeStartH + (e.clientY - resizeStartY)));
        overlay.style.width = `${newW}px`;
        overlay.style.height = `${newH}px`;
    });
    const endResize = () => { resizing = false; };
    resizeHandle.addEventListener("pointerup", endResize);
    resizeHandle.addEventListener("pointercancel", endResize);

    minBtn.addEventListener("click", () => {
        overlay.classList.toggle("sd-guide-minimized");
        const icon = minBtn.querySelector("i");
        if (icon) icon.className = overlay.classList.contains("sd-guide-minimized") ? "fa-fw fa-solid fa-window-maximize" : "fa-fw fa-solid fa-window-minimize";
    });
    closeBtn.addEventListener("click", () => overlay.classList.add("sd-hidden"));

    return overlay;
}

function toggleGuideOverlay() {
    const overlay = ensureGuideOverlay();
    overlay.classList.toggle("sd-hidden");
    if (!overlay.classList.contains("sd-hidden")) {
        overlay.classList.remove("sd-guide-minimized");
        // Normalize the CSS-anchored starting position (top/right) into explicit
        // left/top the first time it's actually visible — getBoundingClientRect
        // would read zeros while display:none, so this can't happen at creation.
        if (!overlay.dataset.positioned) {
            const rect = overlay.getBoundingClientRect();
            overlay.style.left = `${rect.left}px`;
            overlay.style.top = `${rect.top}px`;
            overlay.style.right = "auto";
            overlay.dataset.positioned = "1";
        }
    }
}

function wireQuickActions(cfg, draft, state) {
    const handler = (e) => {
        const target = e.target.closest ? e.target.closest("#sd-force-btn, #sd-sound-test-btn, #sd-api-test-btn, #sd-clear-log-btn, #sd-preview-director-btn, #sd-guide-btn") : null;
        if (!target) return;

        if (target.id === "sd-guide-btn") {
            toggleGuideOverlay();
            return;
        }
        if (target.id === "sd-force-btn") {
            state.forceNextCheck = true;
            saveChatState();
            notify("ตั้งค่าแล้ว: Director จะตัดสินใจทันทีหลังข้อความถัดไปของตัวละคร");
        } else if (target.id === "sd-sound-test-btn") {
            playEventSound(draft.soundStyle, draft.customSounds);
        } else if (target.id === "sd-api-test-btn") {
            if (!draft.apiProfileId) { notify("กรุณาเลือกโปรไฟล์ API ก่อน", true); return; }
            if (cfg.apiProfileId !== draft.apiProfileId) { cfg.apiProfileId = draft.apiProfileId; saveSettingsDebounced(); }
            const btn = target;
            const originalLabel = btn.textContent;
            btn.disabled = true;
            btn.textContent = "กำลังทดสอบ...";
            notify("กำลังทดสอบการเชื่อมต่อ...");
            requestSeparateGeneration(cfg, "Reply with exactly one word: OK", 10).then((result) => {
                if (result) notify(`เชื่อมต่อสำเร็จ — คำตอบที่ได้: "${truncateText(result.trim(), 60)}"`);
                else notify("การเชื่อมต่อล้มเหลว ดู console (F12)", true);
            }).finally(() => {
                btn.disabled = false;
                btn.textContent = originalLabel;
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

function renderDiaryReaderInto(state, entry, animateDirection) {
    const card = document.getElementById("sd-diary-reader-card");
    const titleEl = document.getElementById("sd-diary-page-title");
    const favBtn = document.getElementById("sd-diary-fav-btn");
    const readerView = document.getElementById("sd-diary-reader-view");
    if (readerView) readerView.dataset.currentEntryId = entry.id;
    if (titleEl) titleEl.textContent = `ไดอารี่ของ ${entry.characterName || getCharacterName()}`;
    if (favBtn) favBtn.classList.toggle("active", !!entry.favorite);
    if (!card) return;

    const applyContent = () => { card.innerHTML = renderDiaryReader(entry); };

    if (animateDirection) {
        card.classList.remove("sd-page-turn-next", "sd-page-turn-prev");
        void card.offsetWidth; // restart animation on repeated swipes
        card.classList.add(animateDirection > 0 ? "sd-page-turn-next" : "sd-page-turn-prev");
        applyContent();
        card.addEventListener("animationend", () => {
            card.classList.remove("sd-page-turn-next", "sd-page-turn-prev");
        }, { once: true });
    } else {
        applyContent();
    }
}

function openDiaryEntryById(state, entryId) {
    const entry = state.diaryLog.find((en) => en.id === entryId);
    if (!entry) return;
    entry.read = true;
    saveChatState();
    document.getElementById("sd-diary-badge")?.remove();
    renderDiaryReaderInto(state, entry);
    document.getElementById("sd-diary-list-view")?.classList.add("sd-hidden");
    document.getElementById("sd-diary-reader-view")?.classList.remove("sd-hidden");
}

function navigateDiaryReader(state, direction) {
    const readerView = document.getElementById("sd-diary-reader-view");
    const currentId = readerView?.dataset.currentEntryId;
    if (!currentId) return;
    const order = getDiaryDisplayOrder(state);
    const idx = order.findIndex((e) => e.id === currentId);
    if (idx === -1) return;
    const nextIdx = idx + direction;
    if (nextIdx < 0 || nextIdx >= order.length) {
        const card = document.getElementById("sd-diary-reader-card");
        card?.classList.add("sd-page-bounce");
        setTimeout(() => card?.classList.remove("sd-page-bounce"), 220);
        return;
    }
    const nextEntry = order[nextIdx];
    nextEntry.read = true;
    saveChatState();
    document.getElementById("sd-diary-badge")?.remove();
    renderDiaryReaderInto(state, nextEntry, direction);
}

function wireDiaryNav(state) {
    const handler = (e) => {
        const row = e.target.closest ? e.target.closest(".sd-diary-list-row") : null;
        const dot = e.target.closest ? e.target.closest(".sd-mood-dot") : null;
        const backBtn = e.target.closest ? e.target.closest("#sd-diary-back-btn") : null;
        if (row) {
            openDiaryEntryById(state, row.dataset.entryId);
        } else if (dot) {
            openDiaryEntryById(state, dot.dataset.entryId);
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

function wireDiarySwipe(state) {
    let startX = 0, startY = 0, tracking = false;
    const threshold = 40;

    const onTouchStart = (e) => {
        const area = e.target.closest ? e.target.closest("#sd-diary-swipe-area") : null;
        if (!area || !e.touches || !e.touches[0]) return;
        tracking = true;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
    };
    const onTouchEnd = (e) => {
        if (!tracking) return;
        tracking = false;
        const touch = e.changedTouches && e.changedTouches[0];
        if (!touch) return;
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        if (Math.abs(dx) > threshold && Math.abs(dx) > Math.abs(dy) * 1.5) {
            navigateDiaryReader(state, dx < 0 ? 1 : -1);
        }
    };
    const clickHandler = (e) => {
        const nextBtn = e.target.closest ? e.target.closest("#sd-diary-next-btn") : null;
        const prevBtn = e.target.closest ? e.target.closest("#sd-diary-prev-btn") : null;
        const favBtn = e.target.closest ? e.target.closest("#sd-diary-fav-btn") : null;
        if (nextBtn) { navigateDiaryReader(state, 1); return; }
        if (prevBtn) { navigateDiaryReader(state, -1); return; }
        if (favBtn) {
            const readerView = document.getElementById("sd-diary-reader-view");
            const currentId = readerView?.dataset.currentEntryId;
            if (!currentId) return;
            const entry = toggleDiaryFavorite(state, currentId);
            if (entry) favBtn.classList.toggle("active", !!entry.favorite);
        }
    };
    document.addEventListener("touchstart", onTouchStart, true);
    document.addEventListener("touchend", onTouchEnd, true);
    document.addEventListener("click", clickHandler, true);
    return () => {
        document.removeEventListener("touchstart", onTouchStart, true);
        document.removeEventListener("touchend", onTouchEnd, true);
        document.removeEventListener("click", clickHandler, true);
    };
}

function wireDiaryCalendarAndFilter(cfg, state) {
    let searchDebounceTimer = null;
    const clickHandler = (e) => {
        const prevBtn = e.target.closest ? e.target.closest("#sd-cal-prev") : null;
        const nextBtn = e.target.closest ? e.target.closest("#sd-cal-next") : null;
        const dayCell = e.target.closest ? e.target.closest(".sd-cal-cell[data-cal-date]") : null;
        const favFilterBtn = e.target.closest ? e.target.closest("#sd-diary-fav-filter-btn") : null;
        const loadMoreBtn = e.target.closest ? e.target.closest("#sd-diary-load-more-btn") : null;
        const searchClearBtn = e.target.closest ? e.target.closest("#sd-diary-search-clear-btn") : null;
        if (searchClearBtn) {
            state.diarySearchQuery = "";
            const inputEl = document.getElementById("sd-diary-search-input");
            if (inputEl) inputEl.value = "";
            resetDiaryListLimit();
            saveChatState();
            refreshDiaryDynamicPanels(cfg, state);
            return;
        }
        if (loadMoreBtn) {
            diaryListRenderLimit += DIARY_LIST_PAGE_SIZE;
            refreshDiaryDynamicPanels(cfg, state);
            return;
        }
        if (favFilterBtn) {
            state.diaryFilterFavoriteOnly = !state.diaryFilterFavoriteOnly;
            favFilterBtn.classList.toggle("active", state.diaryFilterFavoriteOnly);
            resetDiaryListLimit();
            saveChatState();
            refreshDiaryDynamicPanels(cfg, state);
            return;
        }
        if (prevBtn || nextBtn) {
            const viewDate = getCalendarViewDate(cfg, state);
            viewDate.setMonth(viewDate.getMonth() + (nextBtn ? 1 : -1));
            state.calendarViewYear = viewDate.getFullYear();
            state.calendarViewMonth = viewDate.getMonth();
            saveChatState();
            const calEl = document.getElementById("sd-diary-calendar");
            if (calEl) calEl.innerHTML = renderDiaryCalendar(cfg, state);
            return;
        }
        if (dayCell) {
            const date = dayCell.dataset.calDate;
            state.diaryFilterDate = state.diaryFilterDate === date ? null : date;
            resetDiaryListLimit();
            saveChatState();
            refreshDiaryDynamicPanels(cfg, state);
        }
    };
    const changeHandler = (e) => {
        if (e.target.id === "sd-diary-char-filter") {
            state.diaryFilterCharacter = e.target.value || null;
            resetDiaryListLimit();
            saveChatState();
            refreshDiaryDynamicPanels(cfg, state);
        }
    };
    const inputHandler = (e) => {
        if (e.target.id !== "sd-diary-search-input") return;
        clearTimeout(searchDebounceTimer);
        const value = e.target.value;
        searchDebounceTimer = setTimeout(() => {
            state.diarySearchQuery = value;
            resetDiaryListLimit();
            saveChatState();
            const listEl = document.getElementById("sd-diary-list");
            if (listEl) listEl.innerHTML = renderDiaryList(state);
            const clearBtnHost = e.target.parentElement;
            if (clearBtnHost && !document.getElementById("sd-diary-search-clear-btn") && value) {
                clearBtnHost.insertAdjacentHTML("beforeend", `<button type="button" class="menu_button" id="sd-diary-search-clear-btn" title="ล้างคำค้นหา"><i class="fa-fw fa-solid fa-xmark"></i></button>`);
            } else if (!value) {
                document.getElementById("sd-diary-search-clear-btn")?.remove();
            }
        }, 250);
    };
    document.addEventListener("click", clickHandler, true);
    document.addEventListener("change", changeHandler, true);
    document.addEventListener("input", inputHandler, true);
    return () => {
        document.removeEventListener("click", clickHandler, true);
        document.removeEventListener("change", changeHandler, true);
        document.removeEventListener("input", inputHandler, true);
    };
}

function wireThreadActions(state) {
    const handler = async (e) => {
        const pinBtn = e.target.closest ? e.target.closest(".sd-thread-pin-btn") : null;
        const closeBtn = e.target.closest ? e.target.closest(".sd-thread-close-btn") : null;
        const linkBtn = e.target.closest ? e.target.closest(".sd-thread-link-btn") : null;
        const mapNode = e.target.closest ? e.target.closest(".sd-thread-map-node") : null;
        const secretRevealBtn = e.target.closest ? e.target.closest(".sd-secret-reveal-btn") : null;
        if (secretRevealBtn) {
            const secret = (state.secrets || []).find((s) => s.id === secretRevealBtn.dataset.secretId);
            if (!secret) return;
            const confirmed = await callGenericPopup(
                `ยืนยันเฉลยความลับของ ${escapeHtml(secret.characterName)} ทันทีหรือไม่? การกระทำนี้ย้อนกลับไม่ได้`,
                POPUP_TYPE.CONFIRM, "", { okButton: "เฉลยเลย", cancelButton: "ยกเลิก" }
            );
            if (!confirmed) return;
            const revealed = forceRevealSecret(state, secretRevealBtn.dataset.secretId);
            if (revealed) {
                notify(`เฉลยความลับของ ${revealed.characterName} แล้ว`);
                refreshOpenPopupPanels(state);
            }
            return;
        }
        if (mapNode) {
            const row = document.querySelector(`.sd-thread-row[data-thread-id="${mapNode.dataset.threadId}"]`);
            if (row) {
                row.scrollIntoView({ behavior: "smooth", block: "center" });
                row.classList.add("sd-thread-row-flash");
                setTimeout(() => row.classList.remove("sd-thread-row-flash"), 900);
            }
            return;
        }
        if (pinBtn) {
            const thread = toggleThreadPin(state, pinBtn.dataset.threadId);
            if (thread) {
                notify(thread.pinned ? `ปักหมุดเธรด "${thread.title}" แล้ว` : `ถอดหมุดเธรด "${thread.title}" แล้ว`);
                refreshOpenPopupPanels(state);
            }
            return;
        }
        if (linkBtn) {
            document.getElementById(`sd-thread-link-panel-${linkBtn.dataset.threadId}`)?.classList.toggle("sd-hidden");
            return;
        }
        if (closeBtn) {
            const thread = state.activeThreads.find((t) => t.id === closeBtn.dataset.threadId);
            if (!thread) return;
            const confirmed = await callGenericPopup(
                `ยืนยันปิดเธรด "${escapeHtml(thread.title)}" ทันทีหรือไม่? การกระทำนี้ย้อนกลับไม่ได้`,
                POPUP_TYPE.CONFIRM, "", { okButton: "ปิดเธรด", cancelButton: "ยกเลิก" }
            );
            if (!confirmed) return;
            const closed = forceCloseThread(state, closeBtn.dataset.threadId);
            if (closed) {
                notify(`ปิดเธรด "${closed.title}" แล้ว`);
                refreshOpenPopupPanels(state);
            }
        }
    };
    const changeHandler = (e) => {
        if (e.target.classList && e.target.classList.contains("sd-thread-link-checkbox")) {
            toggleThreadLink(state, e.target.dataset.threadId, e.target.dataset.otherId);
            refreshOpenPopupPanels(state);
        }
    };
    document.addEventListener("click", handler, true);
    document.addEventListener("change", changeHandler, true);
    return () => {
        document.removeEventListener("click", handler, true);
        document.removeEventListener("change", changeHandler, true);
    };
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
            diaryDisabledCharacters: cfg.diaryDisabledCharacters, diaryTheme: cfg.diaryTheme, customStickers: cfg.customStickers,
            diaryWeatherIconEnabled: cfg.diaryWeatherIconEnabled, customSounds: cfg.customSounds, bondTrackingEnabled: cfg.bondTrackingEnabled,
            calendarStartDate: cfg.calendarStartDate, specialDates: cfg.specialDates, threadCooldownN: cfg.threadCooldownN,
            eventPool: cfg.eventPool, timeSkipEnabled: cfg.timeSkipEnabled,
            followUpEnabled: cfg.followUpEnabled, followUpChance: cfg.followUpChance,
            followUpDelayMin: cfg.followUpDelayMin, followUpDelayMax: cfg.followUpDelayMax, followUpMaxChain: cfg.followUpMaxChain,
            apiMaxTokensDirector: cfg.apiMaxTokensDirector, apiMaxTokensDiary: cfg.apiMaxTokensDiary,
            directorPersona: cfg.directorPersona, antiStagnationEnabled: cfg.antiStagnationEnabled,
            npcEventsEnabled: cfg.npcEventsEnabled, npcFrequency: cfg.npcFrequency, npcRoster: cfg.npcRoster,
            secretsEnabled: cfg.secretsEnabled, secretsPool: cfg.secretsPool,
            callbackEnabled: cfg.callbackEnabled, callbackMinAge: cfg.callbackMinAge,
            storyArcsEnabled: cfg.storyArcsEnabled, arcMinLength: cfg.arcMinLength, arcMaxLength: cfg.arcMaxLength,
            recapEnabled: cfg.recapEnabled, recapGapHours: cfg.recapGapHours,
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
    if (!Array.isArray(draft.diaryDisabledCharacters)) draft.diaryDisabledCharacters = [];
    if (!Array.isArray(draft.specialDates)) draft.specialDates = [];
    if (!Array.isArray(draft.customStickers)) draft.customStickers = [];
    if (!Array.isArray(draft.customSounds)) draft.customSounds = [];
    if (!Array.isArray(draft.eventPool)) draft.eventPool = [];
    if (!Array.isArray(draft.npcRoster)) draft.npcRoster = [];
    if (!Array.isArray(draft.secretsPool)) draft.secretsPool = [];
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
    setValue("sd-thread-cooldown", cfg.threadCooldownN);
    setChecked("sd-time-skip-enabled", cfg.timeSkipEnabled);
    setChecked("sd-followup-enabled", cfg.followUpEnabled);
    setValue("sd-followup-chance", cfg.followUpChance);
    setValue("sd-followup-delay-min", cfg.followUpDelayMin);
    setValue("sd-followup-delay-max", cfg.followUpDelayMax);
    setValue("sd-followup-max-chain", cfg.followUpMaxChain);
    setValue("sd-director-persona", cfg.directorPersona);
    setChecked("sd-anti-stagnation-enabled", cfg.antiStagnationEnabled);
    setChecked("sd-npc-events-enabled", cfg.npcEventsEnabled);
    setValue("sd-npc-frequency", cfg.npcFrequency);
    const npcListEl = document.getElementById("sd-npc-roster-list");
    if (npcListEl) npcListEl.innerHTML = renderNpcRosterRows(cfg.npcRoster);
    const poolListEl = document.getElementById("sd-event-pool-list");
    if (poolListEl) poolListEl.innerHTML = renderEventPoolRows(cfg.eventPool);
    setChecked("sd-secrets-enabled", cfg.secretsEnabled);
    const secretsListEl = document.getElementById("sd-secrets-pool-list");
    if (secretsListEl) secretsListEl.innerHTML = renderSecretsPoolRows(cfg.secretsPool);
    setChecked("sd-callback-enabled", cfg.callbackEnabled);
    setValue("sd-callback-min-age", cfg.callbackMinAge);
    setChecked("sd-story-arcs-enabled", cfg.storyArcsEnabled);
    setValue("sd-arc-min-length", cfg.arcMinLength);
    setValue("sd-arc-max-length", cfg.arcMaxLength);
    setChecked("sd-recap-enabled", cfg.recapEnabled);
    setValue("sd-recap-gap-hours", cfg.recapGapHours);
    setChecked("sd-sound-enabled", cfg.soundEnabled);
    const soundStyleEl = document.getElementById("sd-sound-style");
    if (soundStyleEl) soundStyleEl.innerHTML = renderSoundStyleOptions(cfg);
    const soundListEl = document.getElementById("sd-custom-sounds-list");
    if (soundListEl) soundListEl.innerHTML = renderCustomSoundRows(cfg.customSounds);
    setChecked("sd-diary-enabled", cfg.diaryEnabled);
    setValue("sd-diary-advance-chance", cfg.diaryAdvanceChance);
    setChecked("sd-diary-stickers-enabled", cfg.diaryStickersEnabled);
    setChecked("sd-diary-banner-enabled", cfg.diaryBannerEnabled);
    setChecked("sd-diary-weather-icon-enabled", cfg.diaryWeatherIconEnabled);
    setChecked("sd-bond-enabled", cfg.bondTrackingEnabled);
    setValue("sd-calendar-start", cfg.calendarStartDate);
    setValue("sd-diary-theme", cfg.diaryTheme);
    setValue("sd-api-max-director", cfg.apiMaxTokensDirector);
    setValue("sd-api-max-diary", cfg.apiMaxTokensDiary);
    document.querySelectorAll(".sd-tag").forEach((el) => el.classList.toggle("active", cfg.tags.includes(el.dataset.tag)));
    document.querySelectorAll(".sd-diary-char-toggle").forEach((el) => { el.checked = !cfg.diaryDisabledCharacters.includes(el.dataset.charName); });
    const specialListEl = document.getElementById("sd-special-dates-list");
    if (specialListEl) specialListEl.innerHTML = renderSpecialDatesRows(cfg.specialDates);
    const stickerListEl = document.getElementById("sd-custom-stickers-list");
    if (stickerListEl) stickerListEl.innerHTML = renderCustomStickerRows(cfg.customStickers);
    const shell = document.getElementById("sd-diary-shell");
    if (shell) shell.className = shell.className.replace(/\bsd-diary-theme-\S+/g, "").trim() + " sd-diary-theme-" + cfg.diaryTheme;
}

function wireEventPool(draft) {
    const handler = (e) => {
        const addBtn = e.target.closest ? e.target.closest("#sd-pool-add-btn") : null;
        const removeBtn = e.target.closest ? e.target.closest(".sd-pool-remove-btn") : null;
        if (addBtn) {
            const titleEl = document.getElementById("sd-pool-title");
            const detailEl = document.getElementById("sd-pool-detail");
            const title = (titleEl?.value || "").trim();
            const detail = (detailEl?.value || "").trim();
            if (!title || !detail) { notify("กรอกชื่อและรายละเอียดเหตุการณ์ให้ครบก่อน", true); return; }
            draft.eventPool.push({ id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())), title, detail });
            if (titleEl) titleEl.value = "";
            if (detailEl) detailEl.value = "";
            const listEl = document.getElementById("sd-event-pool-list");
            if (listEl) listEl.innerHTML = renderEventPoolRows(draft.eventPool);
            return;
        }
        if (removeBtn) {
            draft.eventPool = draft.eventPool.filter((p) => p.id !== removeBtn.dataset.poolId);
            const listEl = document.getElementById("sd-event-pool-list");
            if (listEl) listEl.innerHTML = renderEventPoolRows(draft.eventPool);
        }
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
}

function wireNpcRoster(draft) {
    const handler = (e) => {
        const addBtn = e.target.closest ? e.target.closest("#sd-npc-add-btn") : null;
        const removeBtn = e.target.closest ? e.target.closest(".sd-npc-remove-btn") : null;
        if (addBtn) {
            const nameEl = document.getElementById("sd-npc-name");
            const roleEl = document.getElementById("sd-npc-role");
            const name = (nameEl?.value || "").trim();
            const role = (roleEl?.value || "").trim();
            if (!name) { notify("กรอกชื่อ NPC ก่อน", true); return; }
            draft.npcRoster.push({ id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())), name, role });
            if (nameEl) nameEl.value = "";
            if (roleEl) roleEl.value = "";
            const listEl = document.getElementById("sd-npc-roster-list");
            if (listEl) listEl.innerHTML = renderNpcRosterRows(draft.npcRoster);
            return;
        }
        if (removeBtn) {
            draft.npcRoster = draft.npcRoster.filter((n) => n.id !== removeBtn.dataset.npcId);
            const listEl = document.getElementById("sd-npc-roster-list");
            if (listEl) listEl.innerHTML = renderNpcRosterRows(draft.npcRoster);
        }
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
}

function wireSecretsPool(draft) {
    const handler = (e) => {
        const addBtn = e.target.closest ? e.target.closest("#sd-secret-add-btn") : null;
        const removeBtn = e.target.closest ? e.target.closest(".sd-secret-pool-remove-btn") : null;
        if (addBtn) {
            const charEl = document.getElementById("sd-secret-character");
            const textEl = document.getElementById("sd-secret-text");
            const characterName = (charEl?.value || "").trim();
            const text = (textEl?.value || "").trim();
            if (!characterName) { notify("กรอกชื่อตัวละคร/NPC เจ้าของความลับก่อน", true); return; }
            draft.secretsPool.push({ id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())), characterName, text });
            if (charEl) charEl.value = "";
            if (textEl) textEl.value = "";
            const listEl = document.getElementById("sd-secrets-pool-list");
            if (listEl) listEl.innerHTML = renderSecretsPoolRows(draft.secretsPool);
            return;
        }
        if (removeBtn) {
            draft.secretsPool = draft.secretsPool.filter((p) => p.id !== removeBtn.dataset.secretPoolId);
            const listEl = document.getElementById("sd-secrets-pool-list");
            if (listEl) listEl.innerHTML = renderSecretsPoolRows(draft.secretsPool);
        }
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
}

function wireSpecialDates(draft) {
    const handler = (e) => {
        const addBtn = e.target.closest ? e.target.closest("#sd-special-date-add-btn") : null;
        const removeBtn = e.target.closest ? e.target.closest(".sd-special-date-remove-btn") : null;
        if (addBtn) {
            const labelEl = document.getElementById("sd-special-date-label");
            const dateEl = document.getElementById("sd-special-date-value");
            const label = (labelEl?.value || "").trim();
            const date = dateEl?.value || "";
            if (!label || !date) { notify("กรอกชื่อวันและวันที่ให้ครบก่อน", true); return; }
            draft.specialDates.push({ id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())), label, date });
            if (labelEl) labelEl.value = "";
            if (dateEl) dateEl.value = "";
            const listEl = document.getElementById("sd-special-dates-list");
            if (listEl) listEl.innerHTML = renderSpecialDatesRows(draft.specialDates);
            return;
        }
        if (removeBtn) {
            draft.specialDates = draft.specialDates.filter((d) => d.id !== removeBtn.dataset.specialId);
            const listEl = document.getElementById("sd-special-dates-list");
            if (listEl) listEl.innerHTML = renderSpecialDatesRows(draft.specialDates);
        }
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
}

function wireScheduledLetters(state) {
    const handler = (e) => {
        const addBtn = e.target.closest ? e.target.closest("#sd-letter-add-btn") : null;
        const removeBtn = e.target.closest ? e.target.closest(".sd-letter-remove-btn") : null;
        if (addBtn) {
            const toEl = document.getElementById("sd-letter-to");
            const dateEl = document.getElementById("sd-letter-date");
            const bodyEl = document.getElementById("sd-letter-body");
            const toCharacter = (toEl?.value || getCharacterName() || "").trim();
            const deliveryDateIso = dateEl?.value || "";
            const body = (bodyEl?.value || "").trim();
            if (!toCharacter || !deliveryDateIso || !body) { notify("กรอกผู้รับ วันที่ และเนื้อความให้ครบก่อน", true); return; }
            if (state.scheduledLetters.length >= MAX_SCHEDULED_LETTERS) { notify(`ตั้งจดหมายได้สูงสุด ${MAX_SCHEDULED_LETTERS} ฉบับ`, true); return; }
            state.scheduledLetters.push({
                id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
                toCharacter, body, deliveryDateIso, delivered: false, createdAtIso: new Date().toISOString(),
            });
            if (bodyEl) bodyEl.value = "";
            if (dateEl) dateEl.value = "";
            saveChatState();
            const listEl = document.getElementById("sd-letters-list");
            if (listEl) listEl.innerHTML = renderScheduledLettersRows(state);
            notify("ตั้งเวลาส่งจดหมายแล้ว");
            return;
        }
        if (removeBtn) {
            state.scheduledLetters = state.scheduledLetters.filter((l) => l.id !== removeBtn.dataset.letterId);
            saveChatState();
            const listEl = document.getElementById("sd-letters-list");
            if (listEl) listEl.innerHTML = renderScheduledLettersRows(state);
        }
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
}

function wireCustomStickers(draft) {
    let pendingDataUrl = null;
    let pendingSize = 0;

    const resetPreview = () => {
        pendingDataUrl = null;
        pendingSize = 0;
        document.getElementById("sd-custom-sticker-preview")?.classList.add("sd-hidden");
        const labelEl = document.getElementById("sd-custom-sticker-label");
        const fileEl = document.getElementById("sd-custom-sticker-file");
        if (labelEl) labelEl.value = "";
        if (fileEl) fileEl.value = "";
    };

    const clickHandler = (e) => {
        const pickBtn = e.target.closest ? e.target.closest("#sd-custom-sticker-pick-btn") : null;
        const addBtn = e.target.closest ? e.target.closest("#sd-custom-sticker-add-btn") : null;
        const cancelBtn = e.target.closest ? e.target.closest("#sd-custom-sticker-cancel-btn") : null;
        const removeBtn = e.target.closest ? e.target.closest(".sd-custom-sticker-remove-btn") : null;

        if (pickBtn) {
            document.getElementById("sd-custom-sticker-file")?.click();
            return;
        }
        if (cancelBtn) {
            resetPreview();
            return;
        }
        if (addBtn) {
            const labelEl = document.getElementById("sd-custom-sticker-label");
            const label = (labelEl?.value || "").trim();
            if (!label || !pendingDataUrl) { notify("ใส่คำสำคัญของอารมณ์และเลือกรูปจากแกลเลอรี่ก่อน", true); return; }
            if (draft.customStickers.length >= MAX_CUSTOM_STICKERS) { notify(`เพิ่มได้สูงสุด ${MAX_CUSTOM_STICKERS} รูป`, true); return; }
            draft.customStickers.push({ id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())), label, dataUrl: pendingDataUrl });
            const listEl = document.getElementById("sd-custom-stickers-list");
            if (listEl) listEl.innerHTML = renderCustomStickerRows(draft.customStickers);
            resetPreview();
            return;
        }
        if (removeBtn) {
            draft.customStickers = draft.customStickers.filter((s) => s.id !== removeBtn.dataset.stickerId);
            const listEl = document.getElementById("sd-custom-stickers-list");
            if (listEl) listEl.innerHTML = renderCustomStickerRows(draft.customStickers);
        }
    };

    const fileHandler = (e) => {
        if (e.target.id !== "sd-custom-sticker-file") return;
        const file = e.target.files?.[0];
        if (!file) return;
        if (draft.customStickers.length >= MAX_CUSTOM_STICKERS) { notify(`เพิ่มได้สูงสุด ${MAX_CUSTOM_STICKERS} รูป`, true); e.target.value = ""; return; }
        if (file.size > MAX_CUSTOM_STICKER_BYTES) { notify("ไฟล์ใหญ่เกิน 150KB กรุณาเลือกไฟล์เล็กกว่านี้", true); e.target.value = ""; return; }
        const reader = new FileReader();
        reader.onload = () => {
            pendingDataUrl = reader.result;
            pendingSize = file.size;
            const previewEl = document.getElementById("sd-custom-sticker-preview");
            const imgEl = document.getElementById("sd-custom-sticker-preview-img");
            const nameEl = document.getElementById("sd-custom-sticker-preview-name");
            if (imgEl) imgEl.src = pendingDataUrl;
            if (nameEl) nameEl.textContent = `${file.name} (${Math.round(pendingSize / 1024)}KB)`;
            previewEl?.classList.remove("sd-hidden");
        };
        reader.onerror = () => notify("อ่านไฟล์รูปไม่สำเร็จ", true);
        reader.readAsDataURL(file);
    };

    document.addEventListener("click", clickHandler, true);
    document.addEventListener("change", fileHandler, true);
    return () => {
        document.removeEventListener("click", clickHandler, true);
        document.removeEventListener("change", fileHandler, true);
    };
}

function refreshSoundStyleSelect(cfg) {
    const el = document.getElementById("sd-sound-style");
    if (el) el.innerHTML = renderSoundStyleOptions(cfg);
}

function wireCustomSounds(draft) {
    let pendingDataUrl = null;
    let pendingName = "";

    const resetPreview = () => {
        pendingDataUrl = null;
        pendingName = "";
        document.getElementById("sd-custom-sound-preview")?.classList.add("sd-hidden");
        const labelEl = document.getElementById("sd-custom-sound-label");
        const fileEl = document.getElementById("sd-custom-sound-file");
        if (labelEl) labelEl.value = "";
        if (fileEl) fileEl.value = "";
    };

    const clickHandler = (e) => {
        const pickBtn = e.target.closest ? e.target.closest("#sd-custom-sound-pick-btn") : null;
        const addBtn = e.target.closest ? e.target.closest("#sd-custom-sound-add-btn") : null;
        const cancelBtn = e.target.closest ? e.target.closest("#sd-custom-sound-cancel-btn") : null;
        const previewPlayBtn = e.target.closest ? e.target.closest("#sd-custom-sound-preview-play-btn") : null;
        const playBtn = e.target.closest ? e.target.closest(".sd-custom-sound-play-btn") : null;
        const removeBtn = e.target.closest ? e.target.closest(".sd-custom-sound-remove-btn") : null;

        if (pickBtn) { document.getElementById("sd-custom-sound-file")?.click(); return; }
        if (cancelBtn) { resetPreview(); return; }
        if (previewPlayBtn) {
            if (pendingDataUrl) new Audio(pendingDataUrl).play().catch(() => {});
            return;
        }
        if (playBtn) {
            const custom = draft.customSounds.find((s) => s.id === playBtn.dataset.soundId);
            if (custom) new Audio(custom.dataUrl).play().catch(() => {});
            return;
        }
        if (addBtn) {
            const labelEl = document.getElementById("sd-custom-sound-label");
            const label = (labelEl?.value || "").trim();
            if (!label || !pendingDataUrl) { notify("ใส่ชื่อเสียงและเลือกไฟล์เสียงก่อน", true); return; }
            if (draft.customSounds.length >= MAX_CUSTOM_SOUNDS) { notify(`เพิ่มได้สูงสุด ${MAX_CUSTOM_SOUNDS} เสียง`, true); return; }
            draft.customSounds.push({ id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())), label, dataUrl: pendingDataUrl });
            const listEl = document.getElementById("sd-custom-sounds-list");
            if (listEl) listEl.innerHTML = renderCustomSoundRows(draft.customSounds);
            refreshSoundStyleSelect(draft);
            resetPreview();
            return;
        }
        if (removeBtn) {
            const removedId = removeBtn.dataset.soundId;
            draft.customSounds = draft.customSounds.filter((s) => s.id !== removedId);
            if (draft.soundStyle === `custom:${removedId}`) draft.soundStyle = DEFAULT_SOUND_STYLE;
            const listEl = document.getElementById("sd-custom-sounds-list");
            if (listEl) listEl.innerHTML = renderCustomSoundRows(draft.customSounds);
            refreshSoundStyleSelect(draft);
        }
    };

    const fileHandler = (e) => {
        if (e.target.id !== "sd-custom-sound-file") return;
        const file = e.target.files?.[0];
        if (!file) return;
        if (draft.customSounds.length >= MAX_CUSTOM_SOUNDS) { notify(`เพิ่มได้สูงสุด ${MAX_CUSTOM_SOUNDS} เสียง`, true); e.target.value = ""; return; }
        if (file.size > MAX_CUSTOM_SOUND_BYTES) { notify("ไฟล์ใหญ่เกิน 300KB กรุณาเลือกไฟล์เล็กกว่านี้", true); e.target.value = ""; return; }
        const reader = new FileReader();
        reader.onload = () => {
            pendingDataUrl = reader.result;
            pendingName = file.name;
            const previewEl = document.getElementById("sd-custom-sound-preview");
            const nameEl = document.getElementById("sd-custom-sound-preview-name");
            if (nameEl) nameEl.textContent = `${pendingName} (${Math.round(file.size / 1024)}KB)`;
            previewEl?.classList.remove("sd-hidden");
        };
        reader.onerror = () => notify("อ่านไฟล์เสียงไม่สำเร็จ", true);
        reader.readAsDataURL(file);
    };

    document.addEventListener("click", clickHandler, true);
    document.addEventListener("change", fileHandler, true);
    return () => {
        document.removeEventListener("click", clickHandler, true);
        document.removeEventListener("change", fileHandler, true);
    };
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

function b64EncodeUnicode(str) {
    return btoa(unescape(encodeURIComponent(str)));
}
function b64DecodeUnicode(str) {
    return decodeURIComponent(escape(atob(str)));
}

function exportDiaryToFile(state, format) {
    if (!state.diaryLog.length) { notify("ยังไม่มีบันทึกไดอารี่ให้ส่งออก", true); return; }
    const charName = getCharacterName();
    const sorted = state.diaryLog.slice().sort((a, b) => new Date(a.dateIso) - new Date(b.dateIso));
    const isMd = format === "md";
    const sep = isMd ? "\n\n---\n\n" : `\n\n${"-".repeat(30)}\n\n`;
    const header = isMd ? `# สมุดไดอารี่ — ${charName}\n\n` : `สมุดไดอารี่ — ${charName}\n${"=".repeat(30)}\n\n`;

    const body = sorted.map((e) => {
        const weather = [e.weatherText, e.temperature != null ? `${e.temperature}°C` : ""].filter(Boolean).join(" / ");
        const dateLine = formatThaiDate(e.dateIso) + (weather ? ` — ${weather}` : "");
        const moodLine = e.mood ? (isMd ? `_อารมณ์: ${e.mood}_` : `อารมณ์: ${e.mood}`) : "";
        const cleanBody = isMd
            ? String(e.body || "").replace(/==(.+?)==/g, "**$1**").replace(/__(.+?)__/g, "<u>$1</u>")
            : String(e.body || "").replace(/==/g, "").replace(/~~/g, "").replace(/__/g, "").replace(/``/g, "");
        const marker = `[[SD_ENTRY:${b64EncodeUnicode(JSON.stringify({
            iso: e.dateIso, mood: e.mood || "", temperature: e.temperature, weatherText: e.weatherText || "",
            characterName: e.characterName || charName, body: e.body || "", favorite: !!e.favorite,
        }))}]]`;
        if (isMd) return `${marker}\n## ${dateLine}\n\n${moodLine ? moodLine + "\n\n" : ""}${cleanBody}`;
        return `${marker}\n${dateLine}${moodLine ? "\n" + moodLine : ""}\n\n${cleanBody}`;
    }).join(sep);

    const content = header + body;
    const mime = isMd ? "text/markdown" : "text/plain";
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `story-director-diary-${charName.replace(/[^\w\-]+/g, "_") || "character"}-${new Date().toISOString().slice(0, 10)}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    notify(`ส่งออกไดอารี่เป็นไฟล์ .${format} แล้ว`);
}

function parseDiaryImportFile(raw) {
    const matches = [...String(raw || "").matchAll(/\[\[SD_ENTRY:([A-Za-z0-9+/=]+)\]\]/g)];
    const entries = [];
    for (const m of matches) {
        try {
            const data = JSON.parse(b64DecodeUnicode(m[1]));
            if (data && data.iso && typeof data.body === "string") entries.push(data);
        } catch (e) { /* skip malformed entry */ }
    }
    return entries;
}

function importDiaryFromFile(state, raw) {
    const parsedEntries = parseDiaryImportFile(raw);
    if (!parsedEntries.length) throw new Error("no entries found");
    const existingKeys = new Set(state.diaryLog.map((e) => `${e.dateIso}|${e.body}`));
    let added = 0;
    for (const d of parsedEntries) {
        const key = `${d.iso}|${d.body}`;
        if (existingKeys.has(key)) continue;
        state.diaryLog.push({
            id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
            dateIso: d.iso,
            weatherText: d.weatherText || "",
            temperature: typeof d.temperature === "number" ? d.temperature : null,
            mood: d.mood || "",
            moodColor: getMoodColor(d.mood),
            body: d.body,
            threadId: null,
            characterName: d.characterName || getCharacterName(),
            favorite: !!d.favorite,
            read: true,
        });
        existingKeys.add(key);
        added++;
    }
    state.diaryLog.sort((a, b) => new Date(a.dateIso) - new Date(b.dateIso));
    trimDiaryLog(state);
    saveChatState();
    return { added, skipped: parsedEntries.length - added };
}

const STATE_EXPORT_VERSION = 1;
function exportStateToFile(state) {
    const envelope = {
        __storyDirectorStateExport: true,
        version: STATE_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        state: {
            activeThreads: state.activeThreads,
            dormantThreads: state.dormantThreads,
            diaryLog: state.diaryLog,
            eventLog: state.eventLog,
            totalFired: state.totalFired,
            storyCalendar: state.storyCalendar,
            globalMsgIndex: state.globalMsgIndex,
            bondValues: state.bondValues,
            bondHistory: state.bondHistory,
            scheduledLetters: state.scheduledLetters,
            npcRegistry: state.npcRegistry,
            npcRelationships: state.npcRelationships,
        },
    };
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `story-director-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    notify("สำรองข้อมูลเนื้อเรื่องแล้ว");
}

function applyStateBackup(state, raw) {
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.__storyDirectorStateExport || !parsed.state) throw new Error("invalid file");
    const s = parsed.state;
    state.activeThreads = Array.isArray(s.activeThreads) ? s.activeThreads : [];
    state.dormantThreads = Array.isArray(s.dormantThreads) ? s.dormantThreads : [];
    state.diaryLog = Array.isArray(s.diaryLog) ? s.diaryLog : [];
    state.eventLog = Array.isArray(s.eventLog) ? s.eventLog : [];
    state.totalFired = typeof s.totalFired === "number" ? s.totalFired : 0;
    state.storyCalendar = s.storyCalendar || null;
    state.globalMsgIndex = typeof s.globalMsgIndex === "number" ? s.globalMsgIndex : 0;
    state.bondValues = s.bondValues && typeof s.bondValues === "object" ? s.bondValues : {};
    state.bondHistory = Array.isArray(s.bondHistory) ? s.bondHistory : [];
    state.scheduledLetters = Array.isArray(s.scheduledLetters) ? s.scheduledLetters : [];
    state.npcRegistry = Array.isArray(s.npcRegistry) ? s.npcRegistry : [];
    state.npcRelationships = s.npcRelationships && typeof s.npcRelationships === "object" ? s.npcRelationships : {};
    state.diaryFilterCharacter = null;
    state.diaryFilterDate = null;
    saveChatState();
}

function wireStateBackup(state) {
    const handler = async (e) => {
        const exportBtn = e.target.closest ? e.target.closest("#sd-state-export-btn") : null;
        const importBtn = e.target.closest ? e.target.closest("#sd-state-import-btn") : null;
        if (exportBtn) {
            exportStateToFile(state);
            return;
        }
        if (importBtn) {
            const confirmed = await callGenericPopup(
                "การกู้คืนจะแทนที่เธรด/ไดอารี่/ปฏิทินปัจจุบันทั้งหมดด้วยข้อมูลในไฟล์สำรอง ต้องการดำเนินการต่อหรือไม่?",
                POPUP_TYPE.CONFIRM, "", { okButton: "กู้คืน", cancelButton: "ยกเลิก" }
            );
            if (confirmed) document.getElementById("sd-state-import-file")?.click();
        }
    };
    const fileHandler = async (e) => {
        if (e.target.id !== "sd-state-import-file") return;
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            applyStateBackup(state, text);
            refreshOpenPopupPanels(state, getChatSettings());
            notify("กู้คืนข้อมูลเนื้อเรื่องแล้ว");
        } catch (err) {
            console.warn("[Story Director] State restore failed:", err);
            notify("กู้คืนไม่สำเร็จ ตรวจว่าเป็นไฟล์สำรองของ Story Director", true);
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

function wireDiaryExport(state) {
    const handler = (e) => {
        const exportTarget = e.target.closest ? e.target.closest("#sd-diary-export-md-btn, #sd-diary-export-txt-btn") : null;
        const importBtn = e.target.closest ? e.target.closest("#sd-diary-import-btn") : null;
        if (exportTarget) {
            exportDiaryToFile(state, exportTarget.id === "sd-diary-export-md-btn" ? "md" : "txt");
        } else if (importBtn) {
            document.getElementById("sd-diary-import-file")?.click();
        }
    };
    const fileHandler = async (e) => {
        if (e.target.id !== "sd-diary-import-file") return;
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const result = importDiaryFromFile(state, text);
            refreshDiaryDynamicPanels(getChatSettings(), state);
            notify(`นำเข้าไดอารี่แล้ว ${result.added} รายการ${result.skipped ? ` (ข้ามรายการซ้ำ ${result.skipped})` : ""}`);
        } catch (err) {
            console.warn("[Story Director] Diary import failed:", err);
            notify("นำเข้าไฟล์ไม่สำเร็จ ตรวจว่าเป็นไฟล์ .md/.txt ที่ export มาจาก Story Director", true);
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

    resetDiaryListLimit();
    const draft = makeDraft(cfg);
    const unwireFields = wireLiveCapture(draft);
    const unwireIo = wireImportExport(draft);
    const unwireActions = wireQuickActions(cfg, draft, state);
    const unwireDiaryNav = wireDiaryNav(state);
    const unwireDiarySwipe = wireDiarySwipe(state);
    const unwireThreadActions = wireThreadActions(state);
    const unwireDiaryExport = wireDiaryExport(state);
    const unwireDiaryCalendarFilter = wireDiaryCalendarAndFilter(cfg, state);
    const unwireSpecialDates = wireSpecialDates(draft);
    const unwireEventPool = wireEventPool(draft);
    const unwireNpcRoster = wireNpcRoster(draft);
    const unwireSecretsPool = wireSecretsPool(draft);
    const unwireCustomStickers = wireCustomStickers(draft);
    const unwireCustomSounds = wireCustomSounds(draft);
    const unwireLetters = wireScheduledLetters(state);
    const unwireStateBackup = wireStateBackup(state);
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
        unwireDiarySwipe();
        unwireThreadActions();
        unwireDiaryExport();
        unwireDiaryCalendarFilter();
        unwireSpecialDates();
        unwireEventPool();
        unwireNpcRoster();
        unwireSecretsPool();
        unwireCustomStickers();
        unwireCustomSounds();
        unwireLetters();
        unwireStateBackup();
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
