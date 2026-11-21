import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// The daily review reminder. Once the configured time has passed, it fetches
// fresh counts and notifies if enough reviews are waiting, at most once per
// day. The handled date lives on disk: the shell rebuilds plugins whenever
// any plugin's files change, which would otherwise re-send the reminder.
Item {
  id: reminder

  required property WaniKaniClient client
  required property Localization l10n
  property bool active: false       // setting on and a token present
  property int clockMinutes: -1     // Model.parseClock of the setting
  property int minReviews: 1
  property var openCommand: Model.DEFAULT_OPEN_COMMAND

  // Date key of the last day handled, "" if none.
  property string lastDate: ""
  property bool stateLoaded: false
  property bool checking: false

  // Fresh counts fetched for the check, so the panel can show them too.
  signal summaryFetched(var summary)

  // A check belongs to the run it started in. Turning the reminder off (in
  // settings, or by removing the last widget) starts a new run, so a check
  // still in flight can't update state, mark the day or notify afterwards.
  property int run: 0
  onActiveChanged: if (!active) {
    run++
    checking = false
  }

  // A check in flight for the previous token is dropped by the client, so
  // don't wait for it.
  Connections {
    target: reminder.client
    function onGenerationChanged() { reminder.checking = false }
  }

  function check() {
    var now = Date.now()
    if (!reminder.active || !reminder.stateLoaded || reminder.checking) return
    if (!Model.reminderDue(now, reminder.clockMinutes, reminder.lastDate)) return
    reminder.checking = true
    var run = reminder.run
    // Fresh counts, so reviews done minutes ago don't trigger a stale nag.
    client.get("/summary", function(status, json) {
      if (run !== reminder.run || !reminder.active) return
      reminder.checking = false
      if (status !== 200) return   // not marked: retry on the next check
      var summary = Model.parseSummary(json, Date.now())
      reminder.summaryFetched(summary)
      reminder.markDone(now)
      if (summary.reviews >= reminder.minReviews) reminder.send(summary.reviews, summary.lessons)
    })
  }

  function markDone(now) {
    reminder.lastDate = Model.dateKey(now)
    stateFile.setText(reminder.lastDate + "\n")
  }

  // Only numbers and the plugin's own catalog strings reach the notification.
  function send(reviews, lessons) {
    var headline = Model.fill(l10n.tn("reminder.headline", reviews), l10n.formatNumber(reviews))
    var body = lessons > 0
      ? Model.fill(l10n.tn("reminder.bodyLessons", lessons), l10n.formatNumber(lessons))
      : l10n.t("reminder.body")
    // omarchy-notification-send parses leading dashes as options.
    if (headline.charAt(0) === "-" || body.charAt(0) === "-") return
    notifyProc.command = [
      "omarchy-notification-send",
      "--app-name", Model.APP_NAME,
      "-g", Model.ICON_GLYPH,
      "-u", "normal",
      headline, body,
      "--action", l10n.t("reminder.action")
    ].concat(reminder.openCommand, [Model.REVIEW_URL])
    notifyProc.running = true
  }

  Process { id: notifyProc }

  FileView {
    id: stateFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/kanibar-reminder"
    printErrors: false
    onLoaded: {
      reminder.lastDate = String(text() || "").trim().slice(0, 10)
      reminder.stateLoaded = true
    }
    onLoadFailed: {
      reminder.lastDate = ""
      reminder.stateLoaded = true
    }
  }

  Timer {
    interval: Model.REMINDER_CHECK_MS
    running: reminder.active
    repeat: true
    triggeredOnStart: true
    onTriggered: reminder.check()
  }
}
