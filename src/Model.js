// Pure helpers for Kanibar: WaniKani API response parsing and validation.
// No QML or Quickshell dependencies, so `node --test test/` can load this
// file directly. Nothing here produces user-facing prose: functions return
// numbers or translation keys, and the QML looks the words up in i18n/.

var PLUGIN_ID = "io.github.erfoip.kanibar"
var APP_NAME = "Kanibar"
var ICON_GLYPH = "鰐"   // "wani", crocodile

var API_BASE = "https://api.wanikani.com/v2"
var API_REVISION = "20170710"

var REVIEW_URL = "https://www.wanikani.com/subjects/review"
var LESSON_URL = "https://www.wanikani.com/subject-lessons/start"
var DASHBOARD_URL = "https://www.wanikani.com/dashboard"
var TOKEN_URL = "https://www.wanikani.com/settings/personal_access_tokens"

// ---------- Time units ----------
var SECOND_MS = 1000
var MINUTE_MS = 60 * SECOND_MS
var HOUR_MS = 60 * MINUTE_MS

// ---------- Schedule ----------
var DETAILS_MAX_AGE_MS = 2 * MINUTE_MS      // popup details refetch at most this often
var REMINDER_CHECK_MS = MINUTE_MS
var CLOCK_TICK_MS = 30 * SECOND_MS          // relative times in the open popup
var HOUR_REFRESH_SLACK_MS = 30 * SECOND_MS  // after the hour, when reviews unlock
var FORECAST_HOURS = 24
var FORECAST_TICK_EVERY = 6                 // hour label every N bars

// ---------- Settings ----------
var DEFAULT_REFRESH_MINUTES = 10
var MAX_REFRESH_MINUTES = 60
var DEFAULT_REMINDER_TIME = "19:00"

// ---------- Request limits ----------
var REQUEST_TIMEOUT_MS = 15 * SECOND_MS
var MAX_RESPONSE_CHARS = 2 * 1024 * 1024
// Pseudo-statuses for failures that never got an HTTP status.
var STATUS_OFFLINE = 0        // network error or timeout
var STATUS_TOO_LARGE = -1     // response exceeded MAX_RESPONSE_CHARS
var STATUS_BAD_TOKEN = -2     // stored token isn't a valid API token; nothing was sent

// ---------- Transport ----------
// Requests go through curl rather than XMLHttpRequest: Qt's XHR follows
// redirects to other hosts and sends the Authorization header along, and
// QML can't turn that off. curl follows no redirects unless asked to.
var CURL_EXIT_TIMEOUT = 28
var CURL_EXIT_TOO_LARGE = 63
var CONNECT_TIMEOUT_SECONDS = 10

// The curl argv for one GET. The Authorization header is not in it: curl
// reads it from stdin (--header @-), so the token never shows up in the
// process list. --disable must come first and skips ~/.curlrc, which could
// otherwise turn on --location. --proto =https refuses anything but HTTPS.
// The body is followed by a newline and the HTTP status.
function curlCommand(url) {
  return [
    "curl", "--disable",
    "--silent", "--show-error",
    "--proto", "=https",
    "--max-redirs", "0",
    "--connect-timeout", String(CONNECT_TIMEOUT_SECONDS),
    "--max-time", String(REQUEST_TIMEOUT_MS / SECOND_MS),
    "--max-filesize", String(MAX_RESPONSE_CHARS),
    "--header", "@-",
    "--header", "Wanikani-Revision: " + API_REVISION,
    "--write-out", "\n%{http_code}",
    "--url", url
  ]
}

function parseJsonObject(text) {
  try {
    var json = JSON.parse(text)
    return json !== null && typeof json === "object" ? json : null
  } catch (e) {
    return null
  }
}

