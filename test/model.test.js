// Unit tests for Model.js. Run with: node --test test/
const test = require("node:test")
const assert = require("node:assert/strict")
const { Model, plain } = require("./load-model")

const NOW = Date.parse("2026-11-15T13:20:00Z")

const summary = {
  object: "report",
  data: {
    lessons: [{ available_at: "2026-11-15T13:00:00Z", subject_ids: [1, 2, 3, 4, 5] }],
    next_reviews_at: "2026-11-15T13:00:00Z",
    reviews: [
      { available_at: "2026-11-15T13:00:00Z", subject_ids: [10, 11, 12] },
      { available_at: "2026-11-15T14:00:00Z", subject_ids: [] },
      { available_at: "2026-11-15T15:00:00Z", subject_ids: [20, 21] },
      { available_at: "2026-11-16T12:00:00Z", subject_ids: [30] }
    ]
  }
}

// ---------- Parsing ----------

test("parseSummary counts what is available now", () => {
  const s = Model.parseSummary(summary, NOW)
  assert.equal(s.reviews, 3)
  assert.equal(s.lessons, 5)
  assert.equal(s.forecastTotal, 3)
  assert.equal(s.forecast.length, 3)
})

test("parseSummary tolerates empty or malformed input", () => {
  for (const bad of [null, {}, { data: "x" }, { data: { reviews: "nope", lessons: 7 } }, { data: { reviews: [null, 5] } }]) {
    const s = Model.parseSummary(bad, NOW)
    assert.equal(s.reviews, 0)
    assert.equal(s.lessons, 0)
    assert.equal(s.nextReviewsAt, null)
  }
})

test("parseSummary bounds collection sizes and timestamps", () => {
  const many = { data: { reviews: Array.from({ length: 500 }, () => ({ available_at: "2026-11-15T13:00:00Z", subject_ids: [1] })), next_reviews_at: "x".repeat(100) } }
  const s = Model.parseSummary(many, NOW)
  assert.equal(s.reviews, 48)          // only the first 48 entries are read
  assert.equal(s.nextReviewsAt, null)  // over-long timestamp rejected
})

test("hourlySlots buckets the forecast into 24 fixed hours", () => {
  const s = Model.parseSummary(summary, NOW)
  const slots = Model.hourlySlots(s.forecast, NOW, 24)
  assert.equal(slots.length, 24)
  assert.equal(slots[0].time, Date.parse("2026-11-15T14:00:00Z"))
  assert.equal(slots[1].count, 2)
  assert.equal(slots[22].count, 1)
})

test("parseUser", () => {
  const u = Model.parseUser({ data: { username: "koichi", level: 12, subscription: { active: true, max_level_granted: 60 } } })
  assert.deepEqual(plain(u), { username: "koichi", level: 12 })
})

test("parseUser clamps and cleans untrusted fields", () => {
  const u = Model.parseUser({ data: { username: "a\u0000b\nc" + "x".repeat(200), level: 9999, subscription: "x" } })
  assert.equal(u.username.startsWith("abc"), true)
  assert.equal(u.username.length, 64)
  assert.equal(u.level, 60)
  assert.equal(Model.parseUser({ data: { level: -3 } }).level, 0)
  assert.equal(Model.parseUser({ data: { level: "NaN" } }).level, 0)
  assert.equal(Model.parseUser({ data: { username: 42 } }).username, "")
})

// ---------- Markup-shaped input ----------
// Model keeps markup as literal text (never interprets or strips it); every
// sink renders Text.PlainText (enforced in contracts.test.js).

const MARKUP = '<img src="https://example.invalid/tracker"><b>x</b>'

test("markup-shaped username and meaning stay literal and bounded", () => {
  assert.equal(Model.parseUser({ data: { username: MARKUP } }).username, MARKUP)
  const p = Model.levelProgress(
    { data: [{ id: 1, data: { characters: MARKUP, meanings: [{ meaning: MARKUP, primary: true }] } }] },
    { data: [] }, 1)
  assert.equal(p.items[0].characters, MARKUP.slice(0, 8))
  assert.equal(p.items[0].meaning, MARKUP)
})

test("fill inserts untrusted text without re-scanning it", () => {
  assert.equal(Model.fill("Connected as %1 (level %2).", "%2 $& <b>", "27"), "Connected as %2 $& <b> (level 27).")
  assert.equal(Model.fill("Level %1 · %2", "27", "%1%1"), "Level 27 · %1%1")
  assert.equal(Model.fill("No placeholder"), "No placeholder")
  assert.equal(Model.fill("%1 and %3", "a"), "a and %3")
})

