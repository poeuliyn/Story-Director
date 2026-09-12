// ============================================================================
// Story Director — a SillyTavern extension that injects plot events into
// otherwise-static roleplay, without ever costing an extra generation call.
//
// Created by Purryverse.
// © Purryverse — please do not redistribute modified copies without
// permission from the original author.
//
// NOTE ON API IMPORTS:
// SillyTavern's internal module paths and a few helper names have shifted
// between versions. These are loaded dynamically (see loadCoreModules())
// instead of as static imports: a static import that fails to resolve
// (wrong SillyTavern version, or the extension folder installed one level
// too deep/shallow) used to kill this entire file silently — no button,
// no console message a normal user would notice. Now a failure here is
// caught, logged, and surfaced as an item in the wand menu itself.
// ============================================================================

let extension_settings, getContext, saveSettingsDebounced, eventSource, event_types, callGenericPopup, POPUP_TYPE;

async function loadCoreModules() {
    const errors = [];
    try {
        const mod = await import("../../../extensions.js");
        extension_settings = mod.extension_settings;
        getContext = mod.getContext;
        if (!extension_settings || !getContext) errors.push("extensions.js loaded but missing expected exports");
    } catch (e) {
        console.error("[Story Director] Failed to import extensions.js. Check that this extension is installed at .../scripts/extensions/third-party/story-director/ (not nested one level deeper/shallower).", e);
        errors.push("extensions.js");
    }
    try {
        const mod = await import("../../../../script.js");
        saveSettingsDebounced = mod.saveSettingsDebounced;
        eventSource = mod.eventSource;
        event_types = mod.event_types;
        if (!saveSettingsDebounced || !eventSource || !event_types) errors.push("script.js loaded but missing expected exports");
    } catch (e) {
        console.error("[Story Director] Failed to import script.js. Check that this extension is installed at .../scripts/extensions/third-party/story-director/ (not nested one level deeper/shallower).", e);
        errors.push("script.js");
    }
    try {
        const mod = await import("../../../popup.js");
        callGenericPopup = mod.callGenericPopup;
        POPUP_TYPE = mod.POPUP_TYPE;
        if (!callGenericPopup || !POPUP_TYPE) errors.push("popup.js loaded but missing expected exports");
    } catch (e) {
        console.error("[Story Director] Failed to import popup.js. Check that this extension is installed at .../scripts/extensions/third-party/story-director/ (not nested one level deeper/shallower).", e);
        errors.push("popup.js");
    }
    return errors;
}

const MODULE_NAME = "story_director";

// ----------------------------------------------------------------------------
// Optional modules used for grounding generated events in established facts
// (character card, {{user}} persona, active Lorebook/World Info entries).
// Loaded dynamically and defensively: if either path/export doesn't match
// your installed SillyTavern version, the extension still loads and works —
// it just skips that one source of grounding and logs a warning telling you
// which import to fix.
// ----------------------------------------------------------------------------

let power_user_ref = null;
let getWorldInfoPromptRef = null;

async function loadOptionalModules() {
    try {
        const puMod = await import("../../../power-user.js");
        power_user_ref = puMod.power_user || null;
        if (!power_user_ref) {
            console.warn("[Story Director] power-user.js loaded but no 'power_user' export found; persona grounding will be skipped.");
        }
    } catch (e) {
        console.warn("[Story Director] Could not load power-user.js; persona grounding will be skipped. If your version keeps this file elsewhere, adjust the path in loadOptionalModules().", e);
    }

    try {
        const wiMod = await import("../../../world-info.js");
        getWorldInfoPromptRef = wiMod.getWorldInfoPrompt || null;
        if (!getWorldInfoPromptRef) {
            console.warn("[Story Director] world-info.js loaded but no 'getWorldInfoPrompt' export found; Lorebook grounding will be skipped.");
        }
    } catch (e) {
        console.warn("[Story Director] Could not load world-info.js; Lorebook grounding will be skipped. If your version keeps this file elsewhere, adjust the path in loadOptionalModules().", e);
    }
}

// ----------------------------------------------------------------------------
// Defaults
// ----------------------------------------------------------------------------

const THEME_TAGS = [
    "Comedy", "Sci-Fi", "Fantasy", "Romance", "Drama",
    "Horror", "Thriller", "Mystery", "Action",
];

const DEFAULT_CHAT_SETTINGS = () => ({
    enabled: true,
    eventSourceMode: "fixed",     // 'fixed' | 'ai'
    presentation: "subtle",       // 'subtle' | 'narrator' | 'both'
    tags: [],
    fixedPool: [],                // [{ summary, detail, tags: [], weight: 1 }]
    soundEnabled: true,           // play a short notification sound when an event fires
    soundStyle: "notif1",         // which sound file plays — see SOUND_STYLES

    useFixedInterval: false,
    fixedIntervalN: 10,

    useRandom: true,
    randomBaseChance: 8,          // percent, checked every AI turn

    tensionEnabled: true,
    tensionGainMode: "random",    // 'fixed' | 'random'
    tensionGainFixed: 10,
    tensionGainMin: 5,
    tensionGainMax: 15,
    tensionBoostMax: 40,          // extra % added to randomBaseChance at full tension
    tensionForceCap: 100,         // tension value that force-triggers regardless of roll

    eventIntensity: "medium",     // 'mild' | 'medium' | 'disruptive'

    // Grounding (character card + persona + lorebook facts) is always on —
    // no user-facing toggle, see buildGroundingBlock().

    historyLength: 6,             // how many past event summaries to remember

    // Follow-up events: when an event fires, optionally schedule a second
    // injection a few messages later that continues/escalates the same
    // thread instead of the next event being unrelated. See
    // maybeScheduleFollowUp() / buildFollowUpInjectionText().
    followUpEnabled: true,
    followUpChance: 60,           // percent chance a fired event schedules a follow-up
    followUpDelayMin: 2,          // messages to wait before the follow-up fires
    followUpDelayMax: 5,
    followUpMaxChain: 2,          // max follow-ups chained off a single origin event

    // Time Skip: a separate, mutually-exclusive event type that jumps the
    // story forward in time instead of injecting an in-scene event. See
    // buildTimeSkipInjectionText() / evaluateTimeSkipTrigger() in onBeforeGenerate().
    timeSkipEnabled: false,
    timeSkipAutoChance: 8,        // percent, rolled independently every AI turn
    timeSkipDurationMode: "random", // 'fixed' | 'random' | 'ai' (model picks the amount itself)
    timeSkipFixedAmount: 1,
    timeSkipFixedUnit: "day",     // 'hour' | 'day' | 'week'
    timeSkipRandomMin: 2,
    timeSkipRandomMax: 5,
    timeSkipRandomUnit: "day",
    timeSkipResetCounters: true,  // reset tension/counters + a short cooldown after a skip fires

    // Debug/pro tool — a live preview of the exact prompt text that would be
    // injected right now, without actually firing anything. Off by default
    // to keep the popup uncluttered for casual users.
    promptPreviewEnabled: false,

    // Character Diary — the model writes the entry itself, riding along as
    // a hidden addendum in the SAME generation call (no extra API request):
    // see buildDiaryInjectionText / extractAndStripDiaryTag. Unlocks on a
    // message-count interval and/or a random roll, same fixed-interval-or-
    // random pattern as normal events for familiarity. Can co-occur with an
    // event/Time Skip in the same message.
    diaryEnabled: false,
    diaryUseFixedInterval: true,
    diaryFixedIntervalN: 8,
    diaryUseRandom: false,
    diaryRandomChance: 15,
    diaryStickersEnabled: true,   // show a mood sticker on each diary card, matched from MOOD text
    diaryBannerEnabled: true,     // show an app-style popup banner over the chat when a new diary entry lands
});

function getDefaultSettings() {
    return {
        globalEnabled: true,
        chats: {}, // keyed by chat id -> DEFAULT_CHAT_SETTINGS()
    };
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = getDefaultSettings();
    }
    if (!extension_settings[MODULE_NAME].chats) {
        extension_settings[MODULE_NAME].chats = {};
    }
    return extension_settings[MODULE_NAME];
}

// Settings are keyed by the current chat file, not the character — so each
// chat keeps its own configuration even when it's the same character, and
// switching chats does not carry settings over.
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
    if (!settings.chats[key]) {
        settings.chats[key] = DEFAULT_CHAT_SETTINGS();
    }
    const cfg = settings.chats[key];

    if (typeof cfg.soundEnabled !== "boolean") cfg.soundEnabled = true;
    if (typeof cfg.soundStyle !== "string" || !SOUND_STYLES[cfg.soundStyle]) cfg.soundStyle = DEFAULT_SOUND_STYLE;

    if (typeof cfg.timeSkipEnabled !== "boolean") cfg.timeSkipEnabled = false;
    if (typeof cfg.timeSkipAutoChance !== "number") cfg.timeSkipAutoChance = 8;
    if (typeof cfg.timeSkipDurationMode !== "string") cfg.timeSkipDurationMode = "random";
    if (typeof cfg.timeSkipFixedAmount !== "number") cfg.timeSkipFixedAmount = 1;
    if (typeof cfg.timeSkipFixedUnit !== "string") cfg.timeSkipFixedUnit = "day";
    if (typeof cfg.timeSkipRandomMin !== "number") cfg.timeSkipRandomMin = 2;
    if (typeof cfg.timeSkipRandomMax !== "number") cfg.timeSkipRandomMax = 5;
    if (typeof cfg.timeSkipRandomUnit !== "string") cfg.timeSkipRandomUnit = "day";
    if (typeof cfg.timeSkipResetCounters !== "boolean") cfg.timeSkipResetCounters = true;
    if (typeof cfg.promptPreviewEnabled !== "boolean") cfg.promptPreviewEnabled = false;

    if (typeof cfg.diaryEnabled !== "boolean") cfg.diaryEnabled = false;
    if (typeof cfg.diaryUseFixedInterval !== "boolean") cfg.diaryUseFixedInterval = true;
    if (typeof cfg.diaryFixedIntervalN !== "number") cfg.diaryFixedIntervalN = 8;
    if (typeof cfg.diaryUseRandom !== "boolean") cfg.diaryUseRandom = false;
    if (typeof cfg.diaryRandomChance !== "number") cfg.diaryRandomChance = 15;
    if (typeof cfg.diaryStickersEnabled !== "boolean") cfg.diaryStickersEnabled = true;
    if (typeof cfg.diaryBannerEnabled !== "boolean") cfg.diaryBannerEnabled = true;

    return cfg;
}

// ----------------------------------------------------------------------------
// Per-chat ephemeral state (tension, message counter, recent event history).
// Stored on chatMetadata so it saves/loads with the chat file itself and never
// bleeds between chats or characters.
// ----------------------------------------------------------------------------

function getChatState() {
    const context = getContext();
    if (!context.chatMetadata) context.chatMetadata = {};
    if (!context.chatMetadata[MODULE_NAME]) {
        context.chatMetadata[MODULE_NAME] = {
            tension: 0,
            messagesSinceEvent: 0,
            recentEvents: [], // array of short summary strings
            pendingFollowUp: null, // { originSummary, turnsLeft, chainDepth } | null
            forceNextEvent: false, // set by the "fire now" button; consumed on next generation
            manualPick: null, // { summary, detail, tags } chosen by hand; consumed on next generation
            eventLog: [], // full timestamped history: [{ summary, kind, time }], capped at MAX_EVENT_LOG
            totalFired: 0, // lifetime count for this chat, for the stats panel
            longestGap: 0, // longest streak (messagesSinceEvent) observed right before an event fired
            lastFiredEvent: null, // { summary, kind, time } of the most recent event, for the rating buttons
            awaitingSummaryCapture: false, // true right after an AI-invented event/follow-up is injected, until the reply lands
            lastSummaryCapturedMesId: -1, // guards against re-parsing the same message twice
            forceNextTimeSkip: false, // set by the "skip time now" button; consumed on next generation
            cooldownTurns: 0, // suppresses auto-rolls for N turns right after a Time Skip fires
            diaryMessagesSinceEntry: 0,
            diaryLog: [], // unlocked entries: { id, dateIso, body, ps, mood, moodColor, timeNote, weatherText, read }
            diaryRecentSummaries: [], // short anti-repeat history for buildDiaryInjectionText
            forceNextDiary: false,
            awaitingDiaryCapture: false, // true right after a Diary request is injected, until the reply lands
            lastDiaryCapturedMesId: -1, // guards against re-parsing the same message twice
        };
    }

    // Backfill fields for chats saved by an older version of the extension
    // that didn't have these yet, so existing chats don't crash on upgrade.
    const state = context.chatMetadata[MODULE_NAME];
    if (typeof state.forceNextEvent !== "boolean") state.forceNextEvent = false;
    if (state.manualPick === undefined) state.manualPick = null;
    if (!Array.isArray(state.eventLog)) state.eventLog = [];
    if (typeof state.totalFired !== "number") state.totalFired = 0;
    if (typeof state.longestGap !== "number") state.longestGap = 0;
    if (state.lastFiredEvent === undefined) state.lastFiredEvent = null;
    if (typeof state.awaitingSummaryCapture !== "boolean") state.awaitingSummaryCapture = false;
    if (typeof state.lastSummaryCapturedMesId !== "number") state.lastSummaryCapturedMesId = -1;
    if (typeof state.forceNextTimeSkip !== "boolean") state.forceNextTimeSkip = false;
    if (typeof state.cooldownTurns !== "number") state.cooldownTurns = 0;
    if (typeof state.diaryMessagesSinceEntry !== "number") state.diaryMessagesSinceEntry = 0;
    if (!Array.isArray(state.diaryLog)) state.diaryLog = [];
    if (!Array.isArray(state.diaryRecentSummaries)) state.diaryRecentSummaries = [];
    if (typeof state.forceNextDiary !== "boolean") state.forceNextDiary = false;
    if (typeof state.awaitingDiaryCapture !== "boolean") state.awaitingDiaryCapture = false;
    if (typeof state.lastDiaryCapturedMesId !== "number") state.lastDiaryCapturedMesId = -1;
    delete state.diaryRecentBodies; // superseded by diaryRecentSummaries (pool mode removed)

    return state;
}

const MAX_EVENT_LOG = 200;

function logEvent(state, summary, kind) {
    if (!Array.isArray(state.eventLog)) state.eventLog = [];
    state.eventLog.push({
        summary: summary || "(ไม่ทราบ)",
        kind, // 'fixed' | 'ai' | 'followup'
        time: new Date().toISOString(),
    });
    if (state.eventLog.length > MAX_EVENT_LOG) {
        state.eventLog.splice(0, state.eventLog.length - MAX_EVENT_LOG);
    }
}