// curl's exit code and stdout → { status, json }. Fails closed: anything
// unexpected is STATUS_OFFLINE, and a 200 without a JSON object is too.
function parseCurlResult(exitCode, output) {
  var failed = { status: STATUS_OFFLINE, json: null }
  if (exitCode === CURL_EXIT_TOO_LARGE) return { status: STATUS_TOO_LARGE, json: null }
  if (exitCode !== 0) return failed
  var text = String(output || "")
  var cut = text.lastIndexOf("\n")
  if (cut < 0) return failed
  var status = /^\d{3}$/.test(text.slice(cut + 1)) ? Number(text.slice(cut + 1)) : 0
  if (status < 100 || status > 599) return failed
  var body = text.slice(0, cut)
  if (body.length > MAX_RESPONSE_CHARS) return { status: STATUS_TOO_LARGE, json: null }
  var json = parseJsonObject(body)
  if (status === 200 && json === null) return failed
  return { status: status, json: json }
}

function authorizationHeader(token) {
  return "Authorization: Bearer " + token + "\n"
}

// ---------- Validation ----------
// Everything from the API is untrusted: numbers are clamped to sane ranges,
// strings are cut to a maximum length and stripped of control characters.
// Markup is left as literal text; every sink renders Text.PlainText.
var MAX_COUNT = 100000
var MAX_LEVEL = 60
var MAX_ENTRIES = 200
var MAX_SUMMARY_ENTRIES = 48       // /summary lists at most 24h + 24h
var MAX_ASSIGNMENTS = 1000
var MAX_MEANINGS = 20
var MAX_LESSON_POSITION = 10000
var MAX_TIMESTAMP_CHARS = 40
var MAX_USERNAME_CHARS = 64
var MAX_CHARACTERS_CHARS = 8
var MAX_MEANING_CHARS = 64
var MAX_TOKEN_CHARS = 64
var BURNED_STAGE = 9
var LOCKED_STAGE = -1              // no assignment yet