// ---------- Pill ----------

test("barParts", () => {
  assert.equal(Model.DONE_MARK, "\uf00c")   // the check glyph, not an empty string
  assert.deepEqual(plain(Model.barParts(null, true)), { main: "…", extra: "", done: false })
  assert.deepEqual(plain(Model.barParts({ reviews: 42, lessons: 5 }, true)), { main: "42", extra: "· 5", done: false })
  assert.equal(Model.barParts({ reviews: 42, lessons: 5 }, false).extra, "")
  assert.deepEqual(plain(Model.barParts({ reviews: 0, lessons: 0 }, true)), { main: Model.DONE_MARK, extra: "", done: true })
  assert.deepEqual(plain(Model.barParts({ reviews: 0, lessons: 5 }, true)), { main: Model.DONE_MARK, extra: "· 5", done: true })
  // Localized digits come from the formatter.
  assert.deepEqual(plain(Model.barParts({ reviews: 1234, lessons: 5 }, true, (n) => "#" + n)), { main: "#1234", extra: "· #5", done: false })
})

test("idle follows what the pill shows", () => {
  assert.equal(Model.idle(null, true), false)                         // loading or failed
  assert.equal(Model.idle({ reviews: 3, lessons: 0 }, true), false)
  assert.equal(Model.idle({ reviews: 0, lessons: 0 }, true), true)
  assert.equal(Model.idle({ reviews: 0, lessons: 5 }, true), false)   // "✓ · 5" stays
  assert.equal(Model.idle({ reviews: 0, lessons: 5 }, false), true)   // lessons hidden: bare check
  // Idle exactly when the pill would be the bare check.
  for (const state of [{ reviews: 0, lessons: 0 }, { reviews: 0, lessons: 5 }, { reviews: 2, lessons: 5 }]) {
    for (const showLessons of [true, false]) {
      const parts = Model.barParts(state, showLessons)
      assert.equal(Model.idle(state, showLessons), parts.done && parts.extra === "")
    }
  }
})

// ---------- Time ----------

test("duration splits time for translation", () => {
  assert.equal(Model.duration(null, NOW).kind, "none")
  assert.equal(Model.duration(NOW - 1, NOW).kind, "now")
  assert.deepEqual(plain(Model.duration(NOW + 20 * 60000, NOW)), { kind: "minutes", minutes: 20 })
  assert.deepEqual(plain(Model.duration(NOW + 135 * 60000, NOW)), { kind: "hoursMinutes", hours: 2, minutes: 15 })
  assert.deepEqual(plain(Model.duration(NOW + 120 * 60000, NOW)), { kind: "hours", hours: 2 })
  assert.deepEqual(plain(Model.duration(NOW + 26 * 3600000, NOW)), { kind: "daysHours", days: 1, hours: 2 })
  assert.deepEqual(plain(Model.duration(NOW + 48 * 3600000, NOW)), { kind: "days", days: 2 })
})

test("msUntilNextHour lands just after the hour", () => {
  assert.equal(Model.msUntilNextHour(NOW, 30000), 40 * 60000 + 30000)
})

// ---------- Errors and token ----------

test("errorInfo maps statuses to catalog keys", () => {
  assert.equal(Model.errorInfo(Model.STATUS_OFFLINE).key, "error.offline")
  assert.equal(Model.errorInfo(Model.STATUS_TOO_LARGE).key, "error.tooLarge")
  assert.equal(Model.errorInfo(401).key, "error.token")
  assert.equal(Model.errorInfo(429).key, "error.rateLimited")
  assert.deepEqual(plain(Model.errorInfo(503)), { key: "error.server", arg: "503" })
  assert.deepEqual(plain(Model.errorInfo(404)), { key: "error.generic", arg: "404" })
})

// ---------- Transport ----------

test("curlCommand keeps the token out of argv and redirects off", () => {
  const url = "https://api.wanikani.com/v2/user"
  const args = Model.curlCommand(url)
  assert.deepEqual(plain(args.slice(0, 2)), ["curl", "--disable"])     // --disable only works first
  assert.equal(args[args.indexOf("--proto") + 1], "=https")
  assert.equal(args[args.indexOf("--max-redirs") + 1], "0")
  assert.equal(args.indexOf("--location"), -1)
  assert.equal(args.indexOf("-L"), -1)
  assert.equal(args[args.indexOf("--header") + 1], "@-")
  assert.deepEqual(plain(args.slice(-2)), ["--url", url])
  assert.ok(!args.some(a => /authorization|bearer/i.test(a)), "no credentials in argv")
  assert.equal(Model.authorizationHeader("abc"), "Authorization: Bearer abc\n")
})