// Used by wireLiveCapture() below for every numeric settings field, so a
// stray negative sign or an out-of-range value typed directly into the box
// can't desync the live draft from what the matching <input min/max> claims
// to allow. Falls back to the field's own default on anything non-numeric.
function clampNum(raw, fallback, min, max) {
    const n = Number(raw);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function escapeHtml(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ----------------------------------------------------------------------------

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

// Hooked to MESSAGE_RECEIVED — only {{char}}'s own new messages are relevant
// here (never the user's), and each message index is only processed once so
// swipes/re-renders of the same slot don't get captured twice.
function onCharacterMessageReceived(mesId) {
    try {
        const context = getContext();
        const chat = context.chat;
        if (!Array.isArray(chat) || chat.length === 0) return;

        const idx = typeof mesId === "number" ? mesId : chat.length - 1;
        const msg = chat[idx];
        if (!msg || msg.is_user) return;

        // --- Story Director event-summary capture --------------------------
        // Runs in group chats too. Single-shot: only the very next character
        // message after an AI-invented event/follow-up is checked, then the
        // flag is cleared either way.
        const sdState = getChatState();
        if (sdState.awaitingSummaryCapture && sdState.lastSummaryCapturedMesId !== idx) {
            sdState.lastSummaryCapturedMesId = idx;
            sdState.awaitingSummaryCapture = false;
            const captured = extractAndStripEventSummary(msg, idx);
            if (captured) {
                if (sdState.recentEvents.length > 0) {
                    sdState.recentEvents[sdState.recentEvents.length - 1] = captured;
                }
                if (sdState.lastEventOrigin) {
                    sdState.lastEventOrigin = { summary: captured, detail: captured };
                }
                if (sdState.pendingFollowUp) {
                    sdState.pendingFollowUp.originSummary = captured;
                }
                if (sdState.lastFiredEvent) {
                    sdState.lastFiredEvent.summary = captured;
                }
                saveChatState();
            }
        }
        // ---------------------------------------------------------------

        // --- Character Diary capture ---------------------------------------
        // The diary entry itself is requested via buildDiaryInjectionText()
        // riding along in the SAME generation call (see onBeforeGenerate) —
        // no extra API call. This pulls the hidden <!--SD_DIARY_START...
        // SD_DIARY_END--> block back out of the reply and turns it into a
        // stored diary entry, same single-shot pattern as summary capture
        // above (runs in group chats too).
        if (sdState.awaitingDiaryCapture && sdState.lastDiaryCapturedMesId !== idx) {
            sdState.lastDiaryCapturedMesId = idx;
            sdState.awaitingDiaryCapture = false;
            const parsed = extractAndStripDiaryTag(msg, idx);
            if (parsed) {
                const storedEntry = recordDiaryEntry(sdState, parsed);
                const cfg = getChatSettings();
                if (cfg.diaryBannerEnabled) {
                    showDiaryNotificationBanner(storedEntry);
                } else {
                    notify(`${getCharacterName()} เขียนไดอารี่หน้าใหม่แล้ว`);
                }
            }
            saveChatState();
        }
        // ---------------------------------------------------------------
    } catch (e) {
        console.warn("[Story Director] Message capture failed:", e);
    }
}

function saveChatState() {
    // Persist chatMetadata to the chat file. saveChatDebounced is not part of
    // SillyTavern's public extension API (it isn't exported from script.js),
    // so we use the context's saveMetadataDebounced instead — the correct,
    // exported function for persisting chatMetadata changes.
    try {
        const context = getContext();
        if (typeof context.saveMetadataDebounced === "function") {
            context.saveMetadataDebounced();
        }
    } catch (e) {
        console.warn("[Story Director] Could not save chat state:", e);
    }
}

// ----------------------------------------------------------------------------
// Trigger engine
// ----------------------------------------------------------------------------

function rollTensionGain(cfg) {
    if (cfg.tensionGainMode === "fixed") return cfg.tensionGainFixed;
    const [min, max] = [cfg.tensionGainMin, cfg.tensionGainMax];
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Decide whether an event should fire on this upcoming AI turn.
 * Combines whichever modes the user has enabled. Any one of them
 * firing is enough to trigger.
 */
function evaluateTrigger(cfg, state) {
    let forceFire = false;
    let fired = false;

    // 1) Fixed interval
    if (cfg.useFixedInterval && cfg.fixedIntervalN > 0) {
        if (state.messagesSinceEvent >= cfg.fixedIntervalN) {
            fired = true;
        }
    }

    // 2) Random chance, boosted by tension if tension tracking is on
    if (cfg.useRandom) {
        let chance = cfg.randomBaseChance;
        if (cfg.tensionEnabled) {
            const boost = (state.tension / 100) * cfg.tensionBoostMax;
            chance += boost;
        }
        chance = Math.min(chance, 100);
        const roll = Math.random() * 100;
        if (roll < chance) fired = true;
    }

    // 3) Tension hard cap forces it regardless of the roll
    if (cfg.tensionEnabled && state.tension >= cfg.tensionForceCap) {
        forceFire = true;
    }

    return fired || forceFire;
}

function advanceTensionAndCounter(cfg, state) {
    state.messagesSinceEvent += 1;
    if (cfg.tensionEnabled) {
        state.tension = Math.min(100, state.tension + rollTensionGain(cfg));
    }
}

function resetAfterEvent(state) {
    state.messagesSinceEvent = 0;
    state.tension = 0;
}

// ----------------------------------------------------------------------------
// Grounding context — pulls facts from the character card, the {{user}}
// persona, and currently-active Lorebook/World Info entries, so that
// AI-generated (and fixed-pool) events don't invent details that contradict
// what's already established, or assign a trait/role established for one
// character onto a different one.
// ----------------------------------------------------------------------------

function truncateText(str, max) {
    if (!str) return "";
    const s = String(str).trim();
    return s.length > max ? s.slice(0, max) + "…" : s;
}

// ----------------------------------------------------------------------------
// Event-summary capture — the extension only ever injects prompt text into a
// generation call already in flight, so it never directly sees what the
// model wrote back. For AI-invented events (fresh AI-generated mode and
// follow-ups) that means the anti-repeat/follow-up bookkeeping had nothing
// but a generic placeholder to work with. SUMMARY_TAG_NOTE asks the model to
// leave a hidden <!--SD_EVENT: ...--> marker at the end of its reply; this
// pulls that marker back out and strips it from the saved message so it
// never leaks into the chat log or gets fed back into a future prompt.
// ----------------------------------------------------------------------------

const EVENT_SUMMARY_TAG_RE = /<!--\s*SD_EVENT:\s*([\s\S]*?)-->\s*$/i;

function extractAndStripEventSummary(msg, idx) {
    if (!msg || typeof msg.mes !== "string") return null;
    const match = msg.mes.match(EVENT_SUMMARY_TAG_RE);
    if (!match) return null;

    const summary = truncateText(match[1].replace(/\s+/g, " ").trim(), 140);
    msg.mes = msg.mes.slice(0, match.index).replace(/\s+$/, "");

    // Best-effort: if the message bubble is already rendered, strip the raw
    // tag out of the DOM too. Harmless no-op if the selector doesn't match
    // on some SillyTavern versions (mesid attribute naming can differ) — the
    // chat-log strip above is what matters for future prompts either way,
    // and the tag is an HTML comment so it renders invisibly regardless.
    try {
        if (typeof idx === "number") {
            const mesEl = document.querySelector(`.mes[mesid="${idx}"] .mes_text`);
            if (mesEl) mesEl.innerHTML = mesEl.innerHTML.replace(EVENT_SUMMARY_TAG_RE, "");
        }
    } catch (e) {
        // ignore — cosmetic only
    }

    return summary || null;
}

// ----------------------------------------------------------------------------
// Group chat support — in a group, there is no single {{char}}, so grounding
// needs the description/personality/scenario of every active member instead
// of just context.characters[context.characterId]. Resolved defensively:
// if the member-lookup shape doesn't match your SillyTavern version, we log
// a warning and fall back to no character-card grounding rather than
// throwing (World Info and persona grounding still work independently).
// ----------------------------------------------------------------------------

function getGroupObject(context) {
    try {
        if (!context.groupId || !Array.isArray(context.groups)) return null;
        return context.groups.find((g) => String(g.id) === String(context.groupId)) || null;
    } catch (e) {
        console.warn("[Story Director] Could not resolve current group object:", e);
        return null;
    }
}

function getGroupMemberCharacters(context, group) {
    try {
        const members = Array.isArray(group.members) ? group.members : [];
        const disabled = new Set(Array.isArray(group.disabled_members) ? group.disabled_members : []);
        return members
            .filter((avatar) => !disabled.has(avatar))
            .map((avatar) => (context.characters || []).find((c) => c && c.avatar === avatar))
            .filter(Boolean);
    } catch (e) {
        console.warn("[Story Director] Could not resolve group member characters:", e);
        return [];
    }
}

function getCharacterCardContext() {
    try {
        const context = getContext();
        const group = getGroupObject(context);

        if (group) {
            const members = getGroupMemberCharacters(context, group);
            if (members.length === 0) {
                console.warn("[Story Director] In a group chat but could not resolve any member character cards; if this persists, check whether 'groups[].members' still stores avatar filenames in your SillyTavern version and adjust getGroupMemberCharacters().");
                return "";
            }
            const parts = members.map((character) => {
                const bits = [];
                if (character.description) bits.push(`Description: ${truncateText(character.description, 500)}`);
                if (character.personality) bits.push(`Personality: ${truncateText(character.personality, 250)}`);
                if (character.scenario) bits.push(`Scenario: ${truncateText(character.scenario, 250)}`);
                return `- ${character.name || "Unnamed character"}:\n  ${bits.join("\n  ")}`;
            });
            return `This is a GROUP CHAT with multiple characters present. The facts below are per named character — do not blend or transfer a trait from one member onto another unless explicitly shared:\n${parts.join("\n")}`;
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
        if (!desc) return "";
        return `User persona ({{user}}): ${truncateText(desc, 600)}`;
    } catch (e) {
        console.warn("[Story Director] Could not read persona description:", e);
        return "";
    }
}

// World Info lookup is async (it may need to load book files), so we don't
// call it synchronously from the trigger engine. Instead we refresh a cache
// on every message event, and the trigger engine reads the cached value
// synchronously — a turn or so of lag is an acceptable trade-off for never
// blocking or racing the actual generation call.
let cachedWorldInfoText = "";

async function refreshWorldInfoCache() {
    try {
        if (typeof getWorldInfoPromptRef !== "function") {
            cachedWorldInfoText = "";
            return;
        }
        const context = getContext();
        const chat = context.chat || [];
        // Signature per SillyTavern's world-info.js: (chat, maxContext, isDryRun).
        // isDryRun=true reads the entries that WOULD be activated without
        // triggering sticky/cooldown/once-only side effects, since we are
        // only borrowing this for our own grounding text, not the real
        // generation pass (which runs its own WI activation separately).
        const result = await getWorldInfoPromptRef(chat, 999999, true);
        cachedWorldInfoText = result?.worldInfoString
            || [result?.worldInfoBefore, result?.worldInfoAfter].filter(Boolean).join("\n")
            || "";
    } catch (e) {
        console.warn("[Story Director] World Info lookup failed; continuing without it.", e);
        cachedWorldInfoText = "";
    }
}

function buildGroundingBlock(cfg) {
    const parts = [
        getCharacterCardContext(),
        getPersonaContext(),
        cachedWorldInfoText ? `Active Lorebook/World Info entries:\n${truncateText(cachedWorldInfoText, 1500)}` : "",
    ].filter(Boolean);

    if (parts.length === 0) return "";

    return `\n\nEstablished facts — draw the event's content from these when relevant:\n${parts.join("\n\n")}\n\nBefore finalizing: confirm which specific character (by name — {{user}} or one of the named characters above) each trait or mechanic above actually belongs to, and apply it only to that character. Do not transfer a trait or role from one character onto another, and do not invent one absent from these facts. If the facts don't clearly assign a role you're considering, pick a different event angle instead of guessing.`;
}

// asking the SAME model call to invent one from the chosen theme tags. Either
// way this never triggers a second generation; it only adds text to the
// prompt that is about to be sent anyway.
// ----------------------------------------------------------------------------

function pickFixedPoolEvent(cfg, state) {
    const unused = cfg.fixedPool.filter(
        (e) => !state.recentEvents.includes(e.summary)
    );
    let pool = unused.length > 0 ? unused : cfg.fixedPool;

    // If the event has its own #tags and the user has theme tags selected in
    // the picker, prefer events that match — so Fixed Pool responds to the
    // tag picker the same way AI mode already does, instead of picking
    // completely at random regardless of context.
    if (cfg.tags.length > 0) {
        const tagged = pool.filter(
            (e) => e.tags && e.tags.some((t) => cfg.tags.includes(t))
        );
        if (tagged.length > 0) pool = tagged;
    }

    if (pool.length === 0) return null;
    return weightedPick(pool);
}

// Weighted random pick — an event's `weight` (default 1, must be > 0) makes
// it proportionally more or less likely to be chosen than the rest of the
// pool, instead of every entry having an equal chance.
function weightedPick(pool) {
    const weightOf = (e) => (typeof e.weight === "number" && e.weight > 0 ? e.weight : 1);
    const total = pool.reduce((sum, e) => sum + weightOf(e), 0);
    let roll = Math.random() * total;
    for (const e of pool) {
        const w = weightOf(e);
        if (roll < w) return e;
        roll -= w;
    }
    return pool[pool.length - 1];
}

// ----------------------------------------------------------------------------
// Character Diary — rides along in the SAME generation call as a hidden
// addendum (see buildDiaryInjectionText / onBeforeGenerate), never a
// separate API call. The model writes the entry itself in a hidden tagged
// block at the end of its reply; extractAndStripDiaryTag() (below, used
// from onCharacterMessageReceived) pulls it back out and strips it from the
// saved/displayed message, same pattern as event-summary capture.
// ----------------------------------------------------------------------------

const DIARY_TIME_FLAVORS = [
    "เขียนตอนตี 2 นอนไม่หลับ",
    "เขียนรีบๆ ก่อนแบตมือถือจะหมด",
    "เขียนตอนเช้ามืดก่อนทุกคนตื่น",
    "เขียนระหว่างพักกองถ่าย",
    "เขียนตอนกลับถึงบ้านดึกๆ",
    "เขียนตอนนั่งรถกลับคนเดียว",
];

const DIARY_WEATHER_FLAVORS = [
    "ฟ้าใส ลมเย็นสบาย|22°C|☀️",
    "ฝนตกหนักและลมกระโชกแรง|24°C|🌧️",
    "เมฆครึ้มทั้งวัน|20°C|☁️",
    "อากาศร้อนอบอ้าว|33°C|🔆",
    "ฝนปรอยๆ ยามเย็น|23°C|🌦️",
];

function pickRandomFlavor(list) {
    return list[Math.floor(Math.random() * list.length)];
}

// The model only supplies BODY/PS/MOOD (the parts that actually need to be
// fresh each time) — TIME/WEATHER are decorative flavor the extension picks
// locally, keeping the model's hidden-tag output short and less likely to
// drift out of format.
function recordDiaryEntry(state, parsed) {
    const now = new Date();
    const entry = {
        id: `${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
        dateIso: now.toISOString(),
        body: parsed.body,
        ps: parsed.ps || "",
        mood: parsed.mood || "",
        moodColor: "",
        timeNote: pickRandomFlavor(DIARY_TIME_FLAVORS),
        weatherText: pickRandomFlavor(DIARY_WEATHER_FLAVORS),
        read: false,
    };
    state.diaryLog.unshift(entry); // newest first
    if (state.diaryLog.length > 60) state.diaryLog.length = 60; // cap stored history

    state.diaryRecentSummaries.push(truncateText(parsed.body, 60));
    if (state.diaryRecentSummaries.length > 4) state.diaryRecentSummaries.shift();

    return entry;
}

// Inline markup gimmicks the model is asked to use inside BODY. None of
// these characters are touched by escapeHtml(), so this must run AFTER
// escaping, never before (otherwise the markers could be mangled by the
// escape step).
//   ~~text~~   strikethrough, greyed out  — a suppressed thought, never said aloud
//   ==text==   yellow highlight           — a truth the writer finally admits
//   __text__   blue underline             — something resolved on, firmly decided
//   ``text``   dotted rose underline      — words actually said aloud that didn't match how they felt
function parseDiaryMarkup(escapedText) {
    return escapedText
        .replace(/~~([\s\S]+?)~~/g, '<span class="sd-diary-suppressed">$1</span>')
        .replace(/==([\s\S]+?)==/g, '<span class="sd-diary-truth">$1</span>')
        .replace(/__([\s\S]+?)__/g, '<span class="sd-diary-resolve">$1</span>')
        .replace(/``([\s\S]+?)``/g, '<span class="sd-diary-facade">$1</span>');
}

function renderDiaryBodyHtml(body) {
    return String(body || "")
        .split(/\n\s*\n/)
        .map((para) => para.trim())
        .filter(Boolean)
        .map((para) => `<p class="sd-diary-p">${parseDiaryMarkup(escapeHtml(para)).replace(/\n/g, "<br>")}</p>`)
        .join("");
}

const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const TH_WEEKDAYS = ["วันอาทิตย์", "วันจันทร์", "วันอังคาร", "วันพุธ", "วันพฤหัสบดี", "วันศุกร์", "วันเสาร์"];

function formatThaiDiaryDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return `${d.getDate()} ${TH_MONTHS[d.getMonth()]} ${d.getFullYear()} ${TH_WEEKDAYS[d.getDay()]}`;
}

// The mood label is hashed into a deterministic HSL hue, so the same mood
// word always gets the same dot color without needing a hardcoded lookup
// table (the model only supplies a plain label, never a hex color).
function moodDotColor(entry) {
    const label = entry.mood || "เฉยๆ";
    let hash = 0;
    for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
    return `hsl(${hash % 360}, 62%, 55%)`;
}

function renderDiaryEntryCard(entry) {
    const [weatherCond, weatherTemp, weatherEmoji] = (entry.weatherText || "").split("|");
    const weatherLine = weatherCond
        ? `<div class="sd-diary-weather">${escapeHtml(weatherEmoji || "🌤️")} ${escapeHtml(weatherCond)}${weatherTemp ? ` / ${escapeHtml(weatherTemp)}` : ""}</div>`
        : "";
    const psText = entry.ps ? (entry.ps.trim().startsWith("ป.ล.") ? entry.ps.trim() : `ป.ล. ${entry.ps.trim()}`) : "";
    const psLine = psText ? `<div class="sd-diary-ps">${escapeHtml(psText)}</div>` : "";
    const moodLine = entry.mood
        ? `<div class="sd-diary-mood"><span class="sd-diary-mood-dot" style="background:${moodDotColor(entry)}"></span>อารมณ์วันนี้: ${escapeHtml(entry.mood)}</div>`
        : "";
    const timeLine = entry.timeNote ? `<div class="sd-diary-timenote">${escapeHtml(entry.timeNote)}</div>` : "";
    const unreadDot = entry.read ? "" : `<span class="sd-diary-unread-dot" title="ยังไม่ได้อ่าน"></span>`;

    const cfg = getChatSettings();
    const stickerFile = cfg.diaryStickersEnabled ? pickMoodStickerFile(entry.mood) : null;
    const stickerImg = stickerFile
        ? `<img class="sd-diary-sticker" src="${resolveStickerUrl(stickerFile)}" alt="" title="${escapeHtml(entry.mood || "")}">`
        : "";

    return `
        <div class="sd-diary-card" data-diary-id="${escapeHtml(entry.id)}">
            ${stickerImg}
            <div class="sd-diary-header">
                <div class="sd-diary-date">${unreadDot}${escapeHtml(formatThaiDiaryDate(entry.dateIso))}</div>
                ${weatherLine}
            </div>
            <div class="sd-diary-body">${renderDiaryBodyHtml(entry.body)}</div>
            ${psLine}
            ${moodLine}
            ${timeLine}
        </div>`;
}

function renderDiaryList(state) {
    if (!state.diaryLog || state.diaryLog.length === 0) {
        return `<div class="sd-help">ยังไม่มีหน้าไดอารี่เลย พอถึงรอบที่กำหนดไว้ หน้าใหม่จะขึ้นมาที่นี่เอง หรือจะกดปุ่ม "เขียนไดอารี่ในข้อความถัดไปทันที" ด้านล่างเพื่อให้เขียนตอนนี้เลยก็ได้</div>`;
    }
    return state.diaryLog.map(renderDiaryEntryCard).join("");
}

// Prevents the model from parroting the same reflection theme every time —
// same anti-repeat idea as recentEvents, kept separately and much shorter
// (just enough to nudge variety, not a full history dump).
function buildDiaryHistoryNote(state) {
    return state.diaryRecentSummaries && state.diaryRecentSummaries.length
        ? `Don't rehash these recent diary themes: ${state.diaryRecentSummaries.join(" / ")}.`
        : "";
}

const DIARY_MARKUP_NOTE = "Use these inline markers inside BODY where they genuinely fit (not forced into every line, and not necessarily all four every time): ~~text~~ for a suppressed thought never said aloud, ==text== for a truth being admitted to, __text__ for something firmly resolved on, ``text`` for words actually said aloud that didn't match how they really felt.";

function buildDiaryInjectionText(cfg, state) {
    const historyNote = buildDiaryHistoryNote(state);

    return `[STORY DIRECTOR DIARY — after you finish your normal in-character reply above, add nothing else visible, then on new lines at the very end append a hidden diary entry in {{char}}'s own first-person voice, reflecting honestly on how they actually feel about what's happening in the story right now — grounded in what's actually happened in this conversation so far, not generic. Use exactly this format and nothing else inside it:
<!--SD_DIARY_START
BODY: (the diary entry itself, first person, a full page of writing — several substantial paragraphs, not a short summary; take real time to walk through events, thoughts, and feelings in detail before wrapping up; a blank line between BODY's own paragraphs is fine)
PS: (one short, more raw/vulnerable line than the main body — the kind of thing added after supposedly closing the entry)
MOOD: (one or two words)
SD_DIARY_END-->
This hidden block must never appear as visible narrative and must never be mentioned anywhere in your visible reply — it exists only for the app to parse out afterward. ${DIARY_MARKUP_NOTE} ${historyNote} ${ANTI_LEAK_NOTE}]`;
}

const DIARY_TAG_RE = /<!--\s*SD_DIARY_START([\s\S]*?)SD_DIARY_END\s*-->/i;

function extractAndStripDiaryTag(msg, idx) {
    if (!msg || typeof msg.mes !== "string") return null;
    const match = msg.mes.match(DIARY_TAG_RE);
    if (!match) return null;

    const inner = match[1];
    const bodyMatch = inner.match(/BODY:\s*([\s\S]*?)(?:\n\s*PS:|\n\s*MOOD:|$)/i);
    const psMatch = inner.match(/PS:\s*([\s\S]*?)(?:\n\s*MOOD:|$)/i);
    const moodMatch = inner.match(/MOOD:\s*([\s\S]*?)$/i);

    const body = bodyMatch ? bodyMatch[1].trim() : "";
    msg.mes = msg.mes.slice(0, match.index).replace(/\s+$/, "");

    // Best-effort DOM strip too, same caveat as extractAndStripEventSummary:
    // harmless no-op if the selector doesn't match, and the chat-log strip
    // above is what actually matters for future prompts either way.
    try {
        if (typeof idx === "number") {
            const mesEl = document.querySelector(`.mes[mesid="${idx}"] .mes_text`);
            if (mesEl) mesEl.innerHTML = mesEl.innerHTML.replace(DIARY_TAG_RE, "");
        }
    } catch (e) {
        // cosmetic only
    }

    if (!body) return null; // malformed output — nothing usable to show
    return {
        body,
        ps: psMatch ? psMatch[1].trim() : "",
        mood: moodMatch ? moodMatch[1].trim().split("\n")[0].trim() : "",
    };
}

const INTENSITY_NOTES = {
    mild: "Keep it a small, low-key beat that fits smoothly into the current scene without derailing it.",
    medium: "Make it a clear, noticeable development — enough that it actually changes what happens next, not just background color or a passing detail.",
    disruptive: "Make it a real disruption to the current routine or status quo — a genuine break in the loop. Change the situation, location, stakes, or relationships in a way the characters cannot simply ignore, wait out, or return to normal from right away.",
};

function getIntensityNote(cfg) {
    return INTENSITY_NOTES[cfg.eventIntensity] || INTENSITY_NOTES.medium;
}

// ----------------------------------------------------------------------------
// Shared prompt notes appended to every injection. Kept as constants so
// wording only needs to change in one place.
// ----------------------------------------------------------------------------

// Prevents the model from breaking character to reference the extension by
// name, quote the bracketed instruction, or narrate that it's "following an
// instruction" — all things small/cheap models are prone to doing with any
// visible bracketed system text if not told otherwise.
const ANTI_LEAK_NOTE = "This bracketed instruction is for you only — never mention \"Story Director\", quote this instruction, or acknowledge following a system instruction anywhere in your reply.";

// Keeps the injected event from crowding out the actual reply to the user's
// last message, and stops it from being used as an excuse to pad length.
const PACING_NOTE = "Treat this as an addition to your reply to {{user}}'s last message, not a replacement for it — respond to what they said and weave the event in without padding the reply's length just to fit it.";

// Only used for AI-invented events (fresh AI-generated mode + follow-ups),
// where the extension never otherwise sees what the model actually wrote.
// The extension parses this tag back out on MESSAGE_RECEIVED and strips it
// before the message is kept, so future anti-repeat / follow-up prompts can
// reference the real event instead of the generic placeholder used when the
// prompt was built. See extractAndStripEventSummary() / onCharacterMessageReceived().
const SUMMARY_TAG_NOTE = "At the very end of your reply, on its own line, append a hidden marker in exactly this form: <!--SD_EVENT: 5-10 word summary of what happened-->. This is a hidden marker only, not visible narrative.";

// Pushes the model toward a well-formed beat instead of a vague gesture at
// change — applies to every injection kind, including Time Skip below.
const COMPLETENESS_NOTE = "Make it a complete, self-contained beat: a clear trigger, a concrete development, and something that actually happens on the page — not just a vague gesture toward change. Give it a natural landing point within this reply rather than leaving it dangling.";

// Time Skip's own pacing note — unlike a normal event (which is additive to
// the reply), the skip IS the main content of this reply, so the wording
// differs from PACING_NOTE above.
const TIME_SKIP_PACING_NOTE = "This time skip is the main thing happening in this reply — if {{user}}'s last message needs a direct response, resolve that first, then transition into the skip.";

const TIME_UNIT_LABEL = { hour: "hour", day: "day", week: "week" };

function formatDuration(duration) {
    if (!duration) return null;
    const label = TIME_UNIT_LABEL[duration.unit] || duration.unit;
    return `${duration.amount} ${duration.amount === 1 ? label : label + "s"}`;
}

function getStyleNote(cfg) {
    return cfg.presentation === "narrator"
        ? "Present it as a brief narrator/GM interjection, clearly tagged and visibly separate from the ongoing narration and from the character's own voice — e.g. set off in brackets or its own line."
        : cfg.presentation === "both"
        ? "Either weave it into the prose narration or set it off as a brief narrator interjection — whichever fits the scene better."
        : "Weave it into the ongoing prose narration itself, as descriptive narration seamlessly continuing the scene — NOT as something the character says out loud, and NOT as a separate visibly-tagged narrator interjection (that's the other mode). It should read like an unbroken continuation of the story's own narrative voice.";
}

function buildInjectionText(cfg, state) {
    const historyNote = state.recentEvents.length
        ? `Do not repeat these recent plot beats: ${state.recentEvents.join(", ")}.`
        : "";
    const intensityNote = getIntensityNote(cfg);
    const styleNote = getStyleNote(cfg);

    // A specific event picked by hand from the settings popup ("เลือกยิง
    // เหตุการณ์เอง") always wins over both Fixed Pool random-pick and
    // AI-generated mode — the user asked for exactly this one.
    if (state.manualPick) {
        const ev = state.manualPick;
        state.manualPick = null;
        state.recentEvents.push(ev.summary);
        trimHistory(cfg, state);
        state.lastEventOrigin = { summary: ev.summary, detail: ev.detail || ev.summary };

        return `[STORY DIRECTOR EVENT — apply this turn: ${ev.detail || ev.summary}. ${intensityNote} ${styleNote} ${historyNote} ${PACING_NOTE} ${COMPLETENESS_NOTE} ${ANTI_LEAK_NOTE}]${buildGroundingBlock(cfg)}`;
    }

    if (cfg.eventSourceMode === "fixed") {
        const ev = pickFixedPoolEvent(cfg, state);
        if (!ev) return null;
        state.recentEvents.push(ev.summary);
        trimHistory(cfg, state);
        state.lastEventOrigin = { summary: ev.summary, detail: ev.detail || ev.summary };

        return `[STORY DIRECTOR EVENT — apply this turn: ${ev.detail || ev.summary}. ${intensityNote} ${styleNote} ${historyNote} ${PACING_NOTE} ${COMPLETENESS_NOTE} ${ANTI_LEAK_NOTE}]${buildGroundingBlock(cfg)}`;
    }

    // AI-generated mode: give the model a short creative brief instead of a
    // fixed event. It still only costs the single generation already in flight.
    const tagList = cfg.tags.length ? cfg.tags.join(", ") : "the current tone of the scene";
    // This placeholder is only a stand-in for anti-repeat/follow-up bookkeeping
    // until the real event lands — see SUMMARY_TAG_NOTE above and
    // extractAndStripEventSummary() below, which replace it with what the
    // model actually wrote as soon as its reply comes back.
    const summaryPlaceholder = `a new plot development related to ${tagList}`;
    state.recentEvents.push(summaryPlaceholder);
    trimHistory(cfg, state);
    state.lastEventOrigin = { summary: summaryPlaceholder, detail: summaryPlaceholder };
    state.awaitingSummaryCapture = true;

    return `[STORY DIRECTOR: Invent one plot event fitting the theme(s) "${tagList}", consistent with everything established so far, and apply it in this reply. ${intensityNote} ${styleNote} ${historyNote} ${PACING_NOTE} ${COMPLETENESS_NOTE} ${SUMMARY_TAG_NOTE} ${ANTI_LEAK_NOTE}]${buildGroundingBlock(cfg)}`;
}

// ----------------------------------------------------------------------------
// Follow-up chains — a fired event can schedule a second injection a few
// messages later that continues/escalates the same thread instead of the
// next event being unrelated. The extension never sees what the model
// actually wrote (it only ever injects prompt text into the same
// generation call), so the follow-up doesn't try to restate invented
// details — it points the model at its own earlier reply and asks it to
// pick that thread back up.
// ----------------------------------------------------------------------------

function maybeScheduleFollowUp(cfg, state, origin, chainDepth) {
    if (!cfg.followUpEnabled || !origin) return;
    if (chainDepth >= Math.max(0, cfg.followUpMaxChain)) return;

    const roll = Math.random() * 100;
    if (roll >= cfg.followUpChance) return;

    const lo = Math.min(cfg.followUpDelayMin, cfg.followUpDelayMax);
    const hi = Math.max(cfg.followUpDelayMin, cfg.followUpDelayMax);
    const delay = Math.floor(Math.random() * (hi - lo + 1)) + lo;

    state.pendingFollowUp = {
        originSummary: origin.summary,
        turnsLeft: Math.max(1, delay),
        chainDepth: chainDepth + 1,
    };
}

function buildFollowUpInjectionText(cfg, state, followUp) {
    const historyNote = state.recentEvents.length
        ? `Do not repeat these recent plot beats verbatim: ${state.recentEvents.join(", ")}.`
        : "";
    const intensityNote = getIntensityNote(cfg);
    const styleNote = getStyleNote(cfg);

    const summary = `follow-up to: ${truncateText(followUp.originSummary, 60)}`;
    state.recentEvents.push(summary);
    trimHistory(cfg, state);
    state.lastEventOrigin = { summary, detail: summary };
    state.awaitingSummaryCapture = true;

    return `[STORY DIRECTOR FOLLOW-UP — earlier in this conversation a Story Director event introduced this thread: "${followUp.originSummary}". Check how the story actually developed after that point (its real content lives in the preceding chat messages, not here) and continue or escalate that same thread now in this reply — do not introduce a new, unrelated event. ${intensityNote} ${styleNote} ${historyNote} ${PACING_NOTE} ${COMPLETENESS_NOTE} ${SUMMARY_TAG_NOTE} ${ANTI_LEAK_NOTE}]${buildGroundingBlock(cfg)}`;
}

function trimHistory(cfg, state) {
    const max = Math.max(1, cfg.historyLength || 6);
    while (state.recentEvents.length > max) {
        state.recentEvents.shift();
    }
}

// ----------------------------------------------------------------------------
// Time Skip — a separate, mutually-exclusive event type from the normal
// Fixed Pool / AI-generated events above: instead of injecting something
// that happens IN the current scene, it asks the model to jump the story
// forward in time. Can fire manually (button) or automatically (independent
// percent roll, checked in onBeforeGenerate alongside the normal trigger).
// ----------------------------------------------------------------------------

function evaluateTimeSkipTrigger(cfg) {
    if (!cfg.timeSkipEnabled) return false;
    const chance = Math.min(100, Math.max(0, cfg.timeSkipAutoChance || 0));
    return Math.random() * 100 < chance;
}

// Resolves to a concrete { amount, unit } for 'fixed'/'random' modes, or
// null for 'ai' mode — where the model chooses the amount itself and the
// extension has nothing to log ahead of time.
function rollTimeSkipDuration(cfg) {
    if (cfg.timeSkipDurationMode === "fixed") {
        return { amount: Math.max(1, cfg.timeSkipFixedAmount || 1), unit: cfg.timeSkipFixedUnit || "day" };
    }
    if (cfg.timeSkipDurationMode === "random") {
        const lo = Math.max(1, Math.min(cfg.timeSkipRandomMin, cfg.timeSkipRandomMax) || 1);
        const hi = Math.max(lo, cfg.timeSkipRandomMax || lo);
        const amount = Math.floor(Math.random() * (hi - lo + 1)) + lo;
        return { amount, unit: cfg.timeSkipRandomUnit || "day" };
    }
    return null; // 'ai' — model decides
}

function buildTimeSkipInjectionText(cfg, state, duration) {
    const durationText = formatDuration(duration);
    const durationInstruction = durationText
        ? `Skip forward roughly ${durationText} of in-story time from this point.`
        : `Choose an amount of in-story time to skip forward that fits the scene naturally, and state roughly how much passed as part of the narration.`;

    const summary = durationText ? `time skip — roughly ${durationText} later` : `time skip (model-chosen duration)`;
    state.recentEvents.push(summary);
    trimHistory(cfg, state);
    state.lastEventOrigin = { summary, detail: summary };

    return `[STORY DIRECTOR TIME SKIP — ${durationInstruction} Do not play out the skipped time beat-by-beat: briefly imply or summarize anything relevant that happened off-screen in a sentence or two at most, then land the scene in the new moment ready to continue naturally from there. Preserve everything already established about the characters, relationship, and plot — the skip moves time forward, it does not reset or contradict anything. ${TIME_SKIP_PACING_NOTE} ${COMPLETENESS_NOTE} ${ANTI_LEAK_NOTE}]${buildGroundingBlock(cfg)}`;
}

// ----------------------------------------------------------------------------
// Prompt preview — a debug/pro tool that computes what buildInjectionText() /
// buildFollowUpInjectionText() / buildTimeSkipInjectionText() would produce
// right now, WITHOUT mutating real chat state (no pushed history, no
// consumed manualPick, nothing saved). Runs each builder against a deep
// clone of the actual state so all the existing branching logic (manual
// pick, Fixed Pool, AI mode, grounding) is reused as-is instead of
// duplicated. Safe because chatMetadata is always JSON-plain data.
// ----------------------------------------------------------------------------

function cloneStateForPreview(state) {
    try {
        return JSON.parse(JSON.stringify(state));
    } catch (e) {
        return { ...state, recentEvents: [...(state.recentEvents || [])] };
    }
}

function previewInjectionText(cfg, state, kind) {
    const clone = cloneStateForPreview(state);
    if (kind === "timeskip") {
        return buildTimeSkipInjectionText(cfg, clone, rollTimeSkipDuration(cfg));
    }
    if (kind === "followup") {
        if (!clone.pendingFollowUp) return null;
        return buildFollowUpInjectionText(cfg, clone, clone.pendingFollowUp);
    }
    if (kind === "diary") {
        return buildDiaryInjectionText(cfg, clone);
    }
    return buildInjectionText(cfg, clone);
}

// ----------------------------------------------------------------------------
// Hook: right before the prompt is assembled for generation, decide whether
// to fire, and if so inject the instruction via setExtensionPrompt so it
// rides along inside the SAME generation call the user already triggered.
// ----------------------------------------------------------------------------

const EXTENSION_PROMPT_KEY = "story_director_injection";

function clearInjection() {
    const context = getContext();
    if (typeof context.setExtensionPrompt === "function") {
        context.setExtensionPrompt(EXTENSION_PROMPT_KEY, "", 1, 0);
    }
}

function onBeforeGenerate(type, _options, dryRun) {
    // GENERATION_STARTED fires for every Generate() call, not just a normal
    // {{char}} reply — including background "quiet" prompts other
    // extensions/ST core send to the model, drafting a suggestion while the
    // user "impersonates" themselves, and token-count dry runs. None of
    // those are an actual story turn, so treat them as a no-op: previously
    // this function had no idea which kind of call it was and rolled the
    // dice / advanced tension / burned a forceNextEvent flag on all of them.
    if (dryRun) return;
    if (type === "quiet" || type === "impersonate") return;

    const settings = ensureSettings();
    if (!settings.globalEnabled) return;

    const cfg = getChatSettings();
    if (!cfg.enabled) return;

    const state = getChatState();

    // A swipe/regenerate is a redo of the SAME turn, not a new one — the
    // extension prompt already set (or intentionally left cleared) for this
    // slot on the first attempt is still correct, so leave it alone instead
    // of re-rolling and double-advancing tension/messagesSinceEvent for
    // what is conceptually still just one turn.
    if (type === "swipe" || type === "regenerate") return;

    // Follow-up countdown ticks every generation call, independent of
    // whether a normal (fixed/random/tension) event also fires this turn.
    let dueFollowUp = null;
    if (state.pendingFollowUp) {
        state.pendingFollowUp.turnsLeft -= 1;
        if (state.pendingFollowUp.turnsLeft <= 0) {
            dueFollowUp = state.pendingFollowUp;
            state.pendingFollowUp = null;
        }
    }

    // Cooldown window right after a Time Skip fired (see below) — suppresses
    // only the AUTOMATIC rolls (normal random/interval/tension and Time
    // Skip's own auto-chance) for one turn, so the story doesn't jump
    // forward and then immediately get hit with another random event on the
    // very next line. A due follow-up or an explicit manual "fire now" /
    // "skip time now" click always still goes through regardless.
    const inCooldown = (state.cooldownTurns || 0) > 0;
    if (inCooldown) state.cooldownTurns -= 1;

    // Time Skip takes priority over a fresh normal-event roll (the two are
    // mutually exclusive per turn — firing both would double up on prompt
    // text for no benefit), but a due follow-up still wins over both: a
    // thread already promised on schedule takes priority over new dice
    // rolls, same reasoning as before.
    const forcedTimeSkip = cfg.timeSkipEnabled && !!state.forceNextTimeSkip;
    const autoTimeSkip = !inCooldown && evaluateTimeSkipTrigger(cfg);
    const isTimeSkip = !dueFollowUp && (forcedTimeSkip || autoTimeSkip);

    // A due follow-up takes priority this turn — it IS this turn's event,
    // rather than competing with the normal trigger roll. A "fire now"
    // request from the settings popup (state.forceNextEvent) takes priority
    // over the normal trigger roll too, but not over a due follow-up — a
    // scheduled thread still gets to resolve on schedule.
    const forcedEvent = !!state.forceNextEvent;
    const autoNormalEvent = !inCooldown && evaluateTrigger(cfg, state);
    const shouldFireNormalEvent = !isTimeSkip && (dueFollowUp ? true : forcedEvent || autoNormalEvent);
    const shouldFire = isTimeSkip || shouldFireNormalEvent;

    let mainText = null;
    let mainEventFired = false;

    if (shouldFire) {
        const wasManualPick = !!state.manualPick;
        const text = isTimeSkip
            ? buildTimeSkipInjectionText(cfg, state, rollTimeSkipDuration(cfg))
            : dueFollowUp
            ? buildFollowUpInjectionText(cfg, state, dueFollowUp)
            : buildInjectionText(cfg, state);

        if (text) {
            mainText = text;
            mainEventFired = true;

            // Stats snapshot — capture the streak length BEFORE resetAfterEvent
            // zeroes it back out.
            state.totalFired = (state.totalFired || 0) + 1;
            state.longestGap = Math.max(state.longestGap || 0, state.messagesSinceEvent || 0);

            resetAfterEvent(state);
            state.forceNextEvent = false;
            state.forceNextTimeSkip = false;

            // Manual picks and normal Fixed Pool picks are both "fixed" for
            // rating/stats purposes — a manual pick is still a Fixed Pool entry,
            // just chosen by hand instead of by the dice.
            const kind = isTimeSkip ? "timeskip" : dueFollowUp ? "followup" : (wasManualPick ? "fixed" : (cfg.eventSourceMode === "ai" ? "ai" : "fixed"));
            const firedSummary = state.lastEventOrigin && state.lastEventOrigin.summary;
            state.lastFiredEvent = { summary: firedSummary, kind, time: new Date().toISOString() };
            logEvent(state, firedSummary, kind);

            if (cfg.soundEnabled && firedSummary) {
                playEventSound(cfg.soundStyle);
            }

            if (isTimeSkip) {
                // A skip conceptually closes out the current moment — a
                // follow-up thread promised before the skip no longer makes
                // sense pointed at a scene that's now in the past, and a
                // skip doesn't chain a follow-up of its own.
                if (cfg.timeSkipResetCounters) {
                    state.pendingFollowUp = null;
                    state.cooldownTurns = 1;
                }
            } else {
                // Chain a further follow-up off whichever event just fired
                // (either a fresh one, or this follow-up escalating again).
                const chainDepth = dueFollowUp ? dueFollowUp.chainDepth : 0;
                maybeScheduleFollowUp(cfg, state, state.lastEventOrigin, chainDepth);
            }
        }
    }

    if (!mainEventFired) {
        // A pick that couldn't be honored (e.g. an empty Fixed Pool) still
        // shouldn't leave a force-fire request stuck on.
        state.forceNextEvent = false;
        state.forceNextTimeSkip = false;
    }

    // Character Diary — independent of everything above, and deliberately
    // allowed to co-occur with an event/Time Skip in the same generation
    // call: it's a separate hidden addendum, not a change to the scene
    // itself, so there's no real conflict in asking for both at once.
    let diaryText = null;
    if (cfg.diaryEnabled) {
        state.diaryMessagesSinceEntry = (state.diaryMessagesSinceEntry || 0) + 1;
        const forcedDiary = !!state.forceNextDiary;
        const intervalDue = cfg.diaryUseFixedInterval && state.diaryMessagesSinceEntry >= Math.max(1, cfg.diaryFixedIntervalN || 1);
        const randomHit = cfg.diaryUseRandom && Math.random() * 100 < Math.min(100, Math.max(0, cfg.diaryRandomChance || 0));

        if (forcedDiary || intervalDue || randomHit) {
            diaryText = buildDiaryInjectionText(cfg, state);
            state.diaryMessagesSinceEntry = 0;
            state.awaitingDiaryCapture = true;
        }
        state.forceNextDiary = false;
    }

    // Single combined injection — both pieces (if both fired) ride along in
    // the one generation call the user already triggered, no extra request.
    const combinedText = [mainText, diaryText].filter(Boolean).join("\n\n");
    if (combinedText) {
        const context = getContext();
        // position 1 = "in-chat" / near end of prompt; depth 0 = closest to
        // the newest message. Adjust depth if you want it further back.
        if (typeof context.setExtensionPrompt === "function") {
            context.setExtensionPrompt(EXTENSION_PROMPT_KEY, combinedText, 1, 0);
        }
    } else {
        clearInjection();
    }

    if (!mainEventFired) {
        advanceTensionAndCounter(cfg, state);
    }

    saveChatState();
    updateTensionBarUI(state);
}

// ----------------------------------------------------------------------------
// UI — Wand menu button + settings popup
// ----------------------------------------------------------------------------

function updateTensionBarUI(state) {
    const fill = document.querySelector(".sd-tension-bar-fill");
    if (fill) fill.style.width = `${state.tension}%`;
    const valueText = document.getElementById("sd-tension-value-text");
    if (valueText) valueText.textContent = state.tension;
}

function renderTagPicker(cfg) {
    return THEME_TAGS.map((tag) => {
        const active = cfg.tags.includes(tag) ? "active" : "";
        return `<span class="sd-tag ${active}" data-tag="${tag}">${tag}</span>`;
    }).join("");
}

const HISTORY_KIND_LABELS = {
    fixed: "Fixed Pool",
    ai: "AI สร้าง",
    followup: "ต่อเนื่อง",
    timeskip: "ข้ามเวลา",
};

function renderFullHistory(state) {
    const log = Array.isArray(state.eventLog) ? state.eventLog : [];
    if (log.length === 0) {
        return `<div class="sd-help">(ยังไม่มีประวัติ)</div>`;
    }
    return log
        .slice()
        .reverse()
        .map((entry) => {
            let timeLabel = "";
            try {
                timeLabel = new Date(entry.time).toLocaleString("th-TH", {
                    day: "2-digit",
                    month: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                });
            } catch (e) {
                timeLabel = "";
            }
            const kindLabel = HISTORY_KIND_LABELS[entry.kind] || entry.kind || "";
            return `<div class="sd-log-entry">
                <span class="sd-log-time">${escapeHtml(timeLabel)}</span>
                <span class="sd-log-kind">[${escapeHtml(kindLabel)}]</span>
                <span class="sd-log-summary">${escapeHtml(entry.summary)}</span>
            </div>`;
        })
        .join("");
}

const WEIGHT_STEP = 0.5;
const WEIGHT_MIN = 0.1;
const WEIGHT_MAX = 20;

// Adjusts the weight of the Fixed Pool entry matching the most recently
// fired event's summary. Matches by summary text (not array index) so it
// still works even if the pool was reordered since that event fired.
// Mutates the live cfg directly (and mirrors into draft) so the rating
// takes effect immediately, same as the other quick actions.
function adjustLastFiredWeight(cfg, draft, state, delta) {
    const last = state.lastFiredEvent;
    if (!last || last.kind !== "fixed") return null;
    const idx = cfg.fixedPool.findIndex((e) => e.summary === last.summary);
    if (idx === -1) return null;

    const current = typeof cfg.fixedPool[idx].weight === "number" ? cfg.fixedPool[idx].weight : 1;
    const next = Math.round(Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, current + delta)) * 10) / 10;
    cfg.fixedPool[idx].weight = next;
    if (draft.fixedPool[idx]) draft.fixedPool[idx].weight = next;
    saveSettingsDebounced();

    const poolEl = document.getElementById("sd-pool-text");
    if (poolEl) poolEl.value = renderPoolTextarea(draft);

    return next;
}

function computeStats(state) {
    const log = Array.isArray(state.eventLog) ? state.eventLog : [];
    const kindCounts = { fixed: 0, ai: 0, followup: 0, timeskip: 0 };
    const summaryCounts = {};
    for (const entry of log) {
        if (kindCounts[entry.kind] !== undefined) kindCounts[entry.kind] += 1;
        summaryCounts[entry.summary] = (summaryCounts[entry.summary] || 0) + 1;
    }
    let topSummary = null;
    let topCount = 0;
    for (const [summary, count] of Object.entries(summaryCounts)) {
        if (count > topCount) {
            topSummary = summary;
            topCount = count;
        }
    }
    return {
        totalFired: state.totalFired || 0,
        longestGap: state.longestGap || 0,
        kindCounts,
        topSummary,
        topCount,
    };
}

function renderStatsPanel(state) {
    const s = computeStats(state);
    const topLine = s.topSummary
        ? `เหตุการณ์ที่ออกบ่อยสุด: "${escapeHtml(truncateText(s.topSummary, 50))}" (${s.topCount} ครั้ง)`
        : "ยังไม่มีข้อมูลพอสำหรับสถิตินี้";
    return `
        <div class="sd-stat-row"><span>เหตุการณ์ที่เกิดทั้งหมด</span><span>${s.totalFired} ครั้ง</span></div>
        <div class="sd-stat-row"><span>นิ่งนานสุดก่อนมีเหตุการณ์</span><span>${s.longestGap} ข้อความ</span></div>
        <div class="sd-stat-row"><span>Fixed Pool / AI สร้าง / ต่อเนื่อง / ข้ามเวลา</span><span>${s.kindCounts.fixed} / ${s.kindCounts.ai} / ${s.kindCounts.followup} / ${s.kindCounts.timeskip}</span></div>
        <div class="sd-help" style="margin-top:6px;">${topLine}</div>
    `;
}

function renderLastFiredRatingBlock(state) {
    const last = state.lastFiredEvent;
    if (!last) {
        return `<div class="sd-help">ยังไม่มีเหตุการณ์ล่าสุดให้ดูในขณะนี้</div>`;
    }
    const label = `${HISTORY_KIND_LABELS[last.kind] || last.kind}: "${escapeHtml(truncateText(last.summary, 60))}"`;
    if (last.kind !== "fixed") {
        return `<div class="sd-help">เหตุการณ์ล่าสุด: ${label}<br/>สามารถให้คะแนนได้เฉพาะเหตุการณ์ที่มาจากรายการ <b>Fixed Pool</b> ที่ผู้ใช้เขียนไว้เองเท่านั้น</div>`;
    }
    return `
        <div class="sd-help">เหตุการณ์ล่าสุด: ${label}</div>
        <div class="sd-row">
            <button type="button" class="menu_button" id="sd-rate-up-btn">ถูกใจ (เพิ่มน้ำหนัก)</button>
            <button type="button" class="menu_button" id="sd-rate-down-btn">ไม่ถูกใจ (ลดน้ำหนัก)</button>
        </div>
        <div class="sd-help" id="sd-rate-status"></div>
    `;
}

function renderPoolTextarea(cfg) {
    // Simple line-based format: "summary :: detail :: #tag1,tag2" per line,
    // easy to hand-edit. The trailing #tags segment is optional — leave it
    // out for an event with no per-event tags.
    return cfg.fixedPool
        .map((e) => {
            const tagsPart = e.tags && e.tags.length ? ` :: #${e.tags.join(",")}` : "";
            const weightPart = e.weight && e.weight !== 1 ? ` :: x${e.weight}` : "";
            return `${e.summary} :: ${e.detail || ""}${tagsPart}${weightPart}`;
        })
        .join("\n");
}

// A small catalog of notification sounds, bundled as audio files inside this
// extension's own "sounds" folder (so nothing needs to be fetched from
// outside SillyTavern). Each entry just points at its file relative to the
// extension folder.
const SOUND_STYLES = {
    notif1: { label: "เสียงแจ้งเตือน 1 (ค่าเริ่มต้น)", file: "sounds/notif-1.mp3" },
    notif2: { label: "เสียงแจ้งเตือน 2", file: "sounds/notif-2.mp3" },
    notif3: { label: "เสียงแจ้งเตือน 3", file: "sounds/notif-3.mp3" },
    notif4: { label: "เสียงแจ้งเตือน 4", file: "sounds/notif-4.mp3" },
    notif5: { label: "เสียงแจ้งเตือน 5", file: "sounds/notif-5.mp3" },
};
const DEFAULT_SOUND_STYLE = "notif1";

// A small catalog of mood stickers, bundled as image files inside this
// extension's own "stickers" folder (same bundling approach as
// SOUND_STYLES above — nothing fetched from outside SillyTavern). Each
// entry lists Thai keywords that, if found inside the model-written MOOD
// field, pick that sticker. Checked in order, first match wins, so more
// specific keyword sets should stay near entries they could be confused
// with (e.g. distinct wording for "เบาใจ" vs "โล่งใจ").
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
    { file: "mood-pinkheart.png", keywords: ["รัก", "ผูกพัน", "คิดถึง", "หวงแหน"] },
    { file: "mood-rabbit.png", keywords: ["เอ็นดู", "ละมุน", "น่ารัก", "อ่อนโยน"] },
    { file: "mood-candle.png", keywords: ["หวัง", "ปรารถนา", "อธิษฐาน", "ใฝ่ฝัน"] },
    { file: "mood-flower.png", keywords: ["เริ่มต้นใหม่", "สดชื่น", "เบ่งบาน", "ฟื้นตัว"] },
];

function pickMoodStickerFile(moodText) {
    if (!moodText) return null;
    const text = String(moodText);
    for (const entry of MOOD_STICKERS) {
        if (entry.keywords.some((kw) => text.includes(kw))) return entry.file;
    }
    return null;
}

function resolveStickerUrl(file) {
    return new URL(`stickers/${file}`, EXTENSION_BASE_URL).href;
}

// Sound files are bundled next to this very file (in ./sounds/), so we
// resolve their URL relative to *this module's own URL* rather than a
// hardcoded path. A hardcoded "scripts/extensions/third-party/story-director"
// string breaks silently the moment the extension folder is renamed, nested
// differently, or SillyTavern is served from a sub-path — the Audio element
// 404s and rejects its play() promise, which is exactly the "test button
// and real events both make no sound" symptom. import.meta.url always
// points at wherever this index.js actually got loaded from, so it stays
// correct no matter how/where the extension is installed.
const EXTENSION_BASE_URL = new URL(".", import.meta.url);

// Cache Audio objects per style so repeated plays don't re-fetch the file,
// and clone them on play so overlapping triggers don't cut each other off.
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

        // Clone so a second event firing quickly doesn't restart/cut the first.
        const player = base.cloneNode(true);
        player.volume = 0.6;
        const playPromise = player.play();
        if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch((e) => {
                // Most commonly the browser blocking autoplay before any user
                // gesture on the page yet — safe to ignore.
                console.warn("[Story Director] Sound playback blocked or failed:", e);
            });
        }
    } catch (e) {
        console.warn("[Story Director] Sound playback failed:", e);
    }
}