function clampInt(value, min, max) {
  var n = Math.floor(Number(value))
  if (!isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return ""
  var s = value.replace(/[\u0000-\u001f\u007f]/g, "")
  return s.length > maxLength ? s.slice(0, maxLength) : s
}

function list(value, max) {
  return Array.isArray(value) ? value.slice(0, max === undefined ? MAX_ENTRIES : max) : []
}

function objectOr(value, fallback) {
  return value && typeof value === "object" ? value : fallback
}

// The `data` object of an API resource, or {} when it is missing.
function dataOf(json) {
  return objectOr(json && json.data, {})
}

function count(entry) {
  return entry && Array.isArray(entry.subject_ids) ? clampInt(entry.subject_ids.length, 0, MAX_COUNT) : 0
}

function timeOf(value) {
  if (typeof value !== "string" || value.length > MAX_TIMESTAMP_CHARS) return null
  var t = Date.parse(value)
  return isNaN(t) ? null : t
}

function sumCounts(entries) {
  return clampInt(entries.reduce(function(sum, entry) { return sum + entry.count }, 0), 0, MAX_COUNT)
}

// Splits /summary entries into what is available at `nowMs` and the rest,
// as { time, count } sorted by time. An entry without a timestamp counts as
// available.
function splitByAvailability(entries, nowMs) {
  var available = []
  var upcoming = []
  entries.forEach(function(entry) {
    var time = timeOf(entry && entry.available_at)
    var item = { time: time, count: count(entry) }
    if (time === null || time <= nowMs) available.push(item)
    else upcoming.push(item)
  })
  upcoming.sort(function(a, b) { return a.time - b.time })
  return { available: available, upcoming: upcoming }
}

// ---------- /summary ----------
// `reviews[0]` holds everything already available; later entries are the
// reviews unlocking at that hour (non-cumulative).
function parseSummary(json, now) {
  var data = dataOf(json)
  var nowMs = now === undefined ? Date.now() : now
  var lessons = splitByAvailability(list(data.lessons, MAX_SUMMARY_ENTRIES), nowMs)
  var reviews = splitByAvailability(list(data.reviews, MAX_SUMMARY_ENTRIES), nowMs)

  return {
    lessons: sumCounts(lessons.available),
    reviews: sumCounts(reviews.available),
    nextReviewsAt: timeOf(data.next_reviews_at),
    forecast: reviews.upcoming,
    forecastTotal: sumCounts(reviews.upcoming)
  }
}

// ---------- /user ----------
function parseUser(json) {
  var data = dataOf(json)
  return {
    username: cleanText(data.username, MAX_USERNAME_CHARS),
    level: clampInt(data.level, 0, MAX_LEVEL)
  }
}

function startOfHour(time) {
  var d = new Date(time)
  d.setMinutes(0, 0, 0)
  return d.getTime()
}

// Fixed hourly slots starting at the hour after `now`, so the chart keeps
// its shape even when the API skips empty hours.
function hourlySlots(forecast, now, hours) {
  var slotCount = hours || FORECAST_HOURS
  var firstSlot = startOfHour(now) + HOUR_MS
  var slots = []
  for (var i = 0; i < slotCount; i++) slots.push({ time: firstSlot + i * HOUR_MS, count: 0 })
  var entries = forecast || []
  entries.forEach(function(entry) {
    var index = Math.round((entry.time - firstSlot) / HOUR_MS)
    if (index >= 0 && index < slotCount) slots[index].count += entry.count
  })
  return slots
}

// ---------- Bar pill ----------
// Shown instead of "0" once every review is done.
// Nerd Font check (nf-fa-check, U+F00C), bolder than ✓ at bar size. Written
// as an escape: private-use glyphs are invisible and easy to lose in edits.
var DONE_MARK = "\uf00c"

// The pill in two parts so the done mark can take the accent color:
// main = review count or the check, extra = "· <lessons>" or "".
// `formatNumber` localizes digits (Commons.I18n.formatNumber in the shell).
function barParts(state, showLessons, formatNumber) {
  var format = formatNumber || String
  if (!state || state.reviews === undefined) return { main: "…", extra: "", done: false }
  var done = state.reviews === 0
  return {
    main: done ? DONE_MARK : format(state.reviews),
    extra: showLessons && state.lessons > 0 ? "· " + format(state.lessons) : "",
    done: done
  }
}

// Nothing to do as far as the bar shows: no reviews, and no lessons either,
// or lessons hidden from the bar. This is exactly when the pill would show
// the bare done check, which hideWhenIdle replaces by hiding the pill.
// Unknown counts (loading, failed) are never idle.
function idle(state, showLessons) {
  if (!state || state.reviews === undefined) return false
  return state.reviews === 0 && !(showLessons && state.lessons > 0)
}

// ---------- Time ----------
// Time until `target`, split for translation: kind is one of
// "none", "now", "minutes", "hours", "hoursMinutes", "days", "daysHours".
function duration(target, now) {
  if (target === null || target === undefined) return { kind: "none" }
  var diff = target - now
  if (diff <= 0) return { kind: "now" }
  var minutes = Math.round(diff / MINUTE_MS)
  if (minutes < 60) return { kind: "minutes", minutes: Math.max(1, minutes) }
  var hours = Math.floor(minutes / 60)
  var restMinutes = minutes % 60
  if (hours < 24) {
    return restMinutes ? { kind: "hoursMinutes", hours: hours, minutes: restMinutes } : { kind: "hours", hours: hours }
  }
  var days = Math.floor(hours / 24)
  var restHours = hours % 24
  return restHours ? { kind: "daysHours", days: days, hours: restHours } : { kind: "days", days: days }
}

// Milliseconds until shortly after the next full hour, when WaniKani unlocks
// the next batch of reviews.
function msUntilNextHour(now, slackMs) {
  var slack = slackMs === undefined ? HOUR_REFRESH_SLACK_MS : slackMs
  return startOfHour(now) + HOUR_MS + slack - now
}

// ---------- Errors ----------
// Messages are { key, arg } for i18n; the catalog string fills %1 with arg.
function message(key, arg) {
  return { key: key, arg: arg === undefined ? "" : String(arg) }
}

function errorInfo(status) {
  if (status === STATUS_TOO_LARGE) return message("error.tooLarge")
  if (status === STATUS_BAD_TOKEN) return message("token.format")
  if (status === STATUS_OFFLINE) return message("error.offline")
  if (status === 401) return message("error.token")
  if (status === 429) return message("error.rateLimited")
  if (status >= 500) return message("error.server", status)
  return message("error.generic", status)
}

// API v2 tokens are UUIDs. Catches pasting the wrong thing (e.g. a v1 key or
// a URL) before bothering the API. Returns an i18n key, or "" if it looks fine.
var TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Exactly a token, nothing around or inside it. Checked right before every
// request, so a malformed stored value (e.g. one with line breaks) can never
// end up in the Authorization header.
function isValidToken(token) {
  return typeof token === "string" && TOKEN_PATTERN.test(token)
}

// The token needs replacing: WaniKani refused it, or it was never valid.
function tokenRejected(status) {
  return status === 401 || status === STATUS_BAD_TOKEN
}

function tokenProblem(token) {
  var trimmed = String(token || "").trim()
  if (trimmed === "") return "token.empty"
  if (!TOKEN_PATTERN.test(trimmed)) return "token.format"
  return ""
}

// ---------- SRS breakdown ----------
// Each group is fetched as /assignments?srs_stages=… and only total_count is
// read, so a 9000-item account costs five requests instead of ~18 pages.
// Labels live in i18n as "srs.<key>.short".
var SRS_GROUPS = [
  { key: "apprentice",  stages: "1,2,3,4" },
  { key: "guru",        stages: "5,6" },
  { key: "master",      stages: "7" },
  { key: "enlightened", stages: "8" },
  { key: "burned",      stages: "9" }
]

function srsBreakdown(counts) {
  var byGroup = counts || {}
  return SRS_GROUPS.map(function(group) {
    return { key: group.key, count: clampInt(byGroup[group.key] || 0, 0, MAX_COUNT) }
  })
}

function totalCount(json) {
  return json && typeof json.total_count === "number" ? clampInt(json.total_count, 0, MAX_COUNT) : 0
}

// ---------- Level progress ----------
// WaniKani levels you up once 90% of the level's (non-hidden) kanji reach
// Guru, i.e. have a passed_at timestamp.
var LEVEL_UP_RATIO = 0.9

function assignmentsBySubject(assignmentsJson) {
  var bySubject = {}
  list(assignmentsJson && assignmentsJson.data, MAX_ASSIGNMENTS).forEach(function(resource) {
    var assignment = dataOf(resource)
    if (typeof assignment.subject_id === "number") bySubject[assignment.subject_id] = assignment
  })
  return bySubject
}

function primaryMeaning(subjectData) {
  var primary = list(subjectData.meanings, MAX_MEANINGS).filter(function(m) { return m && m.primary })[0]
  return primary ? cleanText(primary.meaning, MAX_MEANING_CHARS) : ""
}

// subjectsJson: /subjects?levels=L&types=kanji
// assignmentsJson: /assignments?levels=L&subject_types=kanji
function levelProgress(subjectsJson, assignmentsJson, level) {
  var bySubject = assignmentsBySubject(assignmentsJson)

  var items = []
  list(subjectsJson && subjectsJson.data).forEach(function(subject) {
    var resource = subject || {}
    var subjectData = dataOf(resource)
    if (subjectData.hidden_at || typeof resource.id !== "number") return
    var assignment = bySubject[resource.id]
    items.push({
      id: resource.id,
      characters: cleanText(subjectData.characters, MAX_CHARACTERS_CHARS) || "?",
      meaning: primaryMeaning(subjectData),
      position: clampInt(subjectData.lesson_position, 0, MAX_LESSON_POSITION),
      stage: assignment ? clampInt(assignment.srs_stage, 0, BURNED_STAGE) : LOCKED_STAGE,
      passed: !!(assignment && assignment.passed_at)
    })
  })
  items.sort(function(a, b) { return a.position - b.position })

  var total = items.length
  var passed = items.filter(function(item) { return item.passed }).length
  var required = Math.ceil(total * LEVEL_UP_RATIO)
  return {
    level: clampInt(level, 0, MAX_LEVEL),
    total: total,
    passed: passed,
    required: required,
    remaining: Math.max(0, required - passed),
    items: items
  }
}

// Coarse state for coloring a kanji tile.
function itemState(item) {
  if (!item || item.stage < 0) return "locked"
  if (item.passed) return "passed"
  if (item.stage === 0) return "lesson"
  return "learning"
}

function stageInfo(stage) {
  if (stage < 0) return message("stage.locked")
  if (stage === 0) return message("stage.lesson")
  if (stage <= 4) return message("stage.apprentice", stage)
  if (stage <= 6) return message("stage.guru", stage - 4)
  if (stage === 7) return message("stage.master")
  if (stage === 8) return message("stage.enlightened")
  return message("stage.burned")
}

// ---------- Settings ----------
// Integer setting clamped to [min, max]; `fallback` when missing or not a number.
function intSetting(value, fallback, min, max) {
  var n = parseInt(value, 10)
  return clampInt(isNaN(n) ? fallback : n, min, max === undefined ? Number.MAX_SAFE_INTEGER : max)
}

// The reminder time as shown in its text field.
function clockText(value) {
  return String(value === undefined || value === null ? DEFAULT_REMINDER_TIME : value).slice(0, 5)
}

// The command that opens WaniKani links, as an argv; the URL is appended as
// its last argument. It has no row on the settings page: set it in
// shell.json or with setSetting.
var DEFAULT_OPEN_COMMAND = ["omarchy-launch-browser"]
// Words that would end the command early in omarchy-notification-send.
var NOTIFICATION_DELIMITERS = ["--action", "--with", "--exec"]
// The notification shell drops an action of more than 32 words, link included.
var MAX_OPEN_COMMAND_WORDS = 30

// The setting as an argv, or null when it can't be used. It must work for
// the popup and for the reminder's button alike, so it follows the
// notification shell's rules for an action too.
function parseOpenCommand(value) {
  var words = value
  if (typeof value === "string") {
    // One program name, never split into words: a command with arguments
    // is a list. A string with a space would name a program that isn't there.
    if (/\s/.test(value)) return null
    words = [value]
  }
  if (!Array.isArray(words) || words.length === 0 || words.length > MAX_OPEN_COMMAND_WORDS) return null
  for (var i = 0; i < words.length; i++) {
    var word = words[i]
    if (typeof word !== "string" || word === "" || word.indexOf("\u0000") !== -1) return null
    if (NOTIFICATION_DELIMITERS.indexOf(word) !== -1) return null
  }
  if (words[0].charAt(0) === "-") return null
  return words.slice()
}

function openCommand(value) {
  return parseOpenCommand(value) || DEFAULT_OPEN_COMMAND.slice()
}

// Keys the setSetting IPC call may write: the manifest's settings, except
// apiToken, which only goes through the popup's validated token flow.
var IPC_SETTING_KEYS = [
  "refreshMinutes", "showLessons", "hideWhenIdle", "highlightThreshold",
  "reminderEnabled", "reminderTime", "reminderMinReviews", "openCommand"
]

function ipcSettingAllowed(key) {
  return IPC_SETTING_KEYS.indexOf(key) !== -1
}

// ---------- Daily review reminder ----------

// "19:00" / "7:30" → minutes after midnight, or -1 when unparseable.
function parseClock(text) {
  var match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text || ""))
  if (!match) return -1
  var hours = parseInt(match[1], 10)
  var minutes = parseInt(match[2], 10)
  if (hours > 23 || minutes > 59) return -1
  return hours * 60 + minutes
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n
}

// Local calendar date, used to remember "already reminded today".
function dateKey(time) {
  var d = new Date(time)
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
}

// Due once the configured time has passed today and today hasn't been
// handled yet, so a laptop asleep at 19:00 still gets reminded on wake
// (until midnight).
function reminderDue(now, clockMinutes, lastDateKey) {
  if (clockMinutes < 0) return false
  var d = new Date(now)
  if (d.getHours() * 60 + d.getMinutes() < clockMinutes) return false
  return dateKey(now) !== String(lastDateKey || "").trim()
}

// ---------- Placeholders ----------
// Fills %1…%9 in one pass. Unlike chained QString.arg(), text that was
// already inserted is never re-scanned, so a username containing "%1" stays
// literal, and JS replacement patterns like "$&" aren't interpreted.
function fill(template) {
  var args = arguments
  return String(template).replace(/%(\d)/g, function(match, index) {
    var value = args[Number(index)]
    return value === undefined ? match : String(value)
  })
}
