import QtQuick
import Quickshell
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// Kanibar: WaniKani reviews and lessons on the Omarchy bar.
// The pill shows reviews (and lessons) available now; clicking opens a popup
// with level progress, SRS stages and the 24-hour forecast. Data comes from
// the official WaniKani API v2.
//
// Omarchy creates this widget once per monitor. The account itself (token,
// data, refreshes, reminder) lives once in Service.qml; this file is one
// screen's view onto it: it hands the service its settings, mirrors the
// service's state for the popup, and owns only per-screen things such as
// the open popup's page and clock. The views next to it read state and emit
// intent.
//
// Safety notes (see Omarchy's plugin guide):
// - Every text goes through PlainText; test/contracts.test.js enforces it.
//   Shared sinks used with API text (PanelHero meta, PanelToolTip) render
//   PlainText internally.
// - Requests use a fixed HTTPS base, a timeout and a response-size cap;
//   Model.js clamps and length-limits everything it parses.
// - All user-facing strings come from i18n/<language>.json.
Panel {
  id: root
  moduleName: Model.PLUGIN_ID
  ipcTarget: Model.PLUGIN_ID
  manageIpc: false

  Localization { id: strings }

  // ---------- The shared service ----------
  // null for a moment at startup, until the shell has mounted it.
  readonly property var service: root.bar && root.bar.shell && typeof root.bar.shell.serviceFor === "function"
    ? root.bar.shell.serviceFor(Model.PLUGIN_ID) : null
  readonly property bool ready: service !== null

  // Every screen's widget shares one shell.json entry; any of them can hand
  // it over. An entry with only defaults arrives as {} and is handed over
  // too: removing the last override must reach the service.
  function pushSettings() {
    if (root.service && root.settings && typeof root.settings === "object") root.service.settings = root.settings
  }
  onSettingsChanged: pushSettings()

  // Attach to the service while this widget exists, so it knows a widget is
  // on the bar and stops background work once the last one is gone.
  property var attachedTo: null
  function syncService() {
    if (root.attachedTo === root.service) return
    if (root.attachedTo) root.attachedTo.detach(root)
    root.attachedTo = root.service
    if (root.service) {
      root.pushSettings()
      root.service.attach(root)
    }
  }
  // Change handlers don't run for a binding's first value, so also sync on
  // completion (the service usually exists already, e.g. for a 2nd monitor).
  onServiceChanged: syncService()
  Component.onCompleted: syncService()
  Component.onDestruction: if (root.attachedTo) root.attachedTo.detach(root)

  readonly property var tokenStore: ready ? service.tokenStore : null
  readonly property var tokenSession: ready ? service.tokenSession : null
  readonly property var reminder: ready ? service.reminder : null

  // ---------- Account state, from the service ----------
  readonly property bool keyringAvailable: !ready || service.keyringAvailable
  readonly property bool hasToken: ready && service.hasToken
  readonly property var summary: ready ? service.summary : null
  readonly property var user: ready ? service.user : null
  readonly property var error: ready ? service.error : null
  readonly property bool loading: ready && service.loading
  readonly property real lastUpdated: ready ? service.lastUpdated : 0
  readonly property var srsCounts: ready ? service.srsCounts : null
  readonly property var levelInfo: ready ? service.levelInfo : null
  readonly property bool tokenRejected: ready && service.tokenRejected
  readonly property bool tokenMalformed: ready && service.tokenMalformed
  readonly property bool disconnectIncomplete: ready && service.tokenSession.disconnectIncomplete
  readonly property int reviews: summary ? summary.reviews : 0
  readonly property int lessons: summary ? summary.lessons : 0

  // ---------- Display settings (this screen) ----------
  readonly property int refreshMinutes: ready ? service.refreshMinutes : Model.DEFAULT_REFRESH_MINUTES
  readonly property bool showLessons: setting("showLessons", true) === true
  readonly property bool hideWhenIdle: setting("hideWhenIdle", false) === true
  readonly property int highlightThreshold: Model.intSetting(setting("highlightThreshold", 0), 0, 0)
  readonly property bool reminderEnabled: ready && service.reminderEnabled
  readonly property string reminderTime: ready ? service.reminderTime : Model.DEFAULT_REMINDER_TIME
  readonly property int reminderMinReviews: ready ? service.reminderMinReviews : 1

  // Nothing the bar would show besides the done check (hideWhenIdle hides it).
  readonly property bool idle: Model.idle(summary, showLessons)

  // The clock for relative times in the open popup.
  property real now: Date.now()

  readonly property bool showTokenEntry: ready && (!hasToken || tokenRejected || service.tokenSession.editing)

  // "main" or "settings" (gear in the popup header).
  property string view: "main"
  readonly property bool inSettings: view === "settings"
  readonly property bool showMain: ready && !inSettings && !showTokenEntry

  readonly property var pillParts: {
    if (!ready) return { main: "…", extra: "", done: false }
    if (!hasToken) return { main: "—", extra: "", done: false }
    if (!summary) return { main: error !== null ? "!" : "…", extra: "", done: false }
    return Model.barParts(summary, showLessons, strings.formatNumber)
  }
  // All reviews cleared: the pill and popup show a check in the accent color.
  readonly property bool reviewsDone: pillParts.done === true

  function refresh() {
    root.now = Date.now()
    if (root.service) root.service.refresh(root.opened)
  }

  // Writes one key into this widget's shell.json entry; the shell pushes the
  // merged settings back, which re-evaluates every setting() binding.
  function persistSetting(key, value) {
    if (!root.bar || !root.bar.shell || typeof root.bar.shell.updateEntryInline !== "function") return
    var entry = { id: root.moduleName }
    var current = root.settings || {}
    for (var k in current) if (k !== "id") entry[k] = current[k]
    entry[key] = value
    root.settings = entry
    root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  function showSettings() {
    root.open()
    root.view = "settings"
  }

  function startTokenChange() {
    if (!root.ready) return
    root.open()
    root.view = "main"
    root.tokenSession.startEditing()
  }

  function openUrl(url) {
    var command = root.ready ? root.service.openCommand : Model.DEFAULT_OPEN_COMMAND
    Quickshell.execDetached(command.concat([url]))
    root.close()
  }

  onOpenedChanged: {
    if (opened) {
      // An unfinished Disconnect opens on its warning and retry.
      if (root.disconnectIncomplete) view = "settings"
      refresh()
    } else {
      if (root.ready) root.tokenSession.reset()
      view = "main"
    }
  }

  // A Disconnect on any screen returns every screen to its main view.
  Connections {
    target: root.service
    ignoreUnknownSignals: true
    function onDisconnected() { root.view = "main" }
  }

  ShellIpc {
    target: Model.PLUGIN_ID

    function open() { root.open() }
    function close() { root.close() }
    function show() { root.open() }
    function hide() { root.close() }
    function toggle() { root.toggle() }
    function refresh() { root.refresh() }
    // Sends the reminder now with the current counts (for testing the look).
    function testReminder() { if (root.reminder) root.reminder.send(root.reviews, root.lessons) }
    // Opens the popup on its settings page.
    function settings() { root.showSettings() }
    // Opens the popup on the token field, like "Change token".
    function changeToken() { root.startTokenChange() }
    // Same path the settings page uses, for scripts and dotfiles:
    //   omarchy-shell io.github.erfoip.kanibar setSetting reminderTime '"19:30"'
    // The value is JSON (true, 20, "19:30").
    function setSetting(key: string, value: string): void {
      if (!Model.ipcSettingAllowed(key)) return
      var parsed
      try { parsed = JSON.parse(value) } catch (e) { parsed = value }
      root.persistSetting(key, parsed)
    }
  }

  // Keeps relative times in the open popup current.
  Timer {
    interval: Model.CLOCK_TICK_MS
    running: root.opened
    repeat: true
    onTriggered: root.now = Date.now()
  }

  visible: !(hideWhenIdle && idle)
  implicitWidth: visible ? button.implicitWidth : 0
  implicitHeight: visible ? button.implicitHeight : 0
  readonly property real openPanelIndicatorWidth: pill.implicitWidth
  readonly property real openPanelIndicatorHeight: pill.implicitHeight

  readonly property bool barVertical: root.bar ? root.bar.vertical === true : false
  readonly property color contentForeground: root.bar ? root.bar.foreground : Commons.Color.foreground
  readonly property string contentFontFamily: root.bar ? root.bar.fontFamily : Style.font.family

  // ---------- Bar pill ----------
  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    labelVisible: false
    hasVisualContent: true
    active: root.highlightThreshold > 0 && root.reviews >= root.highlightThreshold
    fixedWidth: root.barVertical ? -1 : pill.implicitWidth + Style.space(12)
    fixedHeight: root.barVertical ? pill.implicitHeight + Style.space(8) : -1
    tooltipText: ""

    onPressed: function(mouseButton) {
      if (mouseButton === Qt.MiddleButton) root.refresh()
      else if (mouseButton === Qt.RightButton) root.openUrl(Model.DASHBOARD_URL)
      else root.toggle()
    }

    BarPill {
      id: pill
      anchors.centerIn: parent
      vertical: root.barVertical
      parts: root.pillParts
      // WidgetButton's `active` only recolors its own label, which is hidden
      // here, so the pill takes the urgent color itself.
      foreground: button.active ? button.activeColor : button.foreground
      fontFamily: button.fontFamily
    }
  }

  // ---------- Popup ----------
  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    // The token field takes focus whenever it's showing, so pasting works
    // straight away.
    focusTarget: panel.loadedContent && root.showTokenEntry ? panel.loadedContent.tokenInput : panel.loadedContent
    contentWidth: panel.fittedContentWidth(Style.space(340))
    contentHeight: panel.fittedContentHeight(panel.loadedContentHeight)

    content: PanelKeyCatcher {
      id: body
      property alias tokenInput: tokenEntry.input
      anchors.fill: parent
      blocked: (root.showTokenEntry && tokenEntry.input.activeFocus) || settingsPage.typing
      implicitHeight: column.implicitHeight
      onCloseRequested: {
        if (root.inSettings) root.view = "main"
        else root.close()
      }
      onTabRequested: function(direction) { root.switchPanel(direction) }

      readonly property color fg: root.contentForeground
      readonly property string family: root.contentFontFamily

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(14)

        PanelHero {
          foreground: body.fg
          fontFamily: body.family
          title: root.inSettings ? strings.t("hero.settingsTitle") : strings.t("hero.title")
          trailingControl: PanelActionButton {
            // Also while a Disconnect is unfinished: its retry is on the
            // settings page.
            visible: root.hasToken || root.inSettings || root.disconnectIncomplete
            // Back points the reading direction's way: left, or right in RTL.
            iconText: root.inSettings ? (Commons.I18n.rightToLeft ? "󰁔" : "󰁍") : "󰒓"
            tooltipText: root.inSettings ? strings.t("action.back") : strings.t("action.settings")
            foreground: body.fg
            fontFamily: body.family
            onClicked: root.view = root.inSettings ? "main" : "settings"
          }
          // PanelHero renders meta as PlainText (and upper-cases it).
          meta: {
            if (root.inSettings) return strings.t("hero.settingsMeta")
            if (!root.hasToken) return strings.t("hero.notConnected")
            if (!root.user) return strings.t("hero.loading")
            var level = strings.formatNumber(root.user.level)
            return root.user.username
              ? Model.fill(strings.t("hero.levelUser"), level, root.user.username)
              : Model.fill(strings.t("hero.level"), level)
          }
          iconComponent: PlainText {
            text: Model.ICON_GLYPH
            foreground: Commons.Color.accent
            font.pixelSize: Style.font.display
          }
        }

        SettingsPage {
          id: settingsPage
          visible: root.inSettings
          width: parent.width
          l10n: strings
          foreground: body.fg
          fontFamily: body.family
          showLessons: root.showLessons
          hideWhenIdle: root.hideWhenIdle
          highlightThreshold: root.highlightThreshold
          refreshMinutes: root.refreshMinutes
          reminderEnabled: root.reminderEnabled
          reminderTime: root.reminderTime
          reminderMinReviews: root.reminderMinReviews
          reminderSentToday: root.ready && root.reminder.lastDate === Model.dateKey(root.now)
          // Account details only while a token is active.
          username: root.hasToken && root.user ? root.user.username : ""
          level: root.hasToken && root.user ? root.user.level : 0
          hasToken: root.hasToken
          hasStoredToken: root.hasToken
          disconnectIncomplete: root.disconnectIncomplete
          onSettingChanged: function(key, value) { root.persistSetting(key, value) }
          onTestNotificationRequested: if (root.ready) root.reminder.send(root.reviews, root.lessons)
          onChangeTokenRequested: root.startTokenChange()
          accountError: root.ready ? root.tokenSession.accountError : null
          onDisconnectRequested: if (root.ready) root.tokenSession.disconnect()
          onEditingDone: body.forceActiveFocus()
        }

        TokenEntry {
          id: tokenEntry
          visible: !root.inSettings && root.showTokenEntry
          width: parent.width
          l10n: strings
          foreground: body.fg
          fontFamily: body.family
          busy: root.ready && root.tokenSession.busy
          rejected: root.tokenRejected
          malformed: root.tokenMalformed
          editing: root.ready && root.tokenSession.editing
          canCancel: !root.ready || root.tokenSession.canCancel
          clearCount: root.ready ? root.tokenSession.clearCount : 0
          error: root.ready ? root.tokenSession.error : null
          keyringAvailable: root.keyringAvailable
          onSubmitted: function(token) { if (root.ready) root.tokenSession.submit(token) }
          onEdited: if (root.ready) root.tokenSession.clearError()
          onCancelRequested: if (root.ready) root.tokenSession.cancel()
          onDismissRequested: root.close()
          onGetTokenRequested: root.openUrl(Model.TOKEN_URL)
        }

        // ---------- Request error ----------
        PlainText {
          width: parent.width
          visible: root.showMain && root.error !== null
          wrapMode: Text.WordWrap
          text: strings.message(root.error)
          foreground: Commons.Color.urgent
          fontFamily: body.family
        }

        CountTiles {
          visible: root.showMain && root.summary !== null
          width: parent.width
          l10n: strings
          foreground: body.fg
          fontFamily: body.family
          reviews: root.reviews
          lessons: root.lessons
          reviewsDone: root.reviewsDone
          nextReviewsText: root.summary && root.summary.nextReviewsAt !== null
            ? strings.durationText(root.summary.nextReviewsAt, root.now)
            : ""
          onReviewsActivated: root.openUrl(Model.REVIEW_URL)
          onLessonsActivated: root.openUrl(Model.LESSON_URL)
        }

        LevelProgress {
          visible: root.showMain && root.levelInfo !== null
          width: parent.width
          l10n: strings
          foreground: body.fg
          fontFamily: body.family
          info: root.levelInfo
        }

        SrsBreakdown {
          visible: root.showMain && root.srsCounts !== null
          width: parent.width
          l10n: strings
          foreground: body.fg
          fontFamily: body.family
          groups: root.srsCounts || []
        }

        ReviewForecast {
          visible: root.showMain && root.summary !== null
          width: parent.width
          l10n: strings
          foreground: body.fg
          fontFamily: body.family
          slots: root.summary ? Model.hourlySlots(root.summary.forecast, root.now, Model.FORECAST_HOURS) : []
          total: root.summary ? root.summary.forecastTotal : 0
        }

        // ---------- Footer ----------
        Item {
          visible: root.showMain && root.hasToken
          width: parent.width
          implicitHeight: updatedText.implicitHeight

          CaptionText {
            id: updatedText
            anchors.right: parent.right
            visible: root.lastUpdated > 0
            text: Model.fill(root.loading ? strings.t("footer.refreshing") : strings.t("footer.updated"), strings.timeText(root.lastUpdated))
            foreground: body.fg
            fontFamily: body.family
          }
        }
      }
    }
  }
}