test("parseCurlResult fails closed", () => {
  assert.deepEqual(plain(Model.parseCurlResult(0, '{"data":{}}\n200')), { status: 200, json: { data: {} } })
  assert.deepEqual(plain(Model.parseCurlResult(0, '{"error":"x"}\n401')), { status: 401, json: { error: "x" } })
  assert.equal(Model.parseCurlResult(0, "\n302").status, 302)                     // redirect not followed
  assert.equal(Model.parseCurlResult(0, "<html>\n200").status, Model.STATUS_OFFLINE) // 200 without JSON
  assert.equal(Model.parseCurlResult(0, "[1,2]\n200").status, 200)                // arrays are objects
  assert.equal(Model.parseCurlResult(0, '"str"\n200').status, Model.STATUS_OFFLINE)
  assert.equal(Model.parseCurlResult(0, "{}\nabc").status, Model.STATUS_OFFLINE)
  assert.equal(Model.parseCurlResult(0, "{}").status, Model.STATUS_OFFLINE)        // no status line
  assert.equal(Model.parseCurlResult(0, "").status, Model.STATUS_OFFLINE)
  assert.equal(Model.parseCurlResult(28, "").status, Model.STATUS_OFFLINE)         // timeout
  assert.equal(Model.parseCurlResult(7, "").status, Model.STATUS_OFFLINE)          // can't connect
  assert.equal(Model.parseCurlResult(63, "").status, Model.STATUS_TOO_LARGE)       // --max-filesize
  assert.equal(Model.parseCurlResult(0, "x".repeat(Model.MAX_RESPONSE_CHARS + 1) + "\n200").status, Model.STATUS_TOO_LARGE)
})

test("isValidToken accepts exactly one token", () => {
  assert.equal(Model.isValidToken("8f2b1c3a-1234-4abc-9def-0123456789ab"), true)
  assert.equal(Model.isValidToken(" 8f2b1c3a-1234-4abc-9def-0123456789ab"), false)
  assert.equal(Model.isValidToken("8f2b1c3a-1234-4abc-9def-0123456789ab\r\nX-Evil: 1"), false)
  assert.equal(Model.isValidToken(""), false)
  assert.equal(Model.isValidToken(null), false)
  assert.equal(Model.errorInfo(Model.STATUS_BAD_TOKEN).key, "token.format")
  assert.equal(Model.tokenRejected(401), true)
  assert.equal(Model.tokenRejected(Model.STATUS_BAD_TOKEN), true)
  assert.equal(Model.tokenRejected(Model.STATUS_OFFLINE), false)
})

test("tokenProblem", () => {
  assert.equal(Model.tokenProblem("  8f2b1c3a-1234-4abc-9def-0123456789ab \n"), "")
  assert.equal(Model.tokenProblem(""), "token.empty")
  assert.equal(Model.tokenProblem("https://www.wanikani.com"), "token.format")
  assert.equal(Model.tokenProblem("abc123"), "token.format")
})

// ---------- SRS and level ----------

test("srsBreakdown fills missing groups and clamps", () => {
  const b = Model.srsBreakdown({ apprentice: 80, burned: 1200, guru: -5 })
  assert.deepEqual(plain(b.map(g => g.count)), [80, 0, 0, 0, 1200])
  assert.deepEqual(plain(b.map(g => g.key)), ["apprentice", "guru", "master", "enlightened", "burned"])
  assert.equal(Model.totalCount({ total_count: 42 }), 42)
  assert.equal(Model.totalCount({ total_count: 1e12 }), Model.MAX_COUNT)
  assert.equal(Model.totalCount(null), 0)
})