function renderManualPickList(cfg) {
    if (!cfg.fixedPool.length) {
        return `<div class="sd-help">(ยังไม่มีเหตุการณ์ที่เขียนไว้ให้เลือก กรุณาเพิ่มรายการในช่อง Fixed Pool ด้านล่างก่อน)</div>`;
    }
    return cfg.fixedPool
        .map(
            (e, i) => `
        <div class="sd-pick-row">
            <span class="sd-pick-summary">${escapeHtml(truncateText(e.summary, 55))}</span>
            <button type="button" class="menu_button sd-pick-btn" data-pick-index="${i}">ยิงอันนี้</button>
        </div>`
        )
        .join("");
}

function parsePoolTextarea(text) {
    return text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const parts = line.split("::").map((p) => p.trim());
            const summary = parts[0] || "";
            let detailParts = parts.slice(1);
            let tags = [];
            let weight = 1;

            // Optional trailing weight segment, written as "x" + a number
            // (e.g. "x3"), so it never collides with a plain number that
            // happens to appear inside the detail text itself. It can come
            // either right after the tags segment or right after detail if
            // there are no tags.
            const weightSeg = detailParts[detailParts.length - 1];
            if (weightSeg && /^x\d+(\.\d+)?$/i.test(weightSeg)) {
                const parsed = parseFloat(weightSeg.slice(1));
                if (parsed > 0) weight = parsed;
                detailParts = detailParts.slice(0, -1);
            }

            const last = detailParts[detailParts.length - 1];
            if (last && last.startsWith("#")) {
                tags = last
                    .slice(1)
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean);
                detailParts = detailParts.slice(0, -1);
            }

            return {
                summary,
                detail: detailParts.join("::").trim(),
                tags,
                weight,
            };
        });
}