test("levelProgress applies the 90% Guru rule and skips hidden kanji", () => {
  const subjects = { data: [] }
  for (let i = 1; i <= 11; i++) {
    subjects.data.push({ id: i, data: { characters: "字" + i, lesson_position: 12 - i, meanings: [{ meaning: "m" + i, primary: true }], hidden_at: i === 11 ? "2020-01-01T00:00:00Z" : null } })
  }
  const assignments = { data: [
    { data: { subject_id: 1, srs_stage: 5, passed_at: "2026-11-01T00:00:00Z" } },
    { data: { subject_id: 2, srs_stage: 7, passed_at: "2026-11-01T00:00:00Z" } },
    { data: { subject_id: 3, srs_stage: 3, passed_at: null } },
    { data: { subject_id: 4, srs_stage: 0, passed_at: null } }
  ] }
  const p = Model.levelProgress(subjects, assignments, 12)
  assert.equal(p.total, 10)            // hidden one dropped
  assert.equal(p.passed, 2)
  assert.equal(p.required, 9)          // ceil(10 * 0.9)
  assert.equal(p.remaining, 7)
  assert.equal(p.items[0].characters, "字10")  // sorted by lesson_position
  const byId = Object.fromEntries(p.items.map(it => [it.id, Model.itemState(it)]))
  assert.equal(byId[1], "passed")
  assert.equal(byId[3], "learning")
  assert.equal(byId[4], "lesson")
  assert.equal(byId[5], "locked")
})

test("levelProgress caps subjects and clamps stages", () => {
  const subjects = { data: Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, data: { characters: "字" } })) }
  const assignments = { data: [{ data: { subject_id: 1, srs_stage: 99 } }] }
  const p = Model.levelProgress(subjects, assignments, 5)
  assert.equal(p.total, Model.MAX_ENTRIES)
  assert.equal(p.items.find(it => it.id === 1).stage, 9)
})

test("stageInfo", () => {
  assert.equal(Model.stageInfo(-1).key, "stage.locked")
  assert.deepEqual(plain(Model.stageInfo(3)), { key: "stage.apprentice", arg: "3" })
  assert.deepEqual(plain(Model.stageInfo(6)), { key: "stage.guru", arg: "2" })
  assert.equal(Model.stageInfo(9).key, "stage.burned")
})

// ---------- Reminder ----------

test("intSetting and clockText", () => {
  assert.equal(Model.intSetting("15", 10, 0, 60), 15)
  assert.equal(Model.intSetting("nope", 10, 0, 60), 10)
  assert.equal(Model.intSetting(999, 10, 0, 60), 60)
  assert.equal(Model.intSetting(-4, 1, 1), 1)
  assert.equal(Model.clockText("07:30:00"), "07:30")
  assert.equal(Model.clockText(undefined), Model.DEFAULT_REMINDER_TIME)
})

test("openCommand", () => {
  const fallback = ["omarchy-launch-browser"]
  assert.deepEqual(plain(Model.openCommand(undefined)), fallback)
  assert.deepEqual(plain(Model.openCommand("omarchy-launch-webapp")), ["omarchy-launch-webapp"])
  assert.deepEqual(plain(Model.openCommand(["chromium", "--new-window"])), ["chromium", "--new-window"])
  const bad = [
    null, "", [], 5, {}, ["a", 5], ["a", ""], ["a", "b\u0000"],
    "chromium --new-window",                       // a string is one program, never split
    ["a", "--action"], ["--with"], ["a", "--exec"], // would end the reminder's action early
    ["-a"], Array(31).fill("a")                    // the notification shell would drop the action
  ]
  for (const value of bad) {
    assert.equal(Model.parseOpenCommand(value), null)
    assert.deepEqual(plain(Model.openCommand(value)), fallback)
  }
  assert.equal(Model.openCommand(Array(30).fill("a")).length, 30)
  assert.deepEqual(plain(Model.openCommand(["a", "-b", "c d"])), ["a", "-b", "c d"])
  // The default is never handed out for a caller to change.
  Model.openCommand(undefined).push("x")
  assert.deepEqual(plain(Model.openCommand(undefined)), fallback)
})

test("parseClock", () => {
  assert.equal(Model.parseClock("19:00"), 1140)
  assert.equal(Model.parseClock(" 7:30 "), 450)
  assert.equal(Model.parseClock("24:00"), -1)
  assert.equal(Model.parseClock("7pm"), -1)
  assert.equal(Model.parseClock(""), -1)
})

test("reminderDue fires once per day after the configured time", () => {
  const at = (h, m) => new Date(2026, 10, 15, h, m).getTime()
  const seven = Model.parseClock("19:00")
  assert.equal(Model.reminderDue(at(18, 59), seven, ""), false)
  assert.equal(Model.reminderDue(at(19, 0), seven, ""), true)
  assert.equal(Model.reminderDue(at(22, 30), seven, "2026-11-14"), true)   // woke up late
  assert.equal(Model.reminderDue(at(22, 30), seven, "2026-11-15\n"), false) // already done today
  assert.equal(Model.reminderDue(at(22, 30), -1, ""), false)
  assert.equal(Model.dateKey(at(9, 0)), "2026-11-15")
})