function buildPopupHtml(cfg, state) {
    return `
    <div class="sd-popup">
        <div class="sd-accordion" id="sd-accordion">
            <div class="sd-accordion-item" data-tab-panel="general">
                <button type="button" class="sd-accordion-header" aria-expanded="true">
                    <span class="sd-accordion-title">ทั่วไป</span>
                    <span class="sd-accordion-caret">▾</span>
                </button>
                <div class="sd-accordion-body" data-acc-body="general">
            <div class="sd-row">
                <label><input type="checkbox" id="sd-enabled" ${cfg.enabled ? "checked" : ""}/> เปิดใช้งานกับแชทนี้</label>
            </div>
            <div class="sd-help">สามารถปิดใช้งานชั่วคราวได้หากต้องการพักระบบทั้งหมดของแชทนี้ การตั้งค่าที่บันทึกไว้จะยังคงอยู่ครบถ้วน และสามารถเปิดกลับมาใช้งานได้ทุกเมื่อ</div>

            <div class="sd-row">
                <label>รูปแบบการนำเสนอ</label>
                <select id="sd-presentation">
                    <option value="subtle" ${cfg.presentation === "subtle" ? "selected" : ""}>แบบแนบเนียน</option>
                    <option value="narrator" ${cfg.presentation === "narrator" ? "selected" : ""}>ผู้บรรยาย/GM แทรก</option>
                    <option value="both" ${cfg.presentation === "both" ? "selected" : ""}>ให้โมเดลเลือกเอง</option>
                </select>
            </div>
            <div class="sd-help">เลือกรูปแบบการนำเสนอเหตุการณ์ในเนื้อเรื่อง<br/><b>แบบแนบเนียน</b>: เหตุการณ์จะถูกสอดแทรกเข้าเป็นส่วนหนึ่งของเนื้อเรื่องตามปกติ โดยไม่มีการระบุอย่างชัดเจนว่ามีเหตุการณ์เกิดขึ้น และไม่ใช่การให้ตัวละครพูดถึงเหตุการณ์นั้นโดยตรง<br/><b>ผู้บรรยาย/GM แทรก</b>: เหตุการณ์จะปรากฏเป็นข้อความแยกต่างหากที่เห็นได้ชัดเจนว่าไม่ใช่ส่วนหนึ่งของเนื้อเรื่อง<br/><b>ให้โมเดลเลือกเอง</b>: โมเดลจะเป็นผู้พิจารณาเลือกรูปแบบที่เหมาะสมกับแต่ละฉากด้วยตนเอง</div>

            <div class="sd-row" style="margin-top:10px;">
                <button type="button" class="menu_button" id="sd-force-btn">สั่งเหตุการณ์ในข้อความถัดไปทันที</button>
            </div>
            <div class="sd-help">เมื่อกดปุ่มนี้ ข้อความถัดไปจะมีเหตุการณ์เกิดขึ้นทันที โดยไม่ต้องรอการสุ่มหรือรอมิเตอร์ (ยังคงใช้แหล่งเหตุการณ์และรูปแบบเดิมที่ตั้งค่าไว้) การกดมีผลทันทีโดยไม่ต้องกดปุ่ม <b>บันทึก</b> แต่หากมีเหตุการณ์ต่อเนื่องที่นัดหมายไว้ล่วงหน้าอยู่ก่อนแล้ว เหตุการณ์นั้นจะเกิดขึ้นก่อนตามลำดับเดิม</div>

            <div class="sd-row">
                <label><input type="checkbox" id="sd-sound-enabled" ${cfg.soundEnabled ? "checked" : ""}/> เล่นเสียงสั้นๆ ตอนมีเหตุการณ์เกิดขึ้น</label>
            </div>
            <div class="sd-row">
                <label>เลือกเสียง</label>
                <select id="sd-sound-style">
                    ${Object.entries(SOUND_STYLES).map(([key, s]) => `<option value="${key}" ${cfg.soundStyle === key ? "selected" : ""}>${escapeHtml(s.label)}</option>`).join("")}
                </select>
                <button type="button" class="menu_button" id="sd-sound-test-btn">ลองฟังเสียง</button>
            </div>
            <div class="sd-help">เสียงสั้น ๆ ที่จะเล่นทุกครั้งเมื่อมีเหตุการณ์เกิดขึ้น สามารถกดปุ่ม <b>ลองฟังเสียง</b> เพื่อฟังตัวอย่างได้ทันที โดยไม่ต้องกดปุ่ม <b>บันทึก</b> ก่อน</div>

            <div class="sd-row" style="margin-top:16px; border-top:1px solid var(--SmartThemeBorderColor, #444); padding-top:12px;">
                <button type="button" class="menu_button" id="sd-reset-defaults-btn">รีเซ็ตการตั้งค่าแชทนี้เป็นค่าเริ่มต้น</button>
            </div>
            <div class="sd-help">รีเซ็ตการตั้งค่าทุกหมวด (ทั่วไป, เหตุการณ์, ไดอารี่, ความสัมพันธ์) กลับเป็นค่าเริ่มต้น <b>เฉพาะแชทนี้เท่านั้น</b> โดยไม่มีผลต่อแชทอื่น และไม่ลบรายการ Fixed Pool แท็กที่เลือกไว้ ประวัติเหตุการณ์ สถิติ ไดอารี่ หรือค่าความสัมพันธ์ การเปลี่ยนแปลงจะปรากฏในหน้าต่างนี้ทันที แต่ต้องกดปุ่ม <b>บันทึก</b> ด้านล่างสุดก่อน การรีเซ็ตจึงจะมีผลถาวร</div>

            <div class="sd-subsection">
                <h4>นำเข้า/ส่งออก</h4>
                <div class="sd-row sd-io-row">
                    <button type="button" class="menu_button" id="sd-export-btn">ส่งออกเป็นไฟล์ .json</button>
                    <button type="button" class="menu_button" id="sd-import-btn">นำเข้าจากไฟล์ .json</button>
                    <input type="file" id="sd-import-file" accept="application/json,.json" style="display:none" />
                </div>
                <div class="sd-help" id="sd-io-status">สามารถบันทึกชุดการตั้งค่าของแชทนี้เป็นไฟล์สำรอง หรือนำไปใช้กับแชท/ตัวละครอื่นได้ (ไม่รวมค่าความตึงเครียดและประวัติเหตุการณ์ เนื่องจากเป็นข้อมูลเฉพาะของแชทนี้) เมื่อนำเข้าไฟล์แล้ว ต้องกดปุ่ม <b>บันทึก</b> อีกครั้งเพื่อให้การตั้งค่ามีผลใช้งานจริง</div>
            </div>
                </div>
            </div>

            <div class="sd-accordion-item" data-tab-panel="events">
                <button type="button" class="sd-accordion-header" aria-expanded="false">
                    <span class="sd-accordion-title">เหตุการณ์</span>
                    <span class="sd-accordion-caret">▾</span>
                </button>
                <div class="sd-accordion-body" data-acc-body="events" hidden>
            <div class="sd-subsection">
                <h4>มิเตอร์ความตึงเครียด (Tension)</h4>
                <div class="sd-tension-bar-wrap">
                    <div class="sd-tension-bar-fill" style="width:${state.tension}%"></div>
                </div>
                <div class="sd-help">ค่าปัจจุบันของแชทนี้อยู่ที่ <b id="sd-tension-value-text">${state.tension}</b> / 100 ยิ่งค่าสูง เหตุการณ์ยิ่งมีโอกาสเกิดขึ้นง่ายขึ้น เมื่อเหตุการณ์เกิดขึ้นแล้ว ค่านี้จะรีเซ็ตกลับไปที่ 0 ทันที</div>

                <div class="sd-row" style="margin-top:8px;">
                    <label><input type="checkbox" id="sd-tension-enabled" ${cfg.tensionEnabled ? "checked" : ""}/> เปิดใช้การติดตามความตึงเครียด</label>
                </div>
                <div class="sd-help">สามารถปิดใช้งานได้หากไม่ต้องการให้ความนิ่งของเรื่องมีผลใด ๆ โดยโอกาสเกิดเหตุการณ์จะใช้เพียงค่าเปอร์เซ็นต์คงที่ด้านล่างเท่านั้น และจะไม่เพิ่มขึ้นเองไม่ว่าเรื่องจะนิ่งเพียงใด</div>

                <div class="sd-row">
                    <label>โหมดการสะสมค่า</label>
                    <select id="sd-tension-mode">
                        <option value="fixed" ${cfg.tensionGainMode === "fixed" ? "selected" : ""}>คงที่</option>
                        <option value="random" ${cfg.tensionGainMode === "random" ? "selected" : ""}>ช่วงสุ่ม</option>
                    </select>
                </div>
                <div class="sd-help"><b>คงที่</b>: ค่าจะเพิ่มขึ้นเท่ากันทุกข้อความ คาดเดาจังหวะได้ง่าย<br/><b>ช่วงสุ่ม</b>: ค่าจะเพิ่มขึ้นไม่เท่ากันในแต่ละครั้ง คาดเดาจังหวะได้ยากขึ้นและสร้างความประหลาดใจมากกว่า</div>

                <div class="sd-row">
                    <label>ค่าคงที่ที่เพิ่มต่อข้อความ</label>
                    <input type="number" id="sd-tension-fixed" value="${cfg.tensionGainFixed}" min="1" max="100"/>
                </div>
                <div class="sd-help">ใช้เมื่อเลือกโหมด <b>คงที่</b> ด้านบน โดยค่านี้จะถูกบวกเพิ่มเท่ากันทุกข้อความ</div>

                <div class="sd-row">
                    <label>ช่วงสุ่มค่าที่เพิ่ม (ต่ำสุด / สูงสุด)</label>
                    <input type="number" id="sd-tension-min" value="${cfg.tensionGainMin}" min="1" max="100"/>
                    <input type="number" id="sd-tension-max" value="${cfg.tensionGainMax}" min="1" max="100"/>
                </div>
                <div class="sd-help">ใช้เมื่อเลือกโหมด <b>ช่วงสุ่ม</b> ด้านบน โดยแต่ละข้อความจะสุ่มค่าที่จะบวกเพิ่มภายในช่วงที่กำหนดนี้</div>

                <div class="sd-row">
                    <label>โอกาสที่เพิ่มสูงสุดเมื่อมิเตอร์เต็ม (%)</label>
                    <input type="number" id="sd-tension-boost" value="${cfg.tensionBoostMax}" min="0" max="100"/>
                </div>
                <div class="sd-help">เมื่อมิเตอร์เต็ม 100 โอกาสเกิดเหตุการณ์ด้านล่างจะถูกบวกเพิ่มทันที ยิ่งเรื่องนิ่งนาน โอกาสก็จะยิ่งสูงขึ้นเรื่อย ๆ เพื่อไม่ให้เรื่องหยุดนิ่งนานเกินไป</div>

                <div class="sd-row">
                    <label>ค่าที่บังคับให้เกิดเหตุการณ์ทันที</label>
                    <input type="number" id="sd-tension-cap" value="${cfg.tensionForceCap}" min="1" max="100"/>
                </div>
                <div class="sd-help">เมื่อมิเตอร์แตะค่านี้ เหตุการณ์จะเกิดขึ้นในข้อความถัดไปทันที โดยไม่ขึ้นกับผลการสุ่ม สามารถตั้งเป็น 100 หากต้องการให้เกิดขึ้นแบบบังคับก็ต่อเมื่อมิเตอร์เต็มเท่านั้น</div>
            </div>

            <div class="sd-subsection" style="margin-top:10px;">
                <h4>รูปแบบการเกิดเหตุการณ์</h4>
                <div class="sd-row">
                    <label><input type="checkbox" id="sd-use-fixed-interval" ${cfg.useFixedInterval ? "checked" : ""}/> ทุกช่วงคงที่ (ทุก N ข้อความ)</label>
                    <input type="number" id="sd-fixed-interval-n" value="${cfg.fixedIntervalN}" min="1" max="200"/>
                </div>
                <div class="sd-help">เมื่อเปิดใช้งาน เหตุการณ์จะเกิดขึ้นทุก ๆ N ข้อความอย่างแน่นอน เหมาะสำหรับผู้ที่ต้องการจังหวะเรื่องที่สม่ำเสมอ<br/>หากรู้สึกว่าเรื่องวนซ้ำหรือหยุดนิ่ง สามารถลดค่า N ลง (เช่น 4-6) เพื่อให้เหตุการณ์เกิดขึ้นบ่อยขึ้นโดยไม่ต้องรอมิเตอร์</div>

                <div class="sd-row">
                    <label><input type="checkbox" id="sd-use-random" ${cfg.useRandom ? "checked" : ""}/> สุ่มโอกาสทุกข้อความ (%)</label>
                    <input type="number" id="sd-random-chance" value="${cfg.randomBaseChance}" min="0" max="100"/>
                </div>
                <div class="sd-help">โอกาสเริ่มต้นที่เหตุการณ์จะเกิดขึ้นในแต่ละข้อความ หากเปิดใช้งานมิเตอร์ความตึงเครียดไว้ด้วย ค่านี้จะถูกบวกเพิ่มขึ้นเองตามความนิ่งของเรื่อง</div>

                <div class="sd-row" style="margin-top:10px;">
                    <label>ความรุนแรงของเหตุการณ์</label>
                    <select id="sd-event-intensity">
                        <option value="mild" ${cfg.eventIntensity === "mild" ? "selected" : ""}>นุ่มนวล: จุดสีสันเล็กน้อย</option>
                        <option value="medium" ${cfg.eventIntensity === "medium" ? "selected" : ""}>ปานกลาง: เปลี่ยนแปลงชัดเจน</option>
                        <option value="disruptive" ${cfg.eventIntensity === "disruptive" ? "selected" : ""}>พลิกสถานการณ์แรง: ทำลายรูปแบบเดิม</option>
                    </select>
                </div>
                <div class="sd-help">กำหนดระดับความรุนแรงของเหตุการณ์ที่จะเกิดขึ้น<br/>เลือก <b>พลิกสถานการณ์แรง</b> หากต้องการให้เหตุการณ์เปลี่ยนสถานที่ สถานการณ์ หรือเดิมพันอย่างจริงจัง ไม่ใช่เพียงจุดสีสันเล็กน้อยที่กลืนหายไปกับฉากเดิม เหมาะสำหรับกรณีที่รู้สึกว่าเรื่องวนซ้ำหรือหยุดนิ่งเกินไป</div>
            </div>

            <div class="sd-subsection" style="margin-top:10px;">
                <h4>เหตุการณ์ต่อเนื่อง (Follow-up)</h4>
                <div class="sd-row">
                    <label><input type="checkbox" id="sd-followup-enabled" ${cfg.followUpEnabled ? "checked" : ""}/> เปิดใช้เหตุการณ์ต่อเนื่อง</label>
                </div>
                <div class="sd-help">เมื่อมีเหตุการณ์เกิดขึ้น ระบบอาจนัดหมายให้เธรดเดิมกลับมาสานต่อหรือทวีความเข้มข้นขึ้นในอีกไม่กี่ข้อความถัดไป แทนที่จะสุ่มเหตุการณ์ใหม่ที่ไม่เกี่ยวข้องกันอย่างต่อเนื่อง โมเดลจะทบทวนความคืบหน้าของเรื่องก่อนสานต่อให้กลมกลืน</div>

                <div class="sd-row">
                    <label>โอกาสนัดต่อเนื่องเมื่อมีเหตุการณ์เกิด (%)</label>
                    <input type="number" id="sd-followup-chance" value="${cfg.followUpChance}" min="0" max="100"/>
                </div>
                <div class="sd-help">ทุกครั้งที่มีเหตุการณ์เกิดขึ้น (ไม่ว่าจะเป็นเหตุการณ์ใหม่หรือเหตุการณ์ต่อเนื่อง) จะมีโอกาสตามค่านี้ที่จะถูกนัดหมายให้สานต่ออีกครั้ง</div>

                <div class="sd-row">
                    <label>ระยะห่างก่อนเหตุการณ์ต่อเนื่องจะมาถึง (ข้อความ ต่ำสุด/สูงสุด)</label>
                    <input type="number" id="sd-followup-delay-min" value="${cfg.followUpDelayMin}" min="1" max="50"/>
                    <input type="number" id="sd-followup-delay-max" value="${cfg.followUpDelayMax}" min="1" max="50"/>
                </div>
                <div class="sd-help">หลังจากเหตุการณ์ต้นทางเกิดขึ้น ระบบจะสุ่มจำนวนข้อความที่ต้องรอภายในช่วงนี้ ก่อนที่เหตุการณ์ต่อเนื่องจะถูกแทรกเข้ามา</div>

                <div class="sd-row">
                    <label>จำนวนครั้งสูงสุดที่ต่อเนื่องกันได้ในสายเดียว</label>
                    <input type="number" id="sd-followup-max-chain" value="${cfg.followUpMaxChain}" min="0" max="10"/>
                </div>
                <div class="sd-help">ป้องกันไม่ให้เธรดเดียวสานต่อไม่มีที่สิ้นสุด เช่น ตั้งค่าเป็น 2 หมายถึงสามารถสานต่อได้สูงสุด 2 ครั้ง ก่อนกลับไปสุ่มเหตุการณ์ใหม่ตามปกติ หากตั้งเป็น 0 จะไม่มีการสานต่อเป็นสาย (นัดหมายได้เพียงครั้งเดียว)</div>

                <div class="sd-history" id="sd-followup-status">สถานะปัจจุบัน: ${
                    state.pendingFollowUp
                        ? `นัดไว้แล้ว: "${state.pendingFollowUp.originSummary}" อีก ${state.pendingFollowUp.turnsLeft} ข้อความ`
                        : "(ยังไม่มีเหตุการณ์ต่อเนื่องที่นัดไว้)"
                }</div>
                <div class="sd-row" style="margin-top:6px;">
                    <button type="button" class="menu_button" id="sd-cancel-followup-btn" ${state.pendingFollowUp ? "" : "disabled"}>ยกเลิกเหตุการณ์ต่อเนื่องที่นัดไว้</button>
                </div>
            </div>

            <div class="sd-subsection" style="margin-top:10px;">
                <h4>ข้ามเวลา (Time Skip)</h4>
                <div class="sd-row">
                    <label><input type="checkbox" id="sd-timeskip-enabled" ${cfg.timeSkipEnabled ? "checked" : ""}/> เปิดใช้ฟีเจอร์ข้ามเวลา</label>
                </div>
                <div class="sd-help">แทนที่จะแทรกเหตุการณ์เข้าไปในฉากปัจจุบัน โมเดลจะข้ามเวลาไปข้างหน้าแทน โดยสรุปช่วงเวลาที่ข้ามอย่างสั้น ๆ แล้วเริ่มฉากใหม่ทันที ฟีเจอร์นี้เป็นระบบแยกจากเหตุการณ์ปกติด้านบน และจะไม่เกิดซ้อนกันในข้อความเดียวกัน</div>

                <div class="sd-row" style="margin-top:8px;">
                    <button type="button" class="menu_button" id="sd-timeskip-force-btn" ${cfg.timeSkipEnabled ? "" : "disabled"}>ข้ามเวลาในข้อความถัดไปทันที</button>
                </div>
                <div class="sd-help">เมื่อกดปุ่มนี้จะมีผลทันที โดยไม่ต้องกดปุ่ม <b>บันทึก</b> หากมีเหตุการณ์ต่อเนื่องที่นัดหมายไว้อยู่ก่อนแล้ว เหตุการณ์นั้นจะเกิดขึ้นก่อน เช่นเดียวกับปุ่ม <b>สั่งเหตุการณ์ทันที</b> ด้านบน</div>

                <div class="sd-row">
                    <label>โอกาสข้ามเวลาแบบสุ่มในแต่ละข้อความ (%)</label>
                    <input type="number" id="sd-timeskip-auto-chance" value="${cfg.timeSkipAutoChance}" min="0" max="100"/>
                </div>
                <div class="sd-help">ใช้งานได้เมื่อเปิด <b>ฟีเจอร์ข้ามเวลา</b> ไว้ด้านบน เป็นโอกาสที่แยกต่างหากจากเหตุการณ์ปกติ หากการข้ามเวลาเกิดขึ้นในข้อความใด เหตุการณ์ปกติจะไม่เกิดซ้อนในข้อความนั้น สามารถตั้งเป็น 0 ได้หากต้องการให้การข้ามเวลาเกิดขึ้นเฉพาะเมื่อกดปุ่มด้วยตนเองเท่านั้น</div>

                <div class="sd-row" style="margin-top:8px;">
                    <label>วิธีกำหนดระยะเวลาที่ข้าม</label>
                    <select id="sd-timeskip-duration-mode">
                        <option value="fixed" ${cfg.timeSkipDurationMode === "fixed" ? "selected" : ""}>ค่าคงที่</option>
                        <option value="random" ${cfg.timeSkipDurationMode === "random" ? "selected" : ""}>สุ่มในช่วงที่ตั้งไว้</option>
                        <option value="ai" ${cfg.timeSkipDurationMode === "ai" ? "selected" : ""}>ให้โมเดลเลือกเอง</option>
                    </select>
                </div>
                <div class="sd-help"><b>ให้โมเดลเลือกเอง</b> จะไม่กำหนดตัวเลขตายตัวไว้ล่วงหน้า แต่ให้โมเดลเป็นผู้เลือกระยะเวลาที่เหมาะสมกับฉากนั้น ๆ เอง</div>

                <div class="sd-row">
                    <label>ค่าคงที่ (ใช้เมื่อเลือกโหมดค่าคงที่)</label>
                    <input type="number" id="sd-timeskip-fixed-amount" value="${cfg.timeSkipFixedAmount}" min="1" max="999"/>
                    <select id="sd-timeskip-fixed-unit">
                        <option value="hour" ${cfg.timeSkipFixedUnit === "hour" ? "selected" : ""}>ชั่วโมง</option>
                        <option value="day" ${cfg.timeSkipFixedUnit === "day" ? "selected" : ""}>วัน</option>
                        <option value="week" ${cfg.timeSkipFixedUnit === "week" ? "selected" : ""}>สัปดาห์</option>
                    </select>
                </div>

                <div class="sd-row">
                    <label>ช่วงสุ่ม (ใช้เมื่อเลือกโหมดสุ่ม: ต่ำสุด/สูงสุด ในหน่วยเดียวกัน)</label>
                    <input type="number" id="sd-timeskip-random-min" value="${cfg.timeSkipRandomMin}" min="1" max="999"/>
                    <input type="number" id="sd-timeskip-random-max" value="${cfg.timeSkipRandomMax}" min="1" max="999"/>
                    <select id="sd-timeskip-random-unit">
                        <option value="hour" ${cfg.timeSkipRandomUnit === "hour" ? "selected" : ""}>ชั่วโมง</option>
                        <option value="day" ${cfg.timeSkipRandomUnit === "day" ? "selected" : ""}>วัน</option>
                        <option value="week" ${cfg.timeSkipRandomUnit === "week" ? "selected" : ""}>สัปดาห์</option>
                    </select>
                </div>
                <div class="sd-help">ทุกครั้งที่มีการข้ามเวลา ระบบจะสุ่มจำนวนภายในช่วงนี้ (ใช้หน่วยเดียวกันทั้งคู่) แล้วแจ้งให้โมเดลทราบโดยตรงว่าข้ามเวลาไปเท่าใด</div>

                <div class="sd-row">
                    <label><input type="checkbox" id="sd-timeskip-reset" ${cfg.timeSkipResetCounters ? "checked" : ""}/> รีเซ็ต tension/ตัวนับ + พักการสุ่ม 1 ข้อความ หลังข้ามเวลา</label>
                </div>
                <div class="sd-help">แนะนำให้เปิดใช้งาน เพื่อป้องกันไม่ให้เหตุการณ์ปกติหรือการข้ามเวลาอีกครั้งเกิดซ้อนทันทีในข้อความถัดไป และจะยกเลิกเหตุการณ์ต่อเนื่องที่นัดหมายไว้ก่อนหน้าด้วย เนื่องจากอ้างอิงถึงช่วงเวลาที่ผ่านไปแล้ว</div>
            </div>

            <div class="sd-subsection" style="margin-top:10px;">
                <h4>แหล่งที่มาของเหตุการณ์</h4>
                <div class="sd-row">
                    <label>โหมด</label>
                    <select id="sd-source-mode">
                        <option value="fixed" ${cfg.eventSourceMode === "fixed" ? "selected" : ""}>Fixed Pool (เขียนเหตุการณ์เอง)</option>
                        <option value="ai" ${cfg.eventSourceMode === "ai" ? "selected" : ""}>AI สร้างจากธีมที่เลือก</option>
                    </select>
                </div>
                <div class="sd-help"><b>Fixed Pool</b>: สุ่มจากรายการเหตุการณ์ที่ผู้ใช้เขียนไว้เอง สามารถควบคุมทิศทางของเรื่องได้อย่างแม่นยำ<br/><b>AI</b>: ให้โมเดลสร้างเหตุการณ์สดขึ้นจากธีมด้านล่าง โดยไม่ต้องเตรียมล่วงหน้าและไม่ซ้ำเดิม</div>

                <div class="sd-row">
                    <label>แท็กธีม (ใช้ตอนเลือกโหมด AI และใช้กรองเหตุการณ์เมื่อใช้ Fixed Pool)</label>
                </div>
                <div class="sd-tags" id="sd-tag-picker">${renderTagPicker(cfg)}</div>
                <div class="sd-help">สามารถเลือกได้หลายแท็ก<br/><b>โหมด AI</b>: โมเดลจะพยายามสร้างเหตุการณ์ให้สอดคล้องกับแท็กที่เลือกไว้<br/><b>โหมด Fixed Pool</b>: หากเหตุการณ์ในรายการมีการระบุ #tag ไว้ (ดูด้านล่าง) ระบบจะสุ่มจากเหตุการณ์ที่ตรงแท็กก่อน หากไม่มีรายการที่ตรง จะสุ่มจากทั้งหมดแทน</div>

                <div class="sd-row" style="margin-top:10px;">
                    <label>Fixed Pool: พิมพ์เหตุการณ์บรรทัดละ 1 รายการ ในรูปแบบ: <code>หัวข้อสั้น :: รายละเอียดเต็ม :: #tag1,tag2</code></label>
                </div>
                <textarea class="sd-pool-textarea" id="sd-pool-text">${escapeHtml(renderPoolTextarea(cfg))}</textarea>
                <div class="sd-help">ส่วนก่อนเครื่องหมาย "::" แรก คือหัวข้อสั้น ๆ ที่ใช้สำหรับจดจำเพื่อไม่ให้เหตุการณ์ซ้ำ ส่วนถัดมาคือรายละเอียดฉบับเต็มที่จะส่งให้โมเดลเมื่อเหตุการณ์นี้ถูกเลือก<br/>สามารถใส่ <code>#tag1,tag2</code> ต่อท้ายบรรทัดได้ (ไม่บังคับ) เพื่อให้กรองตามแท็กธีมด้านบนได้<br/>สามารถใส่ <code>xN</code> ต่อท้ายบรรทัดได้ (ค่าเริ่มต้นคือ x1) เพื่อเพิ่มโอกาสถูกสุ่ม เช่น <code>x3</code> หมายถึงมีโอกาสถูกสุ่มมากกว่าปกติ 3 เท่า ยิ่งค่าสูง ยิ่งมีโอกาสออกบ่อยขึ้น ตัวอย่าง: <code>ปีศาจบุกหมู่บ้าน :: กลุ่มปีศาจโจมตีหมู่บ้านกลางดึก :: #Horror,Action :: x3</code></div>

                <div class="sd-row" style="margin-top:12px;">
                    <label>หรือเลือกยิงเหตุการณ์เอง (จากรายการที่บันทึกไว้แล้ว)</label>
                </div>
                <div class="sd-manual-pick-list" id="sd-manual-pick-list">${renderManualPickList(cfg)}</div>
                <div class="sd-help">เมื่อกดปุ่ม <b>ยิงอันนี้</b> เหตุการณ์นั้นจะเกิดขึ้นในข้อความถัดไปทันที โดยข้ามขั้นตอนการสุ่มไปโดยสิ้นเชิง การกดมีผลทันทีโดยไม่ต้องกดปุ่ม <b>บันทึก</b> เหมาะสำหรับกรณีที่ต้องการควบคุมทิศทางของเรื่องด้วยตนเอง รายการนี้แสดงเฉพาะเหตุการณ์ที่บันทึกไว้แล้วเท่านั้น หากเพิ่งแก้ไขข้อความด้านบน ให้กดปุ่ม <b>บันทึก</b> แล้วเปิดหน้าต่างนี้ใหม่เพื่อให้รายการอัปเดต</div>

                <div class="sd-row" style="margin-top:10px;">
                    <button type="button" class="menu_button" id="sd-blind-pick-btn">สุ่มจากกล่องลึกลับ (ไม่รู้ล่วงหน้า)</button>
                </div>
                <div class="sd-help">แตกต่างจากปุ่ม <b>ยิงอันนี้</b> ตรงที่ผู้ใช้จะไม่ทราบล่วงหน้าว่าได้เหตุการณ์ใด ระบบจะสุ่มจากพูลทันที (โดยใช้น้ำหนักและการกรองแท็กเช่นเดียวกับการสุ่มปกติ) แล้วเก็บผลไว้เป็นความลับก่อน จะทราบผลเมื่อเอฟเฟกต์ปรากฏขึ้นในข้อความถัดไป (หรือเมื่ออ่านข้อความ หากปิดเอฟเฟกต์ไว้)</div>
            </div>

            <div class="sd-subsection" style="margin-top:10px;">
                <h4>แผงพรีวิวคำสั่ง (โปร/ดีบัก)</h4>
                <div class="sd-row">
                    <label><input type="checkbox" id="sd-preview-enabled" ${cfg.promptPreviewEnabled ? "checked" : ""}/> เปิดแผงพรีวิว</label>
                </div>
                <div class="sd-help">สามารถดูตัวอย่างล่วงหน้าได้ว่าคำสั่งจริงที่จะส่งให้โมเดลมีลักษณะเป็นอย่างไร โดยใช้ค่าที่กำลังแก้ไขอยู่ในขณะนี้ (ยังไม่ต้องกดปุ่ม <b>บันทึก</b>) เป็นเพียงการแสดงตัวอย่างเท่านั้น ไม่มีผลกระทบต่อแชทจริงหรือประวัติเหตุการณ์แต่อย่างใด</div>

                <div class="sd-row sd-io-row ${cfg.promptPreviewEnabled ? "" : "sd-hidden"}" id="sd-preview-tools">
                    <button type="button" class="menu_button" id="sd-preview-event-btn">พรีวิวเหตุการณ์ปกติ</button>
                    <button type="button" class="menu_button" id="sd-preview-timeskip-btn">พรีวิว Time Skip</button>
                    <button type="button" class="menu_button" id="sd-preview-diary-btn">พรีวิว Diary</button>
                    <button type="button" class="menu_button" id="sd-preview-followup-btn" ${state.pendingFollowUp ? "" : "disabled"}>พรีวิวเหตุการณ์ต่อเนื่อง</button>
                </div>
                <textarea class="sd-pool-textarea ${cfg.promptPreviewEnabled ? "" : "sd-hidden"}" id="sd-preview-output" readonly placeholder="กดปุ่มด้านบนเพื่อดูตัวอย่างคำสั่ง..."></textarea>
                <div class="sd-help ${cfg.promptPreviewEnabled ? "" : "sd-hidden"}" id="sd-preview-meta">&nbsp;</div>
            </div>
                </div>
            </div>

            <div class="sd-accordion-item" data-tab-panel="diary">
                <button type="button" class="sd-accordion-header" aria-expanded="false">
                    <span class="sd-accordion-title">ไดอารี่</span>
                    ${state.diaryLog.some((e) => !e.read) ? `<span class="sd-accordion-badge" id="sd-diary-badge">${state.diaryLog.filter((e) => !e.read).length}</span>` : ""}
                    <span class="sd-accordion-caret">▾</span>
                </button>
                <div class="sd-accordion-body" data-acc-body="diary" hidden>
            <div class="sd-subsection">
                <h4>สมุดไดอารี่ของตัวละคร</h4>
                <div class="sd-row">
                    <label><input type="checkbox" id="sd-diary-enabled" ${cfg.diaryEnabled ? "checked" : ""}/> เปิดใช้สมุดไดอารี่</label>
                </div>
                <div class="sd-help">เมื่อถึงรอบที่กำหนด ตัวละครจะแต่งไดอารี่ขึ้นมาเอง เนื้อหา ป.ล. และอารมณ์ทั้งหมดเขียนโดยโมเดล ส่วนวันที่ สภาพอากาศ และเวลาที่เขียน ระบบจะสุ่มให้ในขั้นตอนสุดท้าย ไดอารี่จะมาพร้อมกับคำตอบปกติทันที โดยไม่ต้องสร้างข้อความเพิ่มแยกต่างหาก และสามารถเกิดร่วมกับเหตุการณ์ในข้อความเดียวกันได้</div>

                <div class="sd-row" style="margin-top:8px;">
                    <label><input type="checkbox" id="sd-diary-fixed-interval" ${cfg.diaryUseFixedInterval ? "checked" : ""}/> ปลดล็อกทุกๆ</label>
                    <input type="number" id="sd-diary-interval-n" value="${cfg.diaryFixedIntervalN}" min="1" max="999"/>
                    <span>ข้อความ</span>
                </div>
                <div class="sd-row">
                    <label><input type="checkbox" id="sd-diary-random" ${cfg.diaryUseRandom ? "checked" : ""}/> สุ่มปลดล็อกได้ด้วย (%)</label>
                    <input type="number" id="sd-diary-random-chance" value="${cfg.diaryRandomChance}" min="0" max="100"/>
                </div>
                <div class="sd-help">สามารถเปิดใช้งานพร้อมกันทั้งสองแบบได้ โดยจะปลดล็อกทันทีที่เงื่อนไขใดเงื่อนไขหนึ่งถึงก่อน นับจากข้อความของตัวละคร ไม่ใช่ข้อความของผู้ใช้ และสามารถเกิดร่วมกับเหตุการณ์หรือการข้ามเวลาในข้อความเดียวกันได้โดยไม่ขัดแย้งกัน</div>

                <div class="sd-row" style="margin-top:8px;">
                    <label><input type="checkbox" id="sd-diary-stickers-enabled" ${cfg.diaryStickersEnabled ? "checked" : ""}/> แปะสติ๊กเกอร์อารมณ์บนหน้าไดอารี่</label>
                </div>
                <div class="sd-help">จับคำในช่องอารมณ์ที่โมเดลเขียนมา แล้วเลือกสติ๊กเกอร์ที่ใกล้เคียงที่สุดแปะไว้มุมการ์ด ถ้าจับคำไม่ตรงกับสติ๊กเกอร์ใดเลย จะไม่แปะอะไรเพิ่ม</div>

                <div class="sd-row" style="margin-top:8px;">
                    <label><input type="checkbox" id="sd-diary-banner-enabled" ${cfg.diaryBannerEnabled ? "checked" : ""}/> เด้งแจ้งเตือนแบบป็อปอัพทับหน้าแชทตอนมีไดอารี่หน้าใหม่</label>
                </div>
                <div class="sd-help">การ์ดแจ้งเตือนจะเด้งขึ้นมุมหน้าจอตอนตัวละครเขียนไดอารี่เสร็จ กดที่การ์ดเพื่อเปิดสมุดไดอารี่ไปที่หน้านั้นได้ทันที หายไปเองหลังไม่กี่วินาทีถ้าไม่ได้กด ถ้าปิดไว้จะยังมีข้อความแจ้งเตือนเล็กๆ มุมจอตามปกติอยู่</div>

                <div class="sd-row" style="margin-top:8px;">
                    <button type="button" class="menu_button" id="sd-diary-force-btn" ${cfg.diaryEnabled ? "" : "disabled"}>เขียนไดอารี่ในข้อความถัดไปทันที</button>
                    <button type="button" class="menu_button" id="sd-diary-clear-btn">ล้างบันทึกไดอารี่ทั้งหมด</button>
                </div>
                <div class="sd-help">เมื่อกดปุ่ม <b>เขียนตอนนี้</b> ตัวละครจะเขียนไดอารี่ในคำตอบถัดไปทันที การกดมีผลทันทีโดยไม่ต้องกดปุ่ม <b>บันทึก</b></div>
            </div>

            <div class="sd-subsection" style="margin-top:10px;">
                <h4>กิมมิคในเนื้อหา</h4>
                <div class="sd-help">
                    เมื่อตัวละครเขียนไดอารี่ อาจมีลูกเล่นเหล่านี้ปรากฏอยู่ในเนื้อหา ไม่จำเป็นต้องตั้งค่าใด ๆ เพียงทราบไว้เพื่อความเข้าใจว่าสัญลักษณ์แต่ละแบบหมายถึงอะไรเมื่ออ่าน: <code>~~ข้อความ~~</code>: ขีดฆ่าสีจาง (ความคิดที่กลั้นไว้ไม่พูดออกมา), <code>==ข้อความ==</code>: ไฮไลต์สีเหลือง (ความจริงที่ยอมรับ), <code>__ข้อความ__</code>: ขีดเส้นใต้สีน้ำเงิน (สิ่งที่ตัดสินใจไว้อย่างแน่วแน่), <code>\`\`ข้อความ\`\`</code> (แบ็กทิกคู่): ขีดเส้นใต้จุดสีชมพู (คำที่พูดออกไปทั้งที่ใจไม่ตรงกัน)
                </div>
            </div>

            <div class="sd-subsection" style="margin-top:10px;">
                <h4>สมุดที่ปลดล็อกแล้ว</h4>
                <div class="sd-diary-reader" id="sd-diary-list">${renderDiaryList(state)}</div>
            </div>
                </div>
            </div>

            <div class="sd-accordion-item" data-tab-panel="stats">
                <button type="button" class="sd-accordion-header" aria-expanded="false">
                    <span class="sd-accordion-title">สถิติ/ประวัติ</span>
                    <span class="sd-accordion-caret">▾</span>
                </button>
                <div class="sd-accordion-body" data-acc-body="stats" hidden>
            <div class="sd-subsection">
                <h4>สถิติ</h4>
                ${renderStatsPanel(state)}
            </div>

            <div class="sd-subsection" style="margin-top:10px;">
                <h4>ให้คะแนนเหตุการณ์ล่าสุด</h4>
                ${renderLastFiredRatingBlock(state)}
            </div>

            <div class="sd-subsection" style="margin-top:10px;">
                <h4>ประวัติเหตุการณ์</h4>
                <div class="sd-row">
                    <label>จำนวนบทสรุปเหตุการณ์ล่าสุดที่จะจดจำ (เพื่อป้องกันการซ้ำ)</label>
                    <input type="number" id="sd-history-length" value="${cfg.historyLength}" min="1" max="30"/>
                </div>
                <div class="sd-help">ระบบจะจดจำเหตุการณ์ล่าสุดไว้ตามจำนวนนี้ แล้วแจ้งให้โมเดลหลีกเลี่ยงการสร้างเหตุการณ์ซ้ำกับที่จดจำไว้<br/>ยิ่งจดจำมาก ยิ่งป้องกันเหตุการณ์ซ้ำได้ดีขึ้น แต่จะใช้โทเค็นเพิ่มขึ้นเล็กน้อย</div>
                <div class="sd-history">ล่าสุด: ${state.recentEvents.join(", ") || "(ยังไม่มี)"}</div>

                <div class="sd-row" style="margin-top:10px; justify-content:space-between;">
                    <label>ประวัติทั้งหมด (${(state.eventLog || []).length} รายการ)</label>
                    <button type="button" class="menu_button" id="sd-clear-log-btn">ล้างประวัติทั้งหมด</button>
                </div>
                <div class="sd-help">รายการเหตุการณ์ทั้งหมดที่เคยเกิดขึ้นในแชทนี้ พร้อมเวลาและประเภท (Fixed Pool, AI สร้าง, หรือต่อเนื่อง) ใช้สำหรับดูย้อนหลังเท่านั้น ไม่ถูกส่งเข้าพรอมต์ (มีเพียงรายการ <b>ล่าสุด</b> ด้านบนเท่านั้นที่ใช้สำหรับป้องกันเหตุการณ์ซ้ำ)</div>
                <div class="sd-full-history" id="sd-full-history">${renderFullHistory(state)}</div>
            </div>
                </div>
            </div>
        </div>

        <div class="sd-credit">Story Director, สร้างโดย Purryverse</div>
    </div>`;
}
// NOTE ON READING FORM VALUES:
// We used to read every field out of the DOM in one pass *after* awaiting
// callGenericPopup(). That is unreliable: by the time the awaited promise
// resolves, SillyTavern's popup may already be tearing down its content, so
// document.getElementById() calls can return null and the whole read throws
// silently — nothing gets copied into the saved settings, so the next time
// the popup opens it looks like the save "didn't happen" even though the
// chat/character never changed. Instead we keep a draft object in memory and
// update it live via change/input listeners while the popup is still open
// and its DOM guaranteed to exist, then commit the draft only if the user
// actually clicked "บันทึก".
function makeDraft(cfg) {
    return {
        ...cfg,
        tags: [...cfg.tags],
        fixedPool: cfg.fixedPool.map((item) => ({ ...item })),
    };
}

function wireLiveCapture(draft) {
    const fieldHandler = (e) => {
        const t = e.target;
        if (!t || !t.id) return;
        switch (t.id) {
            case "sd-enabled": draft.enabled = t.checked; break;
            case "sd-presentation": draft.presentation = t.value; break;
            case "sd-tension-enabled": draft.tensionEnabled = t.checked; break;
            case "sd-tension-mode": draft.tensionGainMode = t.value; break;
            case "sd-tension-fixed": draft.tensionGainFixed = clampNum(t.value, 10, 1, 100); break;
            case "sd-tension-min": draft.tensionGainMin = clampNum(t.value, 5, 1, 100); break;
            case "sd-tension-max": draft.tensionGainMax = clampNum(t.value, 15, 1, 100); break;
            case "sd-tension-boost": draft.tensionBoostMax = clampNum(t.value, 40, 0, 100); break;
            case "sd-tension-cap": draft.tensionForceCap = clampNum(t.value, 100, 1, 100); break;
            case "sd-use-fixed-interval": draft.useFixedInterval = t.checked; break;
            case "sd-fixed-interval-n": draft.fixedIntervalN = clampNum(t.value, 10, 1, 200); break;
            case "sd-use-random": draft.useRandom = t.checked; break;
            case "sd-random-chance": draft.randomBaseChance = clampNum(t.value, 8, 0, 100); break;
            case "sd-event-intensity": draft.eventIntensity = t.value; break;
            case "sd-source-mode": draft.eventSourceMode = t.value; break;
            case "sd-pool-text": draft.fixedPool = parsePoolTextarea(t.value); break;
            case "sd-history-length": draft.historyLength = clampNum(t.value, 6, 1, 30); break;
            case "sd-followup-enabled": draft.followUpEnabled = t.checked; break;
            case "sd-followup-chance": draft.followUpChance = clampNum(t.value, 0, 0, 100); break;
            case "sd-followup-delay-min": draft.followUpDelayMin = clampNum(t.value, 1, 1, 50); break;
            case "sd-followup-delay-max": draft.followUpDelayMax = clampNum(t.value, 1, 1, 50); break;
            case "sd-followup-max-chain": draft.followUpMaxChain = clampNum(t.value, 0, 0, 10); break;
            case "sd-sound-enabled": draft.soundEnabled = t.checked; break;
            case "sd-sound-style": draft.soundStyle = t.value; break;
            case "sd-timeskip-enabled": {
                draft.timeSkipEnabled = t.checked;
                const forceBtn = document.getElementById("sd-timeskip-force-btn");
                if (forceBtn) forceBtn.disabled = !t.checked;
                break;
            }
            case "sd-timeskip-auto-chance": draft.timeSkipAutoChance = clampNum(t.value, 0, 0, 100); break;
            case "sd-timeskip-duration-mode": draft.timeSkipDurationMode = t.value; break;
            case "sd-timeskip-fixed-amount": draft.timeSkipFixedAmount = clampNum(t.value, 1, 1, 999); break;
            case "sd-timeskip-fixed-unit": draft.timeSkipFixedUnit = t.value; break;
            case "sd-timeskip-random-min": draft.timeSkipRandomMin = clampNum(t.value, 1, 1, 999); break;
            case "sd-timeskip-random-max": draft.timeSkipRandomMax = clampNum(t.value, 1, 1, 999); break;
            case "sd-timeskip-random-unit": draft.timeSkipRandomUnit = t.value; break;
            case "sd-timeskip-reset": draft.timeSkipResetCounters = t.checked; break;
            case "sd-preview-enabled": {
                draft.promptPreviewEnabled = t.checked;
                document.getElementById("sd-preview-tools")?.classList.toggle("sd-hidden", !t.checked);
                document.getElementById("sd-preview-output")?.classList.toggle("sd-hidden", !t.checked);
                document.getElementById("sd-preview-meta")?.classList.toggle("sd-hidden", !t.checked);
                break;
            }
            case "sd-diary-enabled": {
                draft.diaryEnabled = t.checked;
                const diaryForceBtn = document.getElementById("sd-diary-force-btn");
                if (diaryForceBtn) diaryForceBtn.disabled = !t.checked;
                break;
            }
            case "sd-diary-fixed-interval": draft.diaryUseFixedInterval = t.checked; break;
            case "sd-diary-interval-n": draft.diaryFixedIntervalN = clampNum(t.value, 1, 1, 999); break;
            case "sd-diary-random": draft.diaryUseRandom = t.checked; break;
            case "sd-diary-random-chance": draft.diaryRandomChance = clampNum(t.value, 0, 0, 100); break;
            case "sd-diary-stickers-enabled": draft.diaryStickersEnabled = t.checked; break;
            case "sd-diary-banner-enabled": draft.diaryBannerEnabled = t.checked; break;
        }
    };

    const tagClickHandler = (e) => {
        if (e.target.classList.contains("sd-tag")) {
            e.target.classList.toggle("active");
            draft.tags = Array.from(document.querySelectorAll(".sd-tag.active")).map(
                (el) => el.dataset.tag
            );
        }
    };

    // Capture phase so we record the value even if something else on the
    // page stops propagation before it reaches a bubble-phase listener.
    document.addEventListener("input", fieldHandler, true);
    document.addEventListener("change", fieldHandler, true);
    document.addEventListener("click", tagClickHandler, true);

    return () => {
        document.removeEventListener("input", fieldHandler, true);
        document.removeEventListener("change", fieldHandler, true);
        document.removeEventListener("click", tagClickHandler, true);
    };
}

// ----------------------------------------------------------------------------
// Export / Import — exports the *config* portion of the current chat's
// settings (not the ephemeral tension/history state) as a downloadable JSON
// file, and imports one back into the in-memory draft so it takes effect
// once the user clicks "บันทึก". Import is whitelist-based: only known
// fields are copied over, each validated/coerced, and anything missing or
// malformed falls back to the draft's current value rather than clobbering
// it with garbage.
// ----------------------------------------------------------------------------

const EXPORT_VERSION = 3;

function exportConfigToFile(cfg) {
    const envelope = {
        __storyDirectorExport: true,
        version: EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        config: {
            enabled: cfg.enabled,
            presentation: cfg.presentation,
            soundEnabled: cfg.soundEnabled,
            soundStyle: cfg.soundStyle,
            tags: cfg.tags,
            fixedPool: cfg.fixedPool,
            eventSourceMode: cfg.eventSourceMode,
            useFixedInterval: cfg.useFixedInterval,
            fixedIntervalN: cfg.fixedIntervalN,
            useRandom: cfg.useRandom,
            randomBaseChance: cfg.randomBaseChance,
            tensionEnabled: cfg.tensionEnabled,
            tensionGainMode: cfg.tensionGainMode,
            tensionGainFixed: cfg.tensionGainFixed,
            tensionGainMin: cfg.tensionGainMin,
            tensionGainMax: cfg.tensionGainMax,
            tensionBoostMax: cfg.tensionBoostMax,
            tensionForceCap: cfg.tensionForceCap,
            eventIntensity: cfg.eventIntensity,
            historyLength: cfg.historyLength,
            followUpEnabled: cfg.followUpEnabled,
            followUpChance: cfg.followUpChance,
            followUpDelayMin: cfg.followUpDelayMin,
            followUpDelayMax: cfg.followUpDelayMax,
            followUpMaxChain: cfg.followUpMaxChain,
            timeSkipEnabled: cfg.timeSkipEnabled,
            timeSkipAutoChance: cfg.timeSkipAutoChance,
            timeSkipDurationMode: cfg.timeSkipDurationMode,
            timeSkipFixedAmount: cfg.timeSkipFixedAmount,
            timeSkipFixedUnit: cfg.timeSkipFixedUnit,
            timeSkipRandomMin: cfg.timeSkipRandomMin,
            timeSkipRandomMax: cfg.timeSkipRandomMax,
            timeSkipRandomUnit: cfg.timeSkipRandomUnit,
            timeSkipResetCounters: cfg.timeSkipResetCounters,
            promptPreviewEnabled: cfg.promptPreviewEnabled,
            diaryEnabled: cfg.diaryEnabled,
            diaryUseFixedInterval: cfg.diaryUseFixedInterval,
            diaryFixedIntervalN: cfg.diaryFixedIntervalN,
            diaryUseRandom: cfg.diaryUseRandom,
            diaryRandomChance: cfg.diaryRandomChance,
            diaryStickersEnabled: cfg.diaryStickersEnabled,
            diaryBannerEnabled: cfg.diaryBannerEnabled,
        },
    };

    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `story-director-settings-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function sanitizeImportedConfig(base, raw) {
    const out = { ...base };
    if (!raw || typeof raw !== "object") return out;

    // Accept either the enveloped export format ({ config: {...} }) or a
    // bare config object, so hand-edited/older files still import fine.
    const src = raw.config && typeof raw.config === "object" ? raw.config : raw;

    const num = (v, fallback) => (typeof v === "number" && isFinite(v) ? v : fallback);
    const bool = (v, fallback) => (typeof v === "boolean" ? v : fallback);
    const str = (v, fallback, allowed) => (typeof v === "string" && (!allowed || allowed.includes(v)) ? v : fallback);

    out.enabled = bool(src.enabled, out.enabled);
    out.presentation = str(src.presentation, out.presentation, ["subtle", "narrator", "both"]);
    out.eventSourceMode = str(src.eventSourceMode, out.eventSourceMode, ["fixed", "ai"]);
    out.soundEnabled = bool(src.soundEnabled, out.soundEnabled);
    out.soundStyle = str(src.soundStyle, out.soundStyle, Object.keys(SOUND_STYLES));
    out.tags = Array.isArray(src.tags) ? src.tags.filter((t) => THEME_TAGS.includes(t)) : out.tags;
    out.fixedPool = Array.isArray(src.fixedPool)
        ? src.fixedPool
              .filter((e) => e && typeof e.summary === "string")
              .map((e) => ({
                  summary: e.summary,
                  detail: typeof e.detail === "string" ? e.detail : "",
                  tags: Array.isArray(e.tags) ? e.tags.filter((t) => typeof t === "string") : [],
                  weight: typeof e.weight === "number" && e.weight > 0 ? e.weight : 1,
              }))
        : out.fixedPool;

    out.useFixedInterval = bool(src.useFixedInterval, out.useFixedInterval);
    out.fixedIntervalN = num(src.fixedIntervalN, out.fixedIntervalN);
    out.useRandom = bool(src.useRandom, out.useRandom);
    out.randomBaseChance = num(src.randomBaseChance, out.randomBaseChance);

    out.tensionEnabled = bool(src.tensionEnabled, out.tensionEnabled);
    out.tensionGainMode = str(src.tensionGainMode, out.tensionGainMode, ["fixed", "random"]);
    out.tensionGainFixed = num(src.tensionGainFixed, out.tensionGainFixed);
    out.tensionGainMin = num(src.tensionGainMin, out.tensionGainMin);
    out.tensionGainMax = num(src.tensionGainMax, out.tensionGainMax);
    out.tensionBoostMax = num(src.tensionBoostMax, out.tensionBoostMax);
    out.tensionForceCap = num(src.tensionForceCap, out.tensionForceCap);

    out.eventIntensity = str(src.eventIntensity, out.eventIntensity, ["mild", "medium", "disruptive"]);
    out.historyLength = num(src.historyLength, out.historyLength);

    out.followUpEnabled = bool(src.followUpEnabled, out.followUpEnabled);
    out.followUpChance = num(src.followUpChance, out.followUpChance);
    out.followUpDelayMin = num(src.followUpDelayMin, out.followUpDelayMin);
    out.followUpDelayMax = num(src.followUpDelayMax, out.followUpDelayMax);
    out.followUpMaxChain = num(src.followUpMaxChain, out.followUpMaxChain);

    out.timeSkipEnabled = bool(src.timeSkipEnabled, out.timeSkipEnabled);
    out.timeSkipAutoChance = num(src.timeSkipAutoChance, out.timeSkipAutoChance);
    out.timeSkipDurationMode = str(src.timeSkipDurationMode, out.timeSkipDurationMode, ["fixed", "random", "ai"]);
    out.timeSkipFixedAmount = num(src.timeSkipFixedAmount, out.timeSkipFixedAmount);
    out.timeSkipFixedUnit = str(src.timeSkipFixedUnit, out.timeSkipFixedUnit, ["hour", "day", "week"]);
    out.timeSkipRandomMin = num(src.timeSkipRandomMin, out.timeSkipRandomMin);
    out.timeSkipRandomMax = num(src.timeSkipRandomMax, out.timeSkipRandomMax);
    out.timeSkipRandomUnit = str(src.timeSkipRandomUnit, out.timeSkipRandomUnit, ["hour", "day", "week"]);
    out.timeSkipResetCounters = bool(src.timeSkipResetCounters, out.timeSkipResetCounters);
    out.promptPreviewEnabled = bool(src.promptPreviewEnabled, out.promptPreviewEnabled);

    out.diaryEnabled = bool(src.diaryEnabled, out.diaryEnabled);
    out.diaryUseFixedInterval = bool(src.diaryUseFixedInterval, out.diaryUseFixedInterval);
    out.diaryFixedIntervalN = num(src.diaryFixedIntervalN, out.diaryFixedIntervalN);
    out.diaryUseRandom = bool(src.diaryUseRandom, out.diaryUseRandom);
    out.diaryRandomChance = num(src.diaryRandomChance, out.diaryRandomChance);
    out.diaryStickersEnabled = bool(src.diaryStickersEnabled, out.diaryStickersEnabled);
    out.diaryBannerEnabled = bool(src.diaryBannerEnabled, out.diaryBannerEnabled);

    return out;
}

// Reflects a config object back onto the popup's DOM fields. Used after an
// import so what's on screen matches the (already-updated) draft, without
// needing a full popup re-render.
function applyConfigToDom(cfg) {
    const setChecked = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    const setValue = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };

    setChecked("sd-enabled", cfg.enabled);
    setValue("sd-presentation", cfg.presentation);
    setChecked("sd-sound-enabled", cfg.soundEnabled);
    setValue("sd-sound-style", cfg.soundStyle);

    setChecked("sd-tension-enabled", cfg.tensionEnabled);
    setValue("sd-tension-mode", cfg.tensionGainMode);
    setValue("sd-tension-fixed", cfg.tensionGainFixed);
    setValue("sd-tension-min", cfg.tensionGainMin);
    setValue("sd-tension-max", cfg.tensionGainMax);
    setValue("sd-tension-boost", cfg.tensionBoostMax);
    setValue("sd-tension-cap", cfg.tensionForceCap);

    setChecked("sd-use-fixed-interval", cfg.useFixedInterval);
    setValue("sd-fixed-interval-n", cfg.fixedIntervalN);
    setChecked("sd-use-random", cfg.useRandom);
    setValue("sd-random-chance", cfg.randomBaseChance);
    setValue("sd-event-intensity", cfg.eventIntensity);

    setChecked("sd-followup-enabled", cfg.followUpEnabled);
    setValue("sd-followup-chance", cfg.followUpChance);
    setValue("sd-followup-delay-min", cfg.followUpDelayMin);
    setValue("sd-followup-delay-max", cfg.followUpDelayMax);
    setValue("sd-followup-max-chain", cfg.followUpMaxChain);

    setChecked("sd-timeskip-enabled", cfg.timeSkipEnabled);
    setValue("sd-timeskip-auto-chance", cfg.timeSkipAutoChance);
    setValue("sd-timeskip-duration-mode", cfg.timeSkipDurationMode);
    setValue("sd-timeskip-fixed-amount", cfg.timeSkipFixedAmount);
    setValue("sd-timeskip-fixed-unit", cfg.timeSkipFixedUnit);
    setValue("sd-timeskip-random-min", cfg.timeSkipRandomMin);
    setValue("sd-timeskip-random-max", cfg.timeSkipRandomMax);
    setValue("sd-timeskip-random-unit", cfg.timeSkipRandomUnit);
    setChecked("sd-timeskip-reset", cfg.timeSkipResetCounters);
    const timeSkipForceBtn = document.getElementById("sd-timeskip-force-btn");
    if (timeSkipForceBtn) timeSkipForceBtn.disabled = !cfg.timeSkipEnabled;

    setChecked("sd-preview-enabled", cfg.promptPreviewEnabled);
    document.getElementById("sd-preview-tools")?.classList.toggle("sd-hidden", !cfg.promptPreviewEnabled);
    document.getElementById("sd-preview-output")?.classList.toggle("sd-hidden", !cfg.promptPreviewEnabled);
    document.getElementById("sd-preview-meta")?.classList.toggle("sd-hidden", !cfg.promptPreviewEnabled);

    setChecked("sd-diary-enabled", cfg.diaryEnabled);
    setChecked("sd-diary-fixed-interval", cfg.diaryUseFixedInterval);
    setValue("sd-diary-interval-n", cfg.diaryFixedIntervalN);
    setChecked("sd-diary-random", cfg.diaryUseRandom);
    setValue("sd-diary-random-chance", cfg.diaryRandomChance);
    setChecked("sd-diary-stickers-enabled", cfg.diaryStickersEnabled);
    setChecked("sd-diary-banner-enabled", cfg.diaryBannerEnabled);
    const diaryForceBtn = document.getElementById("sd-diary-force-btn");
    if (diaryForceBtn) diaryForceBtn.disabled = !cfg.diaryEnabled;

    setValue("sd-source-mode", cfg.eventSourceMode);
    setValue("sd-pool-text", renderPoolTextarea(cfg));
    setValue("sd-history-length", cfg.historyLength);

    const pickListEl = document.getElementById("sd-manual-pick-list");
    if (pickListEl) pickListEl.innerHTML = renderManualPickList(cfg);

    document.querySelectorAll(".sd-tag").forEach((el) => {
        el.classList.toggle("active", cfg.tags.includes(el.dataset.tag));
    });
}

function notify(message, isError) {
    try {
        if (typeof toastr !== "undefined") {
            isError ? toastr.error(message) : toastr.success(message);
            return;
        }
    } catch (e) {
        // fall through to console-only below
    }
    console.log(`[Story Director] ${message}`);
    const status = document.getElementById("sd-io-status");
    if (status) status.textContent = message;
}

// A bigger, app-notification-style banner (distinct from the small toastr
// corner toast above) that floats over the chat itself when a new diary
// page lands. Stacks if more than one fires close together, auto-dismisses,
// and clicking it jumps straight into the diary tab of the settings popup.
const DIARY_BANNER_LIFESPAN_MS = 8000;

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

function showDiaryNotificationBanner(entry) {
    try {
        const container = ensureDiaryBannerContainer();
        const cfg = getChatSettings();
        const stickerFile = cfg.diaryStickersEnabled ? pickMoodStickerFile(entry.mood) : null;
        const iconHtml = stickerFile
            ? `<img class="sd-diary-banner-icon" src="${resolveStickerUrl(stickerFile)}" alt="">`
            : `<div class="sd-diary-banner-icon sd-diary-banner-icon-fallback">📔</div>`;
        const snippet = truncateText((entry.body || "").replace(/\s+/g, " ").trim(), 70);

        const banner = document.createElement("div");
        banner.className = "sd-diary-banner";
        banner.innerHTML = `
            ${iconHtml}
            <div class="sd-diary-banner-text">
                <div class="sd-diary-banner-title">${escapeHtml(getCharacterName())} เขียนไดอารี่หน้าใหม่</div>
                <div class="sd-diary-banner-snippet">${escapeHtml(snippet)}</div>
            </div>
            <button type="button" class="sd-diary-banner-close" title="ปิด" aria-label="ปิด">×</button>`;

        banner.addEventListener("click", (e) => {
            if (e.target.closest(".sd-diary-banner-close")) {
                dismissDiaryBanner(banner);
                return;
            }
            dismissDiaryBanner(banner);
            openSettingsPopup("diary");
        });

        container.appendChild(banner);
        setTimeout(() => dismissDiaryBanner(banner), DIARY_BANNER_LIFESPAN_MS);
    } catch (e) {
        console.warn("[Story Director] Diary banner failed:", e);
    }
}

function wireImportExport(draft) {
    const handler = (e) => {
        const target = e.target.closest ? e.target.closest("#sd-export-btn, #sd-import-btn") : null;
        if (!target) return;

        if (target.id === "sd-export-btn") {
            exportConfigToFile(draft);
            notify("ส่งออกการตั้งค่าเป็นไฟล์แล้ว");
        } else if (target.id === "sd-import-btn") {
            const fileInput = document.getElementById("sd-import-file");
            if (fileInput) fileInput.click();
        }
    };

    const fileHandler = async (e) => {
        if (e.target.id !== "sd-import-file") return;
        const file = e.target.files && e.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            const sanitized = sanitizeImportedConfig(draft, parsed);
            Object.assign(draft, sanitized);
            applyConfigToDom(draft);
            notify('นำเข้าการตั้งค่าแล้ว กด "บันทึก" เพื่อยืนยันการเปลี่ยนแปลง');
        } catch (err) {
            console.warn("[Story Director] Import failed:", err);
            notify("นำเข้าไฟล์ไม่สำเร็จ กรุณาตรวจสอบว่าเป็นไฟล์ .json ที่ส่งออกจาก Story Director", true);
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

// Quick actions — unlike settings fields, these act on the live per-chat
// state right away (not the draft), since they're runtime commands ("fire
// an event now", "cancel what's scheduled") rather than saved preferences.
// They don't require clicking "บันทึก".
function wireQuickActions(cfg, draft, state) {
    const handler = (e) => {
        const pickBtn = e.target.closest ? e.target.closest(".sd-pick-btn") : null;
        if (pickBtn) {
            const idx = Number(pickBtn.dataset.pickIndex);
            const ev = cfg.fixedPool[idx];
            if (!ev) return;
            state.manualPick = { summary: ev.summary, detail: ev.detail, tags: ev.tags };
            state.forceNextEvent = true;
            saveChatState();
            notify(`เลือกแล้ว: "${truncateText(ev.summary, 30)}" จะถูกยิงในข้อความถัดไป`);
            return;
        }

        const target = e.target.closest
            ? e.target.closest("#sd-force-btn, #sd-cancel-followup-btn, #sd-clear-log-btn, #sd-rate-up-btn, #sd-rate-down-btn, #sd-blind-pick-btn, #sd-timeskip-force-btn, #sd-preview-event-btn, #sd-preview-timeskip-btn, #sd-preview-diary-btn, #sd-preview-followup-btn, #sd-diary-force-btn, #sd-diary-clear-btn, #sd-sound-test-btn, #sd-reset-defaults-btn")
            : null;
        if (!target) return;

        if (target.id === "sd-sound-test-btn") {
            playEventSound(draft.soundStyle);
        } else if (target.id === "sd-reset-defaults-btn") {
            const fresh = DEFAULT_CHAT_SETTINGS();
            fresh.fixedPool = draft.fixedPool; // never silently discard hand-written events
            fresh.tags = [...draft.tags];
            Object.assign(draft, fresh);
            applyConfigToDom(draft);
            notify('รีเซ็ตค่าในหน้าต่างนี้แล้ว กด "บันทึก" เพื่อให้มีผลถาวร (Fixed Pool และแท็กที่เลือกไว้ไม่ถูกแตะต้อง)');
        } else if (target.id === "sd-force-btn") {
            state.forceNextEvent = true;
            saveChatState();
            notify("ตั้งค่าแล้ว: เหตุการณ์จะเกิดขึ้นในการตอบครั้งถัดไป");
        } else if (target.id === "sd-diary-force-btn") {
            if (!draft.diaryEnabled) {
                notify("ต้องเปิด \"เปิดใช้สมุดไดอารี่\" ก่อน (แล้วกดบันทึก ถ้าเพิ่งเปิด)", true);
                return;
            }
            // draft.diaryEnabled only lives in the open popup's in-memory
            // copy until "บันทึก" is clicked — but onBeforeGenerate() reads
            // the real persisted cfg via getChatSettings(). If the user just
            // ticked the checkbox and hit this button without saving first,
            // the flag below would get queued but cfg.diaryEnabled would
            // still read false next message, so nothing would ever fire.
            // Persist diaryEnabled right here so the force-fire is guaranteed
            // to actually take effect, regardless of whether Save was clicked.
            if (cfg.diaryEnabled !== draft.diaryEnabled) {
                cfg.diaryEnabled = draft.diaryEnabled;
                saveSettingsDebounced();
            }
            state.forceNextDiary = true;
            saveChatState();
            notify("ตั้งค่าแล้ว: จะเขียนไดอารี่หลังข้อความถัดไปของตัวละคร");
        } else if (target.id === "sd-diary-clear-btn") {
            state.diaryLog = [];
            state.diaryRecentSummaries = [];
            saveChatState();
            const listEl = document.getElementById("sd-diary-list");
            if (listEl) listEl.innerHTML = renderDiaryList(state);
            notify("ล้างบันทึกไดอารี่ทั้งหมดแล้ว");
        } else if (target.id === "sd-timeskip-force-btn") {
            if (!draft.timeSkipEnabled) {
                notify("ต้องเปิด \"เปิดใช้ฟีเจอร์ข้ามเวลา\" ก่อน (แล้วกดบันทึก ถ้าเพิ่งเปิด)", true);
                return;
            }
            // Same trap as the diary force button above: draft.timeSkipEnabled
            // is only the in-memory popup value until "บันทึก" is clicked,
            // while onBeforeGenerate() reads the persisted cfg. Commit it here
            // so the force-fire is guaranteed to actually take effect.
            if (cfg.timeSkipEnabled !== draft.timeSkipEnabled) {
                cfg.timeSkipEnabled = draft.timeSkipEnabled;
                saveSettingsDebounced();
            }
            state.forceNextTimeSkip = true;
            saveChatState();
            notify("ตั้งค่าแล้ว: จะข้ามเวลาในการตอบครั้งถัดไป");
        } else if (target.id === "sd-preview-event-btn" || target.id === "sd-preview-timeskip-btn" || target.id === "sd-preview-diary-btn" || target.id === "sd-preview-followup-btn") {
            const kind = target.id === "sd-preview-timeskip-btn" ? "timeskip" : target.id === "sd-preview-diary-btn" ? "diary" : target.id === "sd-preview-followup-btn" ? "followup" : "event";
            const text = previewInjectionText(draft, state, kind);
            const outEl = document.getElementById("sd-preview-output");
            const metaEl = document.getElementById("sd-preview-meta");
            if (text) {
                if (outEl) outEl.value = text;
                if (metaEl) metaEl.textContent = `${text.length} ตัวอักษร (~${Math.ceil(text.length / 4)} token โดยประมาณ) คำนวณจากค่าที่กำลังแก้อยู่ในหน้าต่างนี้ ยังไม่บันทึกก็พรีวิวได้`;
            } else {
                if (outEl) outEl.value = "";
                if (metaEl) metaEl.textContent = "พรีวิวไม่ได้ตอนนี้ (เช่น ยังไม่มีเหตุการณ์ต่อเนื่องที่นัดไว้ หรือ Fixed Pool ว่างอยู่)";
            }
        } else if (target.id === "sd-cancel-followup-btn") {
            if (!state.pendingFollowUp) return;
            state.pendingFollowUp = null;
            saveChatState();
            const statusEl = document.getElementById("sd-followup-status");
            if (statusEl) statusEl.textContent = "สถานะปัจจุบัน: (ยังไม่มีเหตุการณ์ต่อเนื่องที่นัดไว้)";
            target.disabled = true;
            notify("ยกเลิกเหตุการณ์ต่อเนื่องที่นัดไว้แล้ว");
        } else if (target.id === "sd-clear-log-btn") {
            state.eventLog = [];
            saveChatState();
            const panel = document.getElementById("sd-full-history");
            if (panel) panel.innerHTML = renderFullHistory(state);
            notify("ล้างประวัติทั้งหมดแล้ว");
        } else if (target.id === "sd-rate-up-btn" || target.id === "sd-rate-down-btn") {
            const delta = target.id === "sd-rate-up-btn" ? WEIGHT_STEP : -WEIGHT_STEP;
            const next = adjustLastFiredWeight(cfg, draft, state, delta);
            const statusEl = document.getElementById("sd-rate-status");
            if (next != null) {
                if (statusEl) statusEl.textContent = `ปรับน้ำหนักเป็น x${next} แล้ว (มีผลทันที)`;
                notify("ปรับน้ำหนักเหตุการณ์นี้แล้ว");
            } else if (statusEl) {
                statusEl.textContent = "ไม่พบเหตุการณ์นี้ใน Fixed Pool ปัจจุบัน (อาจถูกแก้ไข/ลบไปแล้ว)";
            }
        } else if (target.id === "sd-blind-pick-btn") {
            if (!cfg.fixedPool.length) {
                notify("Fixed Pool ยังว่างอยู่ ไม่มีอะไรให้สุ่ม", true);
                return;
            }
            const ev = pickFixedPoolEvent(cfg, state);
            if (!ev) {
                notify("สุ่มไม่ได้ตอนนี้ (อาจติดตัวกรองแท็ก)", true);
                return;
            }
            state.manualPick = { summary: ev.summary, detail: ev.detail, tags: ev.tags };
            state.forceNextEvent = true;
            saveChatState();
            notify("หยิบเหตุการณ์ลึกลับจากกล่องแล้ว: จะเผยในข้อความถัดไป");
        }
    };

    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
}

// Pure UI state — an Accordion where every settings section sits stacked
// vertically and expands/collapses in place (no page-switching at all).
// Doesn't touch cfg, draft, or any saved data at all, aside from marking
// diary entries read the moment that section is opened.
function wireNav() {
    const markDiaryRead = () => {
        const state = getChatState();
        const hadUnread = state.diaryLog.some((entry) => !entry.read);
        if (!hadUnread) return;
        state.diaryLog.forEach((entry) => { entry.read = true; });
        saveChatState();
        const badge = document.getElementById("sd-diary-badge");
        if (badge) badge.remove();
        const listEl = document.getElementById("sd-diary-list");
        if (listEl) listEl.innerHTML = renderDiaryList(state);
    };

    const handleClick = (e) => {
        const header = e.target.closest ? e.target.closest(".sd-accordion-header") : null;
        if (!header) return;
        const item = header.closest(".sd-accordion-item");
        const body = item ? item.querySelector(".sd-accordion-body") : null;
        const opening = header.getAttribute("aria-expanded") !== "true";
        header.setAttribute("aria-expanded", opening ? "true" : "false");
        if (body) body.hidden = !opening;
        if (opening && item && item.dataset.tabPanel === "diary") markDiaryRead();
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
    const unwireTabs = wireNav();

    if (tabToOpen) {
        const header = document.querySelector(`.sd-accordion-item[data-tab-panel="${tabToOpen}"] .sd-accordion-header`);
        if (header && header.getAttribute("aria-expanded") !== "true") header.click();
    }

    try {
        const result = await callGenericPopup(html, POPUP_TYPE.CONFIRM, "", {
            wide: true,
            okButton: "บันทึก",
            cancelButton: "ปิด",
        });

        if (result) {
            Object.assign(cfg, draft);
            saveSettingsDebounced();
        }
    } finally {
        unwireFields();
        unwireIo();
        unwireActions();
        unwireTabs();
    }
}

let addWandMenuButtonAttempts = 0;

function addWandMenuButton() {
    const menu = document.getElementById("extensionsMenu");
    if (!menu) {
        // The wand menu may not be in the DOM yet on first load; retry
        // shortly instead of giving up silently. Cap retries so a genuinely
        // missing menu (wrong SillyTavern page/version) logs a clear error
        // instead of retrying forever in the background.
        addWandMenuButtonAttempts += 1;
        if (addWandMenuButtonAttempts > 40) { // ~20 seconds at 500ms
            console.error("[Story Director] #extensionsMenu never appeared after 20s — giving up. This usually means the page hasn't finished loading, or this isn't a standard SillyTavern chat page.");
            return;
        }
        setTimeout(addWandMenuButton, 500);
        return;
    }
    if (document.getElementById("sd-wand-button")) return; // already added

    const item = document.createElement("div");
    item.id = "sd-wand-button";
    item.classList.add("list-group-item", "flex-container", "flexGap5", "interactable");
    item.tabIndex = 0;
    item.innerHTML = `
        <i class="fa-fw fa-solid fa-clapperboard"></i>
        <span>Story Director</span>`;
    item.addEventListener("click", openSettingsPopup);
    // Insert at the top of the menu instead of appending to the bottom.
    // With many extensions installed, an appended item can end up scrolled
    // out of view at the bottom of the wand-menu popup; putting it first
    // guarantees it's visible as soon as the menu opens.
    menu.insertBefore(item, menu.firstChild);
}

// Shown instead of the real button when loadCoreModules() couldn't resolve
// SillyTavern's internal modules. Clicking it explains what to check, so
// the failure is visible in the UI instead of only in devtools console.
function addWandMenuErrorButton(missing) {
    const menu = document.getElementById("extensionsMenu");
    if (!menu) {
        setTimeout(() => addWandMenuErrorButton(missing), 500);
        return;
    }
    if (document.getElementById("sd-wand-button")) return;

    const item = document.createElement("div");
    item.id = "sd-wand-button";
    item.classList.add("list-group-item", "flex-container", "flexGap5", "interactable");
    item.tabIndex = 0;
    item.innerHTML = `
        <i class="fa-fw fa-solid fa-triangle-exclamation" style="color:#e06666;"></i>
        <span>Story Director (โหลดไม่สำเร็จ)</span>`;
    item.addEventListener("click", () => {
        alert(
            "Story Director โหลดไม่สำเร็จ เพราะไฟล์นี้ไม่พบ: " + missing.join(", ") + "\n\n" +
            "สาเหตุที่พบบ่อยที่สุด: โฟลเดอร์ extension ถูกวางลึกเกินไปหรือตื้นเกินไป\n" +
            "ตำแหน่งที่ถูกต้องคือ:\n" +
            ".../SillyTavern/public/scripts/extensions/third-party/story-director/index.js\n" +
            "(manifest.json ต้องอยู่โฟลเดอร์เดียวกันกับ index.js พอดี ไม่มีโฟลเดอร์ story-director ซ้อนกันสองชั้น)\n\n" +
            "แก้แล้วให้รีสตาร์ต SillyTavern เซิร์ฟเวอร์ แล้ว hard refresh หน้าเว็บอีกครั้ง"
        );
    });
    menu.insertBefore(item, menu.firstChild);
}

// ----------------------------------------------------------------------------
// Init
// ----------------------------------------------------------------------------

jQuery(async () => {
    const missing = await loadCoreModules();
    if (missing.length > 0) {
        console.error("[Story Director] Could not initialize — missing core modules: " + missing.join(", "));
        addWandMenuErrorButton(missing);
        return;
    }

    ensureSettings();
    addWandMenuButton();
    await loadOptionalModules();
    refreshWorldInfoCache(); // fire and forget; onBeforeGenerate reads the cache synchronously

    // Keep the grounding cache reasonably fresh as the conversation moves,
    // without ever blocking generation on it.
    // Only refresh on MESSAGE_SENT and CHAT_CHANGED, not MESSAGE_RECEIVED —
    // the cache only needs to be warm by the time the NEXT onBeforeGenerate
    // runs, and that next call is always triggered by the user's next
    // MESSAGE_SENT (swipe/regenerate no longer re-scan at all — see
    // onBeforeGenerate's early return for those types). Scanning again
    // right after the char's reply lands was redundant work for a value
    // nothing would read before the next MESSAGE_SENT overwrote it anyway.
    const refreshEvents = ["MESSAGE_SENT", "CHAT_CHANGED"];
    for (const name of refreshEvents) {
        if (event_types[name]) {
            eventSource.on(event_types[name], () => refreshWorldInfoCache());
        }
    }

    // Captures the hidden event-summary / diary markers riding along in each
    // new {{char}} message (see onCharacterMessageReceived above).
    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onCharacterMessageReceived);
    }

    // NOTE: We deliberately use GENERATION_STARTED here instead of
    // GENERATE_BEFORE_COMBINE_PROMPTS. The latter is skipped by SillyTavern
    // core whenever a Chat Completion API is the main API (OpenAI, Claude,
    // Gemini, OpenRouter, Mistral, etc. — see SillyTavern GitHub issue
    // #3438), so it silently never fires for most modern setups even though
    // the event name always exists. GENERATION_STARTED fires at the start of
    // every Generate() call for every API type, before the prompt is
    // assembled, which is early enough for setExtensionPrompt() to take effect.
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, onBeforeGenerate);
    } else {
        console.warn("[Story Director] No suitable pre-generation event found; injection will not fire.");
    }

    console.log("[Story Director] Extension loaded.");
});
